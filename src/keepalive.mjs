// keepalive.mjs — 純決策邏輯 + plan 偵測（無 PTY、無副作用，便於單元測試）。
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

// 純決策：現在該不該注入 keepalive？
//   idle = now - lastInput（使用者最後一次按鍵到現在）。自包含、跨平台、不依賴外部檔。
export function decideInject({ now, lastInput, lastFire, idleThreshold, ttl, disabled }) {
  if (disabled) return false;                              // 暫停開關
  if (now - lastInput < idleThreshold * 1000) return false; // 使用者最近還在操作
  if (now - lastFire < ttl * 1000) return false;            // 冷卻未滿一個 TTL
  return true;
}
