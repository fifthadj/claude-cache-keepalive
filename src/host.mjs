// host.mjs — 把 claude 跑在自己控制的 PTY 裡，做透明 I/O 多工 + 內建 prompt cache 保溫。
//   注入是行程內部的 pty.write，與視窗焦點/縮小無關；只要 host 行程活著就保溫。
//   跨平台：靠 node-pty（Windows=ConPTY、mac/Linux=forkpty），不需 tmux。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultClaudeDir, planParams, detectPlan, decideInject } from './keepalive.mjs';

const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';

// 跨平台找出 claude 執行檔的完整路徑（Windows 的 node-pty 不會自己補 .exe，需給全路徑）。
export function resolveClaude() {
  if (process.env.CWARM_CLAUDE) return process.env.CWARM_CLAUDE;
  try {
    const r = spawnSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
    const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch { /* fall through */ }
  return 'claude'; // 最後手段：交給 node-pty 用 PATH 試
}

// 算出要 spawn 的 (file, args)。Windows 上 .cmd/.bat shim 無法被 node-pty 直接 exec，改用 cmd.exe 包。
function spawnSpec(claudeBin, args) {
  if (isWin && /\.(cmd|bat)$/i.test(claudeBin)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', claudeBin, ...args] };
  }
  return { file: claudeBin, args };
}

export function startHost(opts = {}) {
  const pty = require('node-pty');
  const claudeDir = defaultClaudeDir();
  const LOG = path.join(claudeDir, 'cwarm-keepalive.log');
  const DISABLE = path.join(claudeDir, 'cwarm.disabled');

  const args = opts.args && opts.args.length ? opts.args : ['--continue'];
  const { file, args: spawnArgs } = spawnSpec(resolveClaude(), args);

  const ptyProc = pty.spawn(file, spawnArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env,
  });

  // ---- 透明 I/O 多工 ----
  // 直接寫 Buffer（純位元組轉送）：UTF-8 多位元組（中文等）才不會被重編碼弄壞。
  let lastInput = Date.now();
  if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
  process.stdin.resume();
  process.stdin.on('data', (d) => { lastInput = Date.now(); ptyProc.write(d); });
  ptyProc.onData((d) => process.stdout.write(d));
  process.stdout.on('resize', () => {
    try { ptyProc.resize(process.stdout.columns || 80, process.stdout.rows || 24); } catch {}
  });

  // ---- 內建保溫 ----
  const tickMs = Number(process.env.CWARM_TICK_MS) || 20_000;
  const msg = process.env.CWARM_MSG || opts.msg || 'hi';
  const overrides = {};
  const thr = process.env.CWARM_THRESHOLD_S ?? opts.thresholdS;
  const ttlO = process.env.CWARM_TTL_S ?? opts.ttlS;
  if (thr != null) overrides.idleThreshold = Number(thr);
  if (ttlO != null) overrides.ttl = Number(ttlO);

  let lastFire = 0;
  const timer = setInterval(() => {
    const plan = detectPlan(claudeDir);
    const { ttl, idleThreshold } = planParams(plan, overrides);
    const now = Date.now();
    if (decideInject({ now, lastInput, lastFire, idleThreshold, ttl, disabled: fs.existsSync(DISABLE) })) {
      ptyProc.write(msg + '\r');
      lastFire = now;
      const idle = Math.round((now - lastInput) / 1000);
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} inject "${msg}" plan=${plan} idle=${idle}s\n`); } catch {}
    }
  }, tickMs);

  // ---- 收尾 ----
  function restore() {
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
  }
  ptyProc.onExit(({ exitCode }) => {
    clearInterval(timer);
    restore();
    process.exit(exitCode || 0); // node-pty 會卡住 event loop，必須主動退出
  });
  process.on('exit', () => { try { ptyProc.kill(); } catch {} });
  process.on('SIGTERM', () => { try { ptyProc.kill(); } catch {} process.exit(0); });

  return ptyProc;
}
