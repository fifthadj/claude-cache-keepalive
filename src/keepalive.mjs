// keepalive.mjs — 決策邏輯 + plan / 閒置偵測（無 PTY，便於單元測試）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// plan → { ttl(秒), idleThreshold(秒) }。對齊各家慣例：max 提早 ~2 分注入、pro 提早 1 分。
export const PLAN_PARAMS = {
  max: { ttl: 3600, idleThreshold: 3480 },
  pro: { ttl: 300, idleThreshold: 240 },
};

export function planParams(plan, overrides = {}) {
  const base = PLAN_PARAMS[plan] || PLAN_PARAMS.pro;
  return {
    ttl: overrides.ttl ?? base.ttl,
    idleThreshold: overrides.idleThreshold ?? base.idleThreshold,
  };
}

export function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// 從 Claude Code 憑證判方案；讀不到一律當 'pro'（保守）。
export function detectPlan(claudeDir = defaultClaudeDir()) {
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8'));
    return cred?.claudeAiOauth?.subscriptionType === 'max' ? 'max' : 'pro';
  } catch {
    return 'pro';
  }
}

// Claude Code 把 transcript 存在 ~/.claude/projects/<編碼後的 cwd>/<uuid>.jsonl，
// 編碼規則為「非英數字元一律換成 '-'」（例：C:\temp\scripts\cwarm → C--temp-scripts-cwarm）。
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// 某資料夾內所有 *.jsonl 的最新 mtime（毫秒）；沒有則 null。
function newestJsonlMtime(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs;
      if (newest == null || m > newest) newest = m;
    } catch { /* skip unreadable */ }
  }
  return newest;
}

// 本 session transcript 的最新 mtime（毫秒）：優先 cwd 對應的 project 資料夾，
// 找不到再退回 projects 底下全域最新（cwarm 本就假設單一 session）。null = 完全找不到。
export function transcriptMtimeMs(claudeDir, cwd) {
  const projects = path.join(claudeDir, 'projects');
  const direct = newestJsonlMtime(path.join(projects, encodeProjectDir(cwd)));
  if (direct != null) return direct;
  let subdirs;
  try { subdirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  let newest = null;
  for (const d of subdirs) {
    if (!d.isDirectory()) continue;
    const m = newestJsonlMtime(path.join(projects, d.name));
    if (m != null && (newest == null || m > newest)) newest = m;
  }
  return newest;
}

// 距上次訊息（transcript 寫入）多久（毫秒）；找不到 transcript 回 null。
// 這才是 prompt cache 年齡的正確訊號——終端「輸入」（捲動／讀回覆／打到一半沒送出）
// 都不會刷新 cache，故不以 stdin 計時，改看 transcript mtime。
export function transcriptIdleMs(claudeDir, cwd, now = Date.now()) {
  const m = transcriptMtimeMs(claudeDir, cwd);
  return m == null ? null : now - m;
}

// 純決策：現在該不該注入 keepalive？idleMs = 距上次訊息多久（由 transcriptIdleMs 算）。
export function decideInject({ now, idleMs, lastFire, idleThreshold, ttl, disabled }) {
  if (disabled) return false;                          // 暫停開關
  if (idleMs == null) return false;                    // 找不到 transcript → 保守不發
  if (idleMs < idleThreshold * 1000) return false;     // 距上次訊息還不夠久
  if (now - lastFire < ttl * 1000) return false;       // 冷卻未滿一個 TTL
  return true;
}
