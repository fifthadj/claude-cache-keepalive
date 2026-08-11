import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideInject, regimeParams, REGIME_PARAMS,
  encodeProjectDir, cwdKey, transcriptIdleMs, transcriptPath,
  readTtlRegime, detectTtlRegime, looksLikeTrustPrompt,
  billingModeFromSources, detectBillingMode,
  accountInfoFromSources, detectAccountInfo,
  usageState, readUsageBridge, usageBridgePath,
  looksLikeHumanInput, pickInjectMsg, aiPacing, weeklyGate, readAiMsgFile,
  aiStatePath, readAiState, extractAiToggle, clampHumanQuiet, readAuthSources, toggleKeySpec,
  initialAiEnabled, sessionBridgePath, readSessionTranscript, transcriptIdleMsAt,
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

// ---- billing mode (subscription keeps keepalive; credits/API suspends it) ----
test('billing: subscription tiers in credentials -> subscription', () => {
  for (const sub of ['pro', 'max', 'team', 'enterprise', 'max_5x']) {
    assert.equal(billingModeFromSources({ credentials: { claudeAiOauth: { subscriptionType: sub } } }), 'subscription', sub);
  }
});

test('billing: oauth login without a subscription tier -> credits (console account)', () => {
  assert.equal(billingModeFromSources({ credentials: { claudeAiOauth: { subscriptionType: null } } }), 'credits');
  assert.equal(billingModeFromSources({ credentials: { claudeAiOauth: {} } }), 'credits');
  assert.equal(billingModeFromSources({ credentials: { claudeAiOauth: { subscriptionType: 'none' } } }), 'credits');
});

test('billing: credentials outrank config (login rewrites credentials first)', () => {
  assert.equal(billingModeFromSources({
    credentials: { claudeAiOauth: { subscriptionType: 'pro' } },
    config: { oauthAccount: { billingType: 'prepaid' } },
  }), 'subscription');
});

test('billing: config billingType fallback when no credentials file (e.g. macOS keychain)', () => {
  assert.equal(billingModeFromSources({ config: { oauthAccount: { billingType: 'stripe_subscription' } } }), 'subscription');
  assert.equal(billingModeFromSources({ config: { oauthAccount: { billingType: 'prepaid' } } }), 'credits');
});

test('billing: ANTHROPIC_API_KEY alone -> credits; unknown -> null (keepalive stays on)', () => {
  assert.equal(billingModeFromSources({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' } }), 'credits');
  assert.equal(billingModeFromSources({}), null);
  assert.equal(billingModeFromSources({ credentials: {}, config: {} }), null);
});

test('billing: CWARM_BILLING override wins over everything', () => {
  assert.equal(billingModeFromSources({
    env: { CWARM_BILLING: 'subscription', ANTHROPIC_API_KEY: 'sk' },
    credentials: { claudeAiOauth: { subscriptionType: null } },
  }), 'subscription');
  assert.equal(billingModeFromSources({
    env: { CWARM_BILLING: 'credits' },
    credentials: { claudeAiOauth: { subscriptionType: 'max' } },
  }), 'credits');
});

test('detectBillingMode: reads .credentials.json under claudeDir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-b-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } }));
  assert.equal(detectBillingMode(dir, { env: {}, homedir: dir }), 'subscription');
  fs.writeFileSync(path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { subscriptionType: null } }));
  assert.equal(detectBillingMode(dir, { env: {}, homedir: dir }), 'credits');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- usage window state (95% 提醒 / 撞牆 / reset) ----
test('usageState: thresholds and transitions', () => {
  const t0 = 1_000_000; // resets_at
  // normal：低用量
  assert.equal(usageState({ usedPct: 50, resetsAt: t0, nowSec: t0 - 3 * 3600 }), 'normal');
  // warn：≥95% 且離 reset 超過 1h
  assert.equal(usageState({ usedPct: 95, resetsAt: t0, nowSec: t0 - 3 * 3600 }), 'warn');
  assert.equal(usageState({ usedPct: 96, resetsAt: t0, nowSec: t0 - 3700 }), 'warn');
  // ≥95% 但離 reset 不滿 1h → 照常跑到撞牆（normal）
  assert.equal(usageState({ usedPct: 96, resetsAt: t0, nowSec: t0 - 1800 }), 'normal');
  // limited：撞牆
  assert.equal(usageState({ usedPct: 99, resetsAt: t0, nowSec: t0 - 3600 }), 'limited');
  assert.equal(usageState({ usedPct: 100, resetsAt: t0, nowSec: t0 - 3 * 3600 }), 'limited');
  // reset：resets_at 已過
  assert.equal(usageState({ usedPct: 100, resetsAt: t0, nowSec: t0 + 1 }), 'reset');
  // unknown：缺資料
  assert.equal(usageState({ usedPct: null, resetsAt: t0, nowSec: t0 }), 'unknown');
  assert.equal(usageState({ usedPct: 50, resetsAt: null, nowSec: t0 }), 'unknown');
});

test('usageState: custom thresholds via opts', () => {
  const t0 = 1_000_000;
  assert.equal(usageState({ usedPct: 80, resetsAt: t0, nowSec: t0 - 3 * 3600 }, { warnPct: 80 }), 'warn');
  assert.equal(usageState({ usedPct: 95, resetsAt: t0, nowSec: t0 - 3 * 3600 }, { limitPct: 95 }), 'limited');
});

test('weeklyGate: pro-rata pacing line with one-day grace', () => {
  const WEEK = 7 * 86400;
  const t0 = 2_000_000_000; // week resets_at
  const midWeek = t0 - WEEK / 2; // 進度線 = 50%，日均 ≈ 14.29%
  assert.equal(weeklyGate({ usedPct: 40, resetsAt: t0, nowSec: midWeek }), 'ok', 'under the line');
  assert.equal(weeklyGate({ usedPct: 55, resetsAt: t0, nowSec: midWeek }), 'slow', 'over line, within a daily budget');
  assert.equal(weeklyGate({ usedPct: 65, resetsAt: t0, nowSec: midWeek }), 'off', 'over line by ≥ one daily budget');
  // 開窗初期：進度線趨近 0，任何用量都算超前
  assert.equal(weeklyGate({ usedPct: 20, resetsAt: t0, nowSec: t0 - WEEK + 60 }), 'off');
  assert.equal(weeklyGate({ usedPct: 0, resetsAt: t0, nowSec: t0 - WEEK + 60 }), 'ok');
  // 缺資料 → unknown
  assert.equal(weeklyGate({ usedPct: null, resetsAt: t0, nowSec: midWeek }), 'unknown');
  assert.equal(weeklyGate({ usedPct: 50, resetsAt: null, nowSec: midWeek }), 'unknown');
});

test('aiPacing: weekly slow/off blocks fast pace, ok/unknown allows it', () => {
  const base = { consecInjects: 3, usedPct: 30, ustate: 'normal', ttl: 3600, idleThreshold: 3480 };
  assert.equal(aiPacing({ ...base, weekly: 'ok' }).ttl, 300);
  assert.equal(aiPacing({ ...base, weekly: 'unknown' }).ttl, 300);
  assert.equal(aiPacing({ ...base, weekly: 'slow' }).ttl, 3600);
  assert.equal(aiPacing({ ...base, weekly: 'off' }).ttl, 3600);
});

test('aiPacing: enabled=false (no --ai) never fast-paces', () => {
  const base = { consecInjects: 5, usedPct: 10, ustate: 'normal', weekly: 'ok', ttl: 3600, idleThreshold: 3480 };
  assert.equal(aiPacing({ ...base, enabled: false }).ttl, 3600);
  assert.equal(aiPacing({ ...base, enabled: true }).ttl, 300);
});

test('readAiMsgFile: one instruction per line, skips blanks and # comments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-m-'));
  const f = path.join(dir, 'cycle.txt');
  fs.writeFileSync(f, '# my writing cycle\n\nproofread the draft\n  polish chapter flow  \n# done\n');
  assert.deepEqual(readAiMsgFile(f), ['proofread the draft', 'polish chapter flow']);
  fs.writeFileSync(f, '# only comments\n\n');
  assert.equal(readAiMsgFile(f), null, 'no usable lines → null (fall back to built-in)');
  assert.equal(readAiMsgFile(path.join(dir, 'missing.txt')), null);
  assert.equal(readAiMsgFile(null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readAiMsgFile: strips a leading UTF-8 BOM (Windows Notepad) before comment detection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-mb-'));
  const f = path.join(dir, 'cycle.txt');
  fs.writeFileSync(f, '﻿# my cycle\nfirst step\nsecond step\n');
  assert.deepEqual(readAiMsgFile(f), ['first step', 'second step'], 'BOM+# first line still treated as a comment');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('initialAiEnabled: flag > env (0 forces off) > persisted > default off', () => {
  assert.equal(initialAiEnabled({ flagAi: true, envAi: '0', persisted: { enabled: false } }), true, '--ai wins');
  assert.equal(initialAiEnabled({ envAi: '1', persisted: { enabled: false } }), true);
  assert.equal(initialAiEnabled({ envAi: '0', persisted: { enabled: true } }), false, 'CWARM_AI=0 forces off over persisted on');
  assert.equal(initialAiEnabled({ envAi: 'off', persisted: { enabled: true } }), false);
  assert.equal(initialAiEnabled({ persisted: { enabled: true } }), true, 'persisted survives restart');
  assert.equal(initialAiEnabled({ persisted: { enabled: false } }), false);
  assert.equal(initialAiEnabled({}), false, 'default off');
  assert.equal(initialAiEnabled({ persisted: null }), false);
});

test('readAiState: maxAgeMs Infinity reads stale files (persistence path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-p-'));
  const cwd = 'C:\\proj\\a';
  fs.writeFileSync(aiStatePath(dir, cwd), JSON.stringify({ enabled: true, ts: Date.now() - 86_400_000 }));
  assert.equal(readAiState(dir, cwd), null, 'heartbeat read: a day old → stale');
  assert.deepEqual(readAiState(dir, cwd, { maxAgeMs: Infinity }), { enabled: true, key: null }, 'persistence read ignores age');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readAiState: per-cwd file, fresh heartbeat returns flag, stale/missing → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-s-'));
  const cwdA = 'C:\\proj\\a', cwdB = 'C:\\proj\\b';
  const now = Date.now();
  fs.writeFileSync(aiStatePath(dir, cwdA), JSON.stringify({ enabled: true, ts: now }));
  fs.writeFileSync(aiStatePath(dir, cwdB), JSON.stringify({ enabled: false, ts: now }));
  // 兩個 host 並行各寫各的，互不覆蓋（key 未寫時為 null，host 會寫入熱鍵標籤）
  assert.deepEqual(readAiState(dir, cwdA, { now }), { enabled: true, key: null });
  assert.deepEqual(readAiState(dir, cwdB, { now }), { enabled: false, key: null });
  // 心跳過舊（host 已退出）→ null，statusline 不顯示殘留狀態
  assert.equal(readAiState(dir, cwdA, { now: now + 61_000 }), null);
  assert.equal(readAiState(dir, 'C:\\proj\\none', { now }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pickInjectMsg: aiAllowed=false suppresses AI mode back to plain hi', () => {
  const m = { pendingResume: false, resumeMsg: 'go on', aiMsg: ['a', 'b'], msg: 'hi' };
  assert.equal(pickInjectMsg({ ...m, consecInjects: 4, aiAllowed: false }), 'hi');
  assert.equal(pickInjectMsg({ ...m, consecInjects: 4, aiAllowed: true }), 'a');
  assert.equal(pickInjectMsg({ ...m, consecInjects: 4, pendingResume: true, aiAllowed: false }), 'go on', 'resume still wins');
});

test('readUsageBridge: reads fresh file, rejects stale or missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-u-'));
  const cwd = 'C:\\proj\\u';
  const now = Date.now();
  fs.writeFileSync(usageBridgePath(dir, cwd), JSON.stringify({ used_percentage: 97, resets_at: 123, ts: now }));
  assert.deepEqual(readUsageBridge(dir, cwd, { now }), { usedPct: 97, resetsAt: 123, weekPct: null, weekResetsAt: null });
  fs.writeFileSync(usageBridgePath(dir, cwd), JSON.stringify({
    used_percentage: 50, resets_at: 123, seven_day: { used_percentage: 33, resets_at: 456 }, ts: now,
  }));
  assert.deepEqual(readUsageBridge(dir, cwd, { now }), { usedPct: 50, resetsAt: 123, weekPct: 33, weekResetsAt: 456 });
  // 太舊（statusline 停更）→ null
  assert.equal(readUsageBridge(dir, cwd, { now: now + 601_000 }), null);
  // 檔案不存在 → null
  assert.equal(readUsageBridge(fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-u2-')), cwd, { now }), null);
  // 不同 cwd 各寫各的橋接檔，不互相覆蓋（曾經全域共用一份，A 帳號會讀到 B 帳號的用量）
  const cwd2 = 'C:\\proj\\v';
  fs.writeFileSync(usageBridgePath(dir, cwd2), JSON.stringify({ used_percentage: 10, resets_at: 999, ts: now }));
  assert.equal(readUsageBridge(dir, cwd, { now }).usedPct, 50, 'cwd unaffected by cwd2 write');
  assert.equal(readUsageBridge(dir, cwd2, { now }).usedPct, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- human typing guard ----
test('human keystroke within humanQuietMs blocks injection; after it, allows', () => {
  const base = { now: NOW, idleMs: ms(3500), lastFire: 0, ...LONG, disabled: false };
  assert.equal(decideInject({ ...base, humanIdleMs: ms(10), humanQuietMs: ms(300) }), false, 'typed 10s ago');
  assert.equal(decideInject({ ...base, humanIdleMs: ms(299), humanQuietMs: ms(300) }), false, 'still within quiet window');
  assert.equal(decideInject({ ...base, humanIdleMs: ms(301), humanQuietMs: ms(300) }), true, 'quiet window passed');
  assert.equal(decideInject({ ...base, humanIdleMs: null, humanQuietMs: ms(300) }), true, 'no human signal → not applied');
  assert.equal(decideInject({ ...base, humanIdleMs: ms(10), humanQuietMs: null }), true, 'guard disabled');
});

// ---- 無人值守 AI 模式 ----
test('looksLikeHumanInput: typing counts, terminal auto-replies (ESC-first) do not', () => {
  assert.equal(looksLikeHumanInput(Buffer.from('a')), true);
  assert.equal(looksLikeHumanInput(Buffer.from('\r')), true);
  assert.equal(looksLikeHumanInput('hello'), true);
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[6;1R')), false, 'DSR cursor report');
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[A')), false, 'arrow key is sacrificed by design');
  assert.equal(looksLikeHumanInput(Buffer.alloc(0)), false);
  assert.equal(looksLikeHumanInput(null), false);
});

test('looksLikeHumanInput: win32-input-mode packets — keydown with a char is human', () => {
  // Windows 上 node-pty 開 ?9001h：按 'a' → ESC[65;30;97;1;0;1_（Vk;Sc;Uc;Kd;Cs;Rc）
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[65;30;97;1;0;1_')), true, "keydown 'a'");
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[13;28;13;1;0;1_')), true, 'keydown Enter');
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[65;30;97;0;0;1_')), false, 'keyup only');
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[16;42;0;1;16;1_')), false, 'Shift down alone (Uc=0)');
  // keyup + keydown 併在同一 chunk：有 keydown 即是人
  assert.equal(looksLikeHumanInput(Buffer.from('\x1b[65;30;97;0;0;1_\x1b[66;48;98;1;0;1_')), true);
});

test('toggleKeySpec: default Ctrl+\\, rebindable, invalid falls back', () => {
  assert.deepEqual(toggleKeySpec(undefined), { code: 0x1c, label: 'Ctrl+\\' });
  assert.deepEqual(toggleKeySpec(']'), { code: 0x1d, label: 'Ctrl+]' });
  assert.deepEqual(toggleKeySpec('g'), { code: 0x07, label: 'Ctrl+G' });
  assert.deepEqual(toggleKeySpec(''), { code: 0x1c, label: 'Ctrl+\\' });
  assert.deepEqual(toggleKeySpec(' '), { code: 0x1c, label: 'Ctrl+\\' }, 'space maps to 0 → invalid → default');
});

test('extractAiToggle: bare control byte only as a lone single-byte chunk', () => {
  const lone = extractAiToggle(Buffer.from([0x1c])); // 預設 Ctrl+\
  assert.equal(lone.toggled, true);
  assert.equal(lone.rest.length, 0);
  // 自訂 code：Ctrl+]（0x1D）
  assert.equal(extractAiToggle(Buffer.from([0x1d]), 0x1d).toggled, true);
  assert.equal(extractAiToggle(Buffer.from([0x1d])).toggled, false, 'non-configured byte is not the hotkey');
  // 貼上內容夾帶 FS/GS：不得誤觸、不得剝除（透明轉送不變形）
  const paste = Buffer.from('field1\x1cfield2\x1dfield3');
  const r = extractAiToggle(paste);
  assert.equal(r.toggled, false);
  assert.deepEqual(r.rest, paste, 'paste passes through byte-identical');
});

test('extractAiToggle: win32-input-mode hotkey packets toggle and are stripped', () => {
  // Ctrl+\ → Vk=220(0xDC)、Uc=28、Cs=8(ctrl)；down 觸發、up 一併吞掉
  const down = '\x1b[220;43;28;1;8;1_';
  const up = '\x1b[220;43;28;0;8;1_';
  let r = extractAiToggle(Buffer.from(down));
  assert.equal(r.toggled, true);
  assert.equal(r.rest.length, 0);
  r = extractAiToggle(Buffer.from(down + up));
  assert.equal(r.toggled, true);
  assert.equal(r.rest.length, 0, 'both down and up stripped');
  r = extractAiToggle(Buffer.from(up));
  assert.equal(r.toggled, false, 'keyup alone does not toggle');
  assert.equal(r.rest.length, 0, 'but is still swallowed');
  // 同 chunk 夾著別的按鍵封包（如批次貼上）：不算單鍵熱鍵，整包原樣放行、不剝除也不觸發，
  // 避免貼上內容剛好含熱鍵字元時被誤觸且毀損。
  const other = '\x1b[65;30;97;1;0;1_';
  r = extractAiToggle(Buffer.from(down + other));
  assert.equal(r.toggled, false, 'mixed with another key packet is not a lone hotkey press');
  assert.equal(r.rest.toString('latin1'), down + other, 'passes through untouched, byte-identical');
  // 自訂 code 時預設鍵的封包不觸發
  r = extractAiToggle(Buffer.from(down), 0x1d);
  assert.equal(r.toggled, false);
  assert.equal(r.rest.toString('latin1'), down, 'non-hotkey packet passes through');
  // 非純封包串（一般 ESC 序列 / 混合內容）原樣放行
  const dsr = Buffer.from('\x1b[6;1R');
  r = extractAiToggle(dsr);
  assert.equal(r.toggled, false);
  assert.deepEqual(r.rest, dsr);
});

test('clampHumanQuiet: keeps the early-fire margin of each regime', () => {
  assert.equal(clampHumanQuiet(300_000, 240), 180_000, 'short: clamped to idleThreshold-60s');
  assert.equal(clampHumanQuiet(300_000, 3480), 300_000, 'long: 300s fits, unchanged');
  assert.equal(clampHumanQuiet(300_000, 30), 0, 'tiny threshold → guard disabled (0)');
  assert.equal(clampHumanQuiet(0, 240), 0, 'user-disabled stays disabled');
});

test('pickInjectMsg: resume > ai(consec>=2) > plain hi', () => {
  const m = { resumeMsg: 'go on', aiMsg: 'AI', msg: 'hi' };
  assert.equal(pickInjectMsg({ pendingResume: true, consecInjects: 5, ...m }), 'go on', 'resume wins even in ai mode');
  assert.equal(pickInjectMsg({ pendingResume: false, consecInjects: 0, ...m }), 'hi');
  assert.equal(pickInjectMsg({ pendingResume: false, consecInjects: 1, ...m }), 'hi', 'second inject is still hi');
  assert.equal(pickInjectMsg({ pendingResume: false, consecInjects: 2, ...m }), 'AI', 'third inject switches to ai');
  assert.equal(pickInjectMsg({ pendingResume: false, consecInjects: 7, ...m }), 'AI');
});

test('pickInjectMsg: array aiMsg cycles the unattended workflow in order via aiStep', () => {
  const cycle = ['review', 'critical', 'suggest', 'execute'];
  const m = { pendingResume: false, resumeMsg: 'go on', aiMsg: cycle, msg: 'hi', consecInjects: 5 };
  assert.equal(pickInjectMsg({ ...m, aiStep: 0 }), 'review');
  assert.equal(pickInjectMsg({ ...m, aiStep: 1 }), 'critical');
  assert.equal(pickInjectMsg({ ...m, aiStep: 2 }), 'suggest');
  assert.equal(pickInjectMsg({ ...m, aiStep: 3 }), 'execute');
  assert.equal(pickInjectMsg({ ...m, aiStep: 4 }), 'review', 'wraps around');
  // aiStep 與 consecInjects 脫鉤：暫停期間送出的普通 "hi" 讓 consecInjects 累加，但只要
  // aiStep 沒動，恢復後接著上次的步驟，不會整段跳號。
  assert.equal(pickInjectMsg({ ...m, consecInjects: 50, aiStep: 1 }), 'critical', 'consecInjects drift does not skip steps');
});

test('pickInjectMsg: briefing prefixes only the very first step of each fresh unattended round', () => {
  const cycle = ['review', 'critical', 'suggest'];
  const m = { pendingResume: false, resumeMsg: 'go on', aiMsg: cycle, msg: 'hi', consecInjects: 5, briefing: 'BRIEF:' };
  assert.equal(pickInjectMsg({ ...m, aiStep: 0 }), 'BRIEF: review', 'aiStep 0 gets the one-time briefing prepended');
  assert.equal(pickInjectMsg({ ...m, aiStep: 1 }), 'critical', 'step 2+ in the same round: no briefing');
  // aiStep=3 也選到 aiMsg[3%3]='review'（循環自然繞回），但這是同一輪連續無人值守中途
  // 繞圈，不是「使用者活動歸零後的全新一輪」——不該重複附加簡報，只認真正的 aiStep===0。
  assert.equal(pickInjectMsg({ ...m, aiStep: 3 }), 'review', 'cycle wrap mid-round ≠ fresh round: no re-briefing');
  // 沒給 briefing（預設 null）→ 完全不影響既有行為
  assert.equal(pickInjectMsg({ ...m, aiStep: 0, briefing: null }), 'review', 'no briefing configured → unchanged');
  // 固定字串 aiMsg（CWARM_AI_MSG）不是陣列，briefing 不適用
  assert.equal(pickInjectMsg({ ...m, aiMsg: 'fixed message', aiStep: 0 }), 'fixed message', 'non-array aiMsg ignores briefing');
});

// ---- AI 模式快節奏 ----
test('aiPacing: fast pace only when unattended + quota headroom + normal state', () => {
  const base = { ttl: 3600, idleThreshold: 3480 };
  // 快跑：AI 模式、額度 <70%、狀態 normal
  assert.deepEqual(aiPacing({ consecInjects: 2, usedPct: 30, ustate: 'normal', ...base }),
    { ttl: 300, idleThreshold: 300 });
  // 尚未進 AI 模式 → 原節奏
  assert.deepEqual(aiPacing({ consecInjects: 1, usedPct: 30, ustate: 'normal', ...base }), base);
  // 額度吃緊（≥70%）→ 原節奏
  assert.deepEqual(aiPacing({ consecInjects: 5, usedPct: 70, ustate: 'normal', ...base }), base);
  // 無橋接資料 → 保守原節奏
  assert.deepEqual(aiPacing({ consecInjects: 5, usedPct: null, ustate: 'unknown', ...base }), base);
  // warn/limited 狀態 → 原節奏（各自有既有處理）
  assert.deepEqual(aiPacing({ consecInjects: 5, usedPct: 30, ustate: 'warn', ...base }), base);
});

test('aiPacing: pace never exceeds the regime values (short regime stays short)', () => {
  const short = { ttl: 300, idleThreshold: 240 };
  assert.deepEqual(aiPacing({ consecInjects: 3, usedPct: 10, ustate: 'normal', ...short, paceS: 600 }),
    { ttl: 300, idleThreshold: 240 }, 'Math.min keeps 5m-regime pacing');
  assert.deepEqual(aiPacing({ consecInjects: 3, usedPct: 10, ustate: 'normal', ttl: 3600, idleThreshold: 3480, paceS: 120 }),
    { ttl: 120, idleThreshold: 120 }, 'custom faster pace applies');
});

// ---- account info (statusline 帳號段) ----
test('account: email from config, plan from credentials, tier suffix appended', () => {
  assert.deepEqual(accountInfoFromSources({
    credentials: { claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } },
    config: { oauthAccount: { emailAddress: 'a@b.c' } },
  }), { email: 'a@b.c', plan: 'Max 5x' });
  assert.deepEqual(accountInfoFromSources({
    credentials: { claudeAiOauth: { subscriptionType: 'pro' } },
    config: { oauthAccount: { emailAddress: 'a@b.c' } },
  }), { email: 'a@b.c', plan: 'Pro' });
});

test('account: missing credentials (macOS keychain) -> email only; nothing -> both null', () => {
  assert.deepEqual(accountInfoFromSources({ config: { oauthAccount: { emailAddress: 'a@b.c' } } }),
    { email: 'a@b.c', plan: null });
  assert.deepEqual(accountInfoFromSources({}), { email: null, plan: null });
  assert.deepEqual(accountInfoFromSources({ credentials: { claudeAiOauth: { subscriptionType: null } } }),
    { email: null, plan: null });
});

test('detectAccountInfo: reads files under claudeDir with ~/.claude.json fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-a-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-ah-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
  assert.deepEqual(detectAccountInfo(dir, { homedir: home }), { email: 'x@y.z', plan: 'Max 20x' });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('detectBillingMode: falls back to ~/.claude.json, and to null when nothing exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-b-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-h-'));
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { billingType: 'stripe_subscription' } }));
  assert.equal(detectBillingMode(dir, { env: {}, homedir: home }), 'subscription');
  assert.equal(detectBillingMode(dir, { env: {}, homedir: fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-e-')) }), null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- encode / transcript path + idle ----
test('encodeProjectDir mirrors Claude Code path encoding', () => {
  assert.equal(encodeProjectDir('C:\\temp\\scripts\\cwarm'), 'C--temp-scripts-cwarm');
  assert.equal(encodeProjectDir('/home/u/proj'), '-home-u-proj');
});

test('cwdKey: trims a trailing slash (either direction) on every platform', () => {
  assert.equal(cwdKey('/home/u/proj/'), cwdKey('/home/u/proj'), 'trailing / trimmed');
  assert.equal(cwdKey('C:\\temp\\proj\\'), cwdKey('C:\\temp\\proj'), 'trailing \\ trimmed');
});

test('cwdKey: Windows-only case/slash folding — case-sensitive filesystems keep case', () => {
  if (os.platform() === 'win32') {
    // Windows：磁碟代號大小寫、正／反斜線都摺成同一把 key（host 與 statusline 回報的 cwd
    // 常見只差這兩點）。
    assert.equal(cwdKey('C:\\Temp\\Proj'), cwdKey('c:/temp/proj'));
  } else {
    // 類 Unix：大小寫敏感檔案系統上，/home/Alice 與 /home/alice 是兩個不同目錄，
    // cwdKey 不可把它們摺成同一把 key，否則兩個專案的 AI 狀態/額度橋接會互相污染。
    assert.notEqual(cwdKey('/home/Alice/proj'), cwdKey('/home/alice/proj'));
  }
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

test('transcript idle: sinceMs ignores transcripts older than host start (Context 0% 不保溫)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-t-'));
  const cwd = 'C:\\proj\\x';
  const pdir = path.join(dir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  const f = path.join(pdir, 'old-session.jsonl');
  fs.writeFileSync(f, '{}\n');
  const t = new Date(NOW - ms(7200)); // 上一個 session 的舊檔，兩小時前
  fs.utimesSync(f, t, t);
  const hostStart = NOW - ms(600); // host 十分鐘前啟動
  assert.equal(transcriptIdleMs(dir, cwd, NOW, hostStart), null, '啟動前的舊檔不算數 → 不注入');
  // 本 session 第一句話寫入後（mtime 晚於啟動）→ 保溫啟用
  const t2 = new Date(NOW - ms(300));
  fs.utimesSync(f, t2, t2);
  const idle = transcriptIdleMs(dir, cwd, NOW, hostStart);
  assert.ok(Math.abs(idle - ms(300)) < 2000, `expected idle ~300s, got ${idle}ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcript idle: sinceMs disables the cross-project fallback (並行 session 不得誤導)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-t-'));
  // 只有「別的專案」有 transcript，且 mtime 晚於 host 啟動（模擬另一視窗的並行 session）
  const other = path.join(dir, 'projects', 'other-proj');
  fs.mkdirSync(other, { recursive: true });
  const f = path.join(other, 's.jsonl');
  fs.writeFileSync(f, '{}\n');
  const t = new Date(NOW - ms(100));
  fs.utimesSync(f, t, t);
  const hostStart = NOW - ms(600);
  // 無 sinceMs：沿用跨專案 fallback（既有行為）
  assert.ok(transcriptIdleMs(dir, 'C:\\proj\\empty', NOW) != null);
  // 有 sinceMs：只認自己專案的資料夾 → null → 不注入（Context 0% 不保溫）
  assert.equal(transcriptIdleMs(dir, 'C:\\proj\\empty', NOW, hostStart), null);
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

// ---- session bridge（多分頁同資料夾並行的 transcript 針定）----
// Bug 情境：兩個分頁在同一個資料夾各開一個 session，host 拿「資料夾裡 mtime 最新的
// .jsonl」判 idle，會抓到隔壁分頁的 transcript——隔壁還在活動，自己永遠算不滿門檻、
// 保溫不發、cache 冷掉。修法：statusline 把 payload 的 transcript_path 落地成
// per-host 橋接檔，host 針定自己的 transcript。
test('sessionBridgePath: hostId is sanitized before landing in the filename', () => {
  const p = sessionBridgePath('C:\home\.claude', '..\..\evil/../x');
  assert.equal(path.dirname(p), 'C:\home\.claude', 'stays inside claudeDir');
  assert.match(path.basename(p), /^cwarm-session-[a-zA-Z0-9_-]+\.json$/);
});

test('readSessionTranscript: returns the bridged path only when it exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-sb-'));
  const t = path.join(dir, 'session.jsonl');
  fs.writeFileSync(t, '{}\n');
  fs.writeFileSync(sessionBridgePath(dir, 'h1'), JSON.stringify({ transcript_path: t, ts: Date.now() }));
  assert.equal(readSessionTranscript(dir, 'h1'), t);
  assert.equal(readSessionTranscript(dir, null), null, 'no hostId → null');
  assert.equal(readSessionTranscript(dir, 'h2'), null, 'no bridge file → null');
  fs.writeFileSync(sessionBridgePath(dir, 'h3'), JSON.stringify({ transcript_path: path.join(dir, 'gone.jsonl'), ts: Date.now() }));
  assert.equal(readSessionTranscript(dir, 'h3'), null, 'bridged path no longer exists → null');
  fs.writeFileSync(sessionBridgePath(dir, 'h4'), 'not-json');
  assert.equal(readSessionTranscript(dir, 'h4'), null, 'corrupt bridge file → null');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptIdleMsAt: pinned-file idle with the same sinceMs semantics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-sa-'));
  const t = path.join(dir, 'session.jsonl');
  fs.writeFileSync(t, '{}\n');
  const m = fs.statSync(t).mtimeMs;
  assert.equal(transcriptIdleMsAt(t, m + 5000), 5000);
  assert.equal(transcriptIdleMsAt(t, m + 5000, m - 1000), 5000, 'mtime after sinceMs counts');
  assert.equal(transcriptIdleMsAt(t, m + 5000, m + 1000), null, 'mtime before sinceMs → null (Context 0% rule)');
  assert.equal(transcriptIdleMsAt(path.join(dir, 'gone.jsonl'), m), null, 'missing file → null');
  assert.equal(transcriptIdleMsAt(null, m), null, 'no path → null');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: a busier sibling transcript in the same project dir no longer masks our idle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwarm-sr-'));
  const cwd = 'C:\proj\tabs';
  const pdir = path.join(dir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  const ours = path.join(pdir, 'ours.jsonl');
  const theirs = path.join(pdir, 'theirs.jsonl');
  fs.writeFileSync(ours, '{}\n');
  fs.writeFileSync(theirs, '{}\n');
  const started = fs.statSync(ours).mtimeMs - 10_000;
  // 我們的 session 已閒置 10 分鐘；隔壁分頁 5 秒前才動過。
  const ourM = fs.statSync(ours).mtimeMs;
  fs.utimesSync(theirs, new Date(ourM + 595_000), new Date(ourM + 595_000));
  const now = ourM + 600_000;
  // mtime 實際落地帶檔案系統精度誤差（次毫秒～毫秒級），比對用容差
  const folderGuess = transcriptIdleMs(dir, cwd, now, started);
  assert.ok(Math.abs(folderGuess - 5000) < 100, `old folder-newest heuristic reports the neighbour's ~5s idle (the bug), got ${folderGuess}`);
  fs.writeFileSync(sessionBridgePath(dir, 'me'), JSON.stringify({ transcript_path: ours, ts: now }));
  const pinned = readSessionTranscript(dir, 'me');
  const pinnedIdle = transcriptIdleMsAt(pinned, now, started);
  assert.ok(Math.abs(pinnedIdle - 600_000) < 100, `pinned transcript reports our real ~10min idle, got ${pinnedIdle}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
