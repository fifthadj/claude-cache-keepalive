import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideInject, regimeParams, REGIME_PARAMS,
  encodeProjectDir, transcriptIdleMs, transcriptPath,
  readTtlRegime, detectTtlRegime, looksLikeTrustPrompt,
} from '../src/keepalive.mjs';

const NOW = 1_000_000_000_000;
const LONG = regimeParams('long'); // { ttl:3600, idleThreshold:3480 }
const SHORT = regimeParams('short'); // { ttl:300,  idleThreshold:240 }
const ms = (s) => s * 1000;

// ---- regimeParams ----
test('regime params are the documented defaults', () => {
  assert.deepEqual(LONG, { ttl: 3600, idleThreshold: 3480 });
  assert.deepEqual(SHORT, { ttl: 300, idleThreshold: 240 });
  assert.deepEqual(regimeParams('unknown'), SHORT, 'unknown regime falls back to short (conservative)');
  assert.deepEqual(regimeParams(null), SHORT, 'null regime falls back to short');
});

test('overrides win', () => {
  assert.deepEqual(regimeParams('long', { ttl: 60, idleThreshold: 60 }), { ttl: 60, idleThreshold: 60 });
});

test('REGIME_PARAMS export is intact', () => {
  assert.equal(REGIME_PARAMS.long.ttl, 3600);
  assert.equal(REGIME_PARAMS.short.idleThreshold, 240);
});

// ---- decideInject (unchanged) ----
test('long: injects when transcript idle past threshold and cooldown clear', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: false }), true);
});

test('disabled blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: true }), false);
});

test('unknown transcript idle (null) blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: null, lastFire: 0, ...LONG, disabled: false }), false);
});

test('idle below threshold blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(10), lastFire: 0, ...LONG, disabled: false }), false);
});

test('cooldown blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: NOW - ms(100), ...LONG, disabled: false }), false);
});

test('injects again after cooldown passes', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: NOW - ms(3700), ...LONG, disabled: false }), true);
});

test('short: idle 250s injects, 200s does not', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(250), lastFire: 0, ...SHORT, disabled: false }), true);
  assert.equal(decideInject({ now: NOW, idleMs: ms(200), lastFire: 0, ...SHORT, disabled: false }), false);
});

// ---- decideInject: screen-quiescence gate ----
// Only inject when the PTY has been silent a while: an animating prompt (awaiting a
// mandatory answer) and a busy tool-run both keep emitting output, so the gate stays shut
// there; a settled idle input box is quiet, so it opens. quietMs omitted => gate not applied.
const QUIET = 2500;

test('screen still active (animating prompt / busy / typing) blocks injection', () => {
  assert.equal(
    decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: false, screenIdleMs: 200, quietMs: QUIET }),
    false,
  );
});

test('screen quiet long enough allows injection', () => {
  assert.equal(
    decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: false, screenIdleMs: ms(5), quietMs: QUIET }),
    true,
  );
});

test('screen idle exactly at the quiet threshold allows injection (>=)', () => {
  assert.equal(
    decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: false, screenIdleMs: QUIET, quietMs: QUIET }),
    true,
  );
});

test('quiescence gate is opt-in: omitting quietMs keeps the pure idle decision', () => {
  assert.equal(
    decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: false, screenIdleMs: 0 }),
    true,
  );
});

test('quiescence does not override the other gates (idle below threshold still blocks)', () => {
  assert.equal(
    decideInject({ now: NOW, idleMs: ms(10), lastFire: 0, ...LONG, disabled: false, screenIdleMs: ms(60), quietMs: QUIET }),
    false,
  );
});

// ---- looksLikeTrustPrompt (guards the folder-trust dialog from the Esc injection) ----
test('trust prompt: matches the plain Claude Code wording', () => {
  assert.equal(looksLikeTrustPrompt('Do you trust the files in this folder?'), true);
  assert.equal(looksLikeTrustPrompt('Do you trust the files in this workspace?'), true);
});

test('trust prompt: matches even with ANSI color/box-drawing around the phrase', () => {
  const screen =
    '\x1b[2J\x1b[H\x1b[1m\x1b[38;5;208m╭─ Do you trust\x1b[0m the files in this folder? ─╮\r\n' +
    '\x1b[2m1. Yes, proceed\x1b[0m\r\n2. No, exit';
  assert.equal(looksLikeTrustPrompt(screen), true);
});

test('trust prompt: tolerates whitespace/newlines split across the phrase', () => {
  assert.equal(looksLikeTrustPrompt('trust   the\r\n  files in this   folder'), true);
});

test('trust prompt: false for an ordinary idle input box / other prompts', () => {
  assert.equal(looksLikeTrustPrompt('> \x1b[7m \x1b[0m  esc to interrupt'), false);
  assert.equal(looksLikeTrustPrompt('Allow this tool to run? 1. Yes 2. No'), false);
  assert.equal(looksLikeTrustPrompt(''), false);
  assert.equal(looksLikeTrustPrompt(null), false);
  assert.equal(looksLikeTrustPrompt(undefined), false);
});

// ---- encode / transcript path + idle ----
test('encodeProjectDir mirrors Claude Code path encoding', () => {
  assert.equal(encodeProjectDir('C:\\temp\\scripts\\cwarm'), 'C--temp-scripts-cwarm');
  assert.equal(encodeProjectDir('/home/u/proj'), '-home-u-proj');
});

test('transcript idle: reads newest .jsonl mtime for the cwd project dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-t-'));
  const cwd = 'C:\\proj\\x';
  const pdir = path.join(dir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  const f = path.join(pdir, 's.jsonl');
  fs.writeFileSync(f, '{}\n');
  const t = new Date(NOW - ms(250));
  fs.utimesSync(f, t, t);
  const idle = transcriptIdleMs(dir, cwd, NOW);
  assert.ok(Math.abs(idle - ms(250)) < 2000, `expected idle ~250s, got ${idle}ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcript idle: null when no transcript exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-t-'));
  assert.equal(transcriptIdleMs(dir, 'C:\\nope', NOW), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcript idle: falls back to global newest when cwd dir is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-t-'));
  const other = path.join(dir, 'projects', 'some-other-proj');
  fs.mkdirSync(other, { recursive: true });
  const f = path.join(other, 's.jsonl');
  fs.writeFileSync(f, '{}\n');
  const t = new Date(NOW - ms(300));
  fs.utimesSync(f, t, t);
  const idle = transcriptIdleMs(dir, 'C:\\unmatched\\cwd', NOW);
  assert.ok(Math.abs(idle - ms(300)) < 2000, `expected fallback idle ~300s, got ${idle}ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- readTtlRegime / detectTtlRegime ----
function asst(cc) {
  return JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: cc } } });
}

test('readTtlRegime: returns null when path missing', () => {
  assert.equal(readTtlRegime(null), null);
  assert.equal(readTtlRegime(path.join(os.tmpdir(), 'cwarm-nope-' + Date.now() + '.jsonl')), null);
});

test('readTtlRegime: any recent 1h write -> long', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-r-')), 't.jsonl');
  fs.writeFileSync(f, [
    asst({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 24399 }),
    asst({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 882 }),
  ].join('\n') + '\n');
  assert.equal(readTtlRegime(f), 'long');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('readTtlRegime: only 5m writes -> short', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-r-')), 't.jsonl');
  fs.writeFileSync(f, [
    asst({ ephemeral_5m_input_tokens: 1200, ephemeral_1h_input_tokens: 0 }),
    asst({ ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 }),
  ].join('\n') + '\n');
  assert.equal(readTtlRegime(f), 'short');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('readTtlRegime: a recent 5m-only turn does not mask an older 1h write (false-5m guard)', () => {
  // newest turn re-wrote only a small 5m suffix while the 1h prefix was a cache hit (1h=0 that turn)
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-r-')), 't.jsonl');
  fs.writeFileSync(f, [
    asst({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 24000 }), // older: real 1h prefix
    asst({ ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 0 }),   // newest: tiny 5m suffix only
  ].join('\n') + '\n');
  assert.equal(readTtlRegime(f), 'long', 'scanning back a few turns still finds the 1h write');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('readTtlRegime: no cache_creation evidence -> null', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-r-')), 't.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    asst({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }),
    'not-json-garbage',
  ].join('\n') + '\n');
  assert.equal(readTtlRegime(f), null);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('detectTtlRegime: locates the cwd transcript and reads its regime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-d-'));
  const cwd = 'C:\\proj\\y';
  const pdir = path.join(dir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 's.jsonl'),
    asst({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 }) + '\n');
  assert.equal(detectTtlRegime(dir, cwd), 'long');
  assert.equal(typeof transcriptPath(dir, cwd), 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});
