import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideInject, planParams, PLAN_PARAMS,
  encodeProjectDir, transcriptIdleMs,
} from '../src/keepalive.mjs';

const NOW = 1_000_000_000_000;
const MAX = planParams('max'); // { ttl:3600, idleThreshold:3480 }
const PRO = planParams('pro'); // { ttl:300,  idleThreshold:240 }
const ms = (s) => s * 1000;

test('plan params are the documented defaults', () => {
  assert.deepEqual(MAX, { ttl: 3600, idleThreshold: 3480 });
  assert.deepEqual(PRO, { ttl: 300, idleThreshold: 240 });
  assert.deepEqual(planParams('unknown'), PRO, 'unknown plan falls back to pro');
});

test('overrides win', () => {
  assert.deepEqual(planParams('max', { ttl: 60, idleThreshold: 60 }), { ttl: 60, idleThreshold: 60 });
});

test('max: injects when transcript idle past threshold and cooldown clear', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...MAX, disabled: false }), true);
});

test('disabled blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: 0, ...MAX, disabled: true }), false);
});

test('unknown transcript idle (null) blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: null, lastFire: 0, ...MAX, disabled: false }), false);
});

test('idle below threshold blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(10), lastFire: 0, ...MAX, disabled: false }), false);
});

test('cooldown blocks injection', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: NOW - ms(100), ...MAX, disabled: false }), false);
});

test('injects again after cooldown passes', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(3500), lastFire: NOW - ms(3700), ...MAX, disabled: false }), true);
});

test('pro: idle 250s injects, 200s does not', () => {
  assert.equal(decideInject({ now: NOW, idleMs: ms(250), lastFire: 0, ...PRO, disabled: false }), true);
  assert.equal(decideInject({ now: NOW, idleMs: ms(200), lastFire: 0, ...PRO, disabled: false }), false);
});

test('PLAN_PARAMS export is intact', () => {
  assert.equal(PLAN_PARAMS.max.ttl, 3600);
  assert.equal(PLAN_PARAMS.pro.idleThreshold, 240);
});

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
