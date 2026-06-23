// keepalive.mjs — 決策邏輯 + TTL 檔位 / 閒置偵測（無 PTY，便於單元測試）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// TTL 檔位 → { ttl(秒), idleThreshold(秒) }。long=1h cache、short=5m cache。
// 提早注入幅度對齊各家慣例：long 提早 ~2 分、short 提早 1 分。
export const REGIME_PARAMS = {
  long: { ttl: 3600, idleThreshold: 3480 },
  short: { ttl: 300, idleThreshold: 240 },
};

export function regimeParams(regime, overrides = {}) {
  const base = REGIME_PARAMS[regime] || REGIME_PARAMS.short; // 未知一律 short（保守，門檻短不讓 cache 冷掉）
  return {
    ttl: overrides.ttl ?? base.ttl,
    idleThreshold: overrides.idleThreshold ?? base.idleThreshold,
  };
}

export function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Claude Code 把 transcript 存在 ~/.claude/projects/<編碼後的 cwd>/<uuid>.jsonl，
// 編碼規則為「非英數字元一律換成 '-'」（例：C:\temp\scripts\cwarm → C--temp-scripts-cwarm）。
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// 某資料夾內 mtime 最新的 *.jsonl 完整路徑；沒有則 null。
function newestJsonlPath(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let best = null, bestM = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs;
      if (bestM == null || m > bestM) { bestM = m; best = path.join(dir, name); }
    } catch { /* skip unreadable */ }
  }
  return best;
}

// 本 session transcript 的完整路徑：優先 cwd 對應的 project 資料夾，
// 找不到再退回 projects 底下全域最新（cwarm 本就假設單一 session）。null = 完全找不到。
export function transcriptPath(claudeDir, cwd) {
  const projects = path.join(claudeDir, 'projects');
  const direct = newestJsonlPath(path.join(projects, encodeProjectDir(cwd)));
  if (direct != null) return direct;
  let subdirs;
  try { subdirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  let best = null, bestM = null;
  for (const d of subdirs) {
    if (!d.isDirectory()) continue;
    const p = newestJsonlPath(path.join(projects, d.name));
    if (p == null) continue;
    try {
      const m = fs.statSync(p).mtimeMs;
      if (bestM == null || m > bestM) { bestM = m; best = p; }
    } catch { /* skip */ }
  }
  return best;
}

// 本 session transcript 的最新 mtime（毫秒）；null = 完全找不到。
export function transcriptMtimeMs(claudeDir, cwd) {
  const p = transcriptPath(claudeDir, cwd);
  if (!p) return null;
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

// 距上次訊息（transcript 寫入）多久（毫秒）；找不到 transcript 回 null。
// 這才是 prompt cache 年齡的正確訊號——終端「輸入」（捲動／讀回覆／打到一半沒送出）
// 都不會刷新 cache，故不以 stdin 計時，改看 transcript mtime。
export function transcriptIdleMs(claudeDir, cwd, now = Date.now()) {
  const m = transcriptMtimeMs(claudeDir, cwd);
  return m == null ? null : now - m;
}

// 讀 transcript 尾端，判斷這個 session 實際拿到的 cache TTL 檔位。
// 回傳 'long'(1h) / 'short'(5m) / null（找不到可判讀的 cache_creation）。
// 為什麼讀 transcript 而非帳號方案：message.usage.cache_creation 的
// ephemeral_1h_input_tokens / ephemeral_5m_input_tokens 是 API 親口回報「這批 token
// 寫進哪個 TTL 桶」的實測值；subscriptionType 只是間接猜測，且會被 client 版本、
// 環境變數、伺服器端旗標影響而失準（實測 pro 帳號也可能拿到 1h）。
export function readTtlRegime(tpath, { maxBytes = 65536, scanTurns = 8 } = {}) {
  if (!tpath) return null;
  let size, buf;
  let fd = null;
  try {
    size = fs.statSync(tpath).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    buf = Buffer.alloc(len);
    fd = fs.openSync(tpath, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
  let lines = buf.toString('utf8').split(/\r?\n/);
  if (size > maxBytes && lines.length) lines = lines.slice(1); // 丟掉被切半的第一行
  let sawShort = false;
  let examined = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || obj.type !== 'assistant') continue;
    const cc = obj.message && obj.message.usage && obj.message.usage.cache_creation;
    if (!cc || typeof cc !== 'object') continue;
    const h = cc.ephemeral_1h_input_tokens || 0;
    const m = cc.ephemeral_5m_input_tokens || 0;
    if (h > 0) return 'long';                 // 最近任一回合寫過 1h → 1h 檔位（決定性）
    if (m > 0) { sawShort = true; if (++examined >= scanTurns) break; } // 只看最近數筆有寫 cache 的回合
  }
  return sawShort ? 'short' : null;
}

// 找出本 session transcript 並判斷 TTL 檔位。'long' / 'short' / null。
export function detectTtlRegime(claudeDir, cwd, opts) {
  return readTtlRegime(transcriptPath(claudeDir, cwd), opts);
}

// 純決策：現在該不該注入 keepalive？idleMs = 距上次訊息多久（由 transcriptIdleMs 算）。
// screenIdleMs = 距 claude 最近一次「畫面輸出」多久；quietMs = 需靜止多久才放行。
// 為什麼要這個畫面靜默門檻：transcript 在「等你回答必答提示（權限/選單/計畫批准）」與
// 「跑長工具/生成中」時都不會更新，光看 idleMs 無法分辨這兩種「忙/卡」狀態與「真的閒置在輸入框」。
// 但畫面活動可以：閒置在輸入框時畫面靜止；提示等待時 spinner 在動、生成中持續輸出。
// 故只有畫面靜止夠久才注入——避免把 hi 的 Enter 送進 modal 誤選預設項，也避免打斷長工具執行。
// quietMs 省略（null）時不套此門檻（保持純 idle 決策，供既有測試/呼叫者使用）。
export function decideInject({ now, idleMs, lastFire, idleThreshold, ttl, disabled, screenIdleMs, quietMs }) {
  if (disabled) return false;                          // 暫停開關
  if (idleMs == null) return false;                    // 找不到 transcript → 保守不發
  if (idleMs < idleThreshold * 1000) return false;     // 距上次訊息還不夠久
  if (now - lastFire < ttl * 1000) return false;       // 冷卻未滿一個 TTL
  if (quietMs != null && screenIdleMs != null && screenIdleMs < quietMs) return false; // 畫面還在動（提示/生成/打字中）
  return true;
}
