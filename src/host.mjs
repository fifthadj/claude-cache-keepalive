// host.mjs — 把 claude 跑在自己控制的 PTY 裡，做透明 I/O 多工 + 內建 prompt cache 保溫。
//   注入是行程內部的 pty.write，與視窗焦點/縮小無關；只要 host 行程活著就保溫。
//   跨平台：靠 node-pty（Windows=ConPTY、mac/Linux=forkpty），不需 tmux。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultClaudeDir, regimeParams, detectTtlRegime, decideInject, transcriptIdleMs } from './keepalive.mjs';

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
  // 注意：閒置判斷改看 transcript mtime（距上次「訊息」多久），不再用 stdin 計時——
  // 終端輸入（捲動／讀回覆／打到一半沒送出）不會刷新 cache，拿來計時會誤判成「使用者還在忙」。
  if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
  process.stdin.resume();
  process.stdin.on('data', (d) => { ptyProc.write(d); });
  // 追蹤 claude 最近一次有輸出到畫面的時刻：閒置在輸入框時畫面靜止；提示等待回答時 spinner 在動、
  // 生成/跑工具時持續輸出。注入前要求畫面已靜止一段時間（見下方 quietMs），就能避開「忙/卡」狀態。
  let lastOutputMs = Date.now();
  ptyProc.onData((d) => { lastOutputMs = Date.now(); process.stdout.write(d); });
  process.stdout.on('resize', () => {
    try { ptyProc.resize(process.stdout.columns || 80, process.stdout.rows || 24); } catch {}
  });

  // ---- 內建保溫 ----
  const tickMs = Number(process.env.CWARM_TICK_MS) || 20_000;
  const msg = process.env.CWARM_MSG || opts.msg || 'hi';
  const quietMs = Number(process.env.CWARM_QUIET_MS) || 2500;      // 畫面需靜止這麼久才注入
  const escDelayMs = Number(process.env.CWARM_ESC_DELAY_MS) || 250; // Esc 與訊息之間的間隔
  const overrides = {};
  const thr = process.env.CWARM_THRESHOLD_S ?? opts.thresholdS;
  const ttlO = process.env.CWARM_TTL_S ?? opts.ttlS;
  if (thr != null) overrides.idleThreshold = Number(thr);
  if (ttlO != null) overrides.ttl = Number(ttlO);

  let lastFire = 0;
  const timer = setInterval(() => {
    const cwd = process.cwd();
    const regime = detectTtlRegime(claudeDir, cwd);           // 從 transcript 實測 1h/5m，不再猜方案
    const { ttl, idleThreshold } = regimeParams(regime, overrides);
    const now = Date.now();
    const idleMs = transcriptIdleMs(claudeDir, cwd, now);
    const screenIdleMs = now - lastOutputMs;
    if (decideInject({ now, idleMs, lastFire, idleThreshold, ttl, disabled: fs.existsSync(DISABLE), screenIdleMs, quietMs })) {
      // 先送 Esc：把任何「必答」modal（權限/選單/計畫批准）收掉、退回輸入框，後面那個 Enter 才不會誤選預設項；
      // 空輸入框時 Esc 等同 no-op。隔一小段再送訊息——讓 claude 先把 modal 收乾淨，也避免 ESC 與字元被併成 Meta 鍵。
      ptyProc.write('\x1b');
      lastFire = now;
      setTimeout(() => { if (!exiting) { try { ptyProc.write(msg + '\r'); } catch {} } }, escDelayMs);
      const idle = idleMs == null ? -1 : Math.round(idleMs / 1000);
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} inject "${msg}" regime=${regime ?? 'unknown'} idle=${idle}s screenIdle=${Math.round(screenIdleMs / 1000)}s\n`); } catch {}
    }
  }, tickMs);

  // ---- 收尾 ----
  // claude（TUI）會開 alt-screen / bracketed-paste / mouse / 隱藏游標等終端模式。正常 /exit 時它自己會還原，
  // 但 (1) 被 Ctrl-C 中斷時來不及還原；(2) 在 onExit 內立刻 process.exit() 會跟 claude 最後一段輸出（含還原
  // 序列）賽跑而把它截斷。任一情況都會讓真終端卡在這些模式 → 回到 shell 後「鍵盤輸入不正常」。
  // 故 shutdown()：還原 raw mode + 主動補一份終端還原序列 + 等 stdout flush 再退出。
  // 關鍵（Windows）：node-pty 啟動時對真終端開了 ?9001h(win32-input-mode) 與 ?1004h(focus reporting)，
  // 若沒關掉，回到 shell 後終端會把每個鍵碼以 ESC[…_ 封包送出，readline 無法解析 → 鍵盤輸入全亂。
  // ?2004=bracketed paste、?1000/1002/1003/1006=mouse、?25=cursor、?1049=alt-screen、?9001=win32-input、?1004=focus。
  const RESET = '\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l\x1b[?9001l\x1b[?1004l\x1b[0m';
  let exiting = false;
  function shutdown(code) {
    if (exiting) return;
    exiting = true;
    clearInterval(timer);
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
    try { process.stdout.write(RESET, () => process.exit(code)); }
    catch { process.exit(code); }
    setTimeout(() => process.exit(code), 200).unref(); // 保險：flush callback 沒回也強制退出
  }
  ptyProc.onExit(({ exitCode }) => shutdown(exitCode || 0)); // node-pty 會卡住 event loop，必須主動退出
  // Windows：真主控台的 Ctrl-C 以 SIGINT 送到 host（claude 在獨立 ConPTY、收不到真主控台的 Ctrl-C），
  // 轉成 0x03 寫進 pty 交給 claude 自己處理；不要讓 host 被預設行為直接殺掉（那會跳過終端還原 → 卡 raw mode）。
  // Unix raw mode 下 Ctrl-C 是位元組(0x03)、不觸發 SIGINT，故此 handler 不影響 Unix。
  process.on('SIGINT', () => { try { ptyProc.write('\x03'); } catch {} });
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  // 任何路徑退出都殺掉 pty，並盡力（同步）還原終端，作為最後保險。
  process.on('exit', () => {
    try { ptyProc.kill(); } catch {}
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    try { process.stdout.write(RESET); } catch {}
  });

  return ptyProc;
}
