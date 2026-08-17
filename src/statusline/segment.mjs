#!/usr/bin/env node
// segment.mjs — cwarm 的 statusLine：跑使用者原本的 statusline（若有）再接上「cache 保溫倒數」。
//   純 Node、跨平台（不依賴 Python）；emoji 走 Node UTF-8 stdout，沒有 Windows cp950 問題。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultClaudeDir, readTtlRegime, regimeParams, billingModeFromSources, accountInfoFromSources, readAuthSources, usageState, usageBridgePath, readAiState, sessionBridgePath, weeklyPaceInfo } from '../keepalive.mjs';

const claudeDir = defaultClaudeDir();
const ORIG = path.join(claudeDir, 'cwarm-statusline-orig.json');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// 憑證/設定來源整份只讀一次（billing 與帳號段共用），render 路徑不重複 IO。
const auth = readAuthSources(claudeDir);

// cache 倒數段：用 transcript mtime 當 idle、用 transcript 實測的 cache_creation 判 TTL（1h / 5m）。
function cacheSegment(payload) {
  // credits/API 計費時 keepalive 已暫停，倒數沒有意義且會誤導 → 顯示暫停標記
  if (billingModeFromSources({ env: process.env, ...auth }) === 'credits') return '⏸️ cwarm off (API)';
  const tp = payload?.transcript_path;
  if (!tp) return '';
  let mtimeMs;
  try { mtimeMs = fs.statSync(tp).mtimeMs; } catch { return ''; }
  const { ttl } = regimeParams(readTtlRegime(tp));   // 'long'→3600 / 'short'|null→300

  const idle = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  const rem = ttl - idle;
  if (rem <= 0) return `\u{1F534} cache ${Math.floor(idle / 60)}m`;      // 🔴 已冷
  if (rem <= 60) return `\u{1F7E1} cache ${rem}s`;                       // 🟡 快過期
  return `♻️ cache ${Math.floor(rem / 60)}m${rem % 60}s`;       // ♻️ 倒數
}

// 帳號段：兩個帳號間 /login 切換時，顯示現在是哪個帳號、什麼訂閱（如 👤cycompassion·Max 5x）。
// 每次 statusline 刷新重讀檔案，/login 切完下一次刷新就會反映。
function accountSegment() {
  const { email, plan } = accountInfoFromSources(auth);
  if (!email && !plan) return '';
  const name = email ? email.split('@')[0] : '?';
  return plan ? `\u{1F464}${name}·${plan}` : `\u{1F464}${name}`;
}

// payload 裡可能報 cwd 的幾個欄位，依序嘗試——host 那邊用同一套 cwdKey() 正規化
// （忽略大小寫/斜線方向），故這裡選到哪個候選字串不影響對得上與否，只要有值即可。
function payloadCwd(payload) {
  return payload?.workspace?.project_dir || payload?.cwd || payload?.workspace?.current_dir || null;
}

// 額度橋接 + 提醒段：host（保溫迴圈）收不到 statusline payload，這裡把 rate_limits.five_hour
// 落地成 per-cwd 橋接檔給 host 讀（撞牆偵測與 reset 後改敲 "go on" 都靠它）——不同帳號/
// 專案的並行 session 各寫各的，不會互相覆蓋彼此的額度視窗。
// 回傳提醒文字（可能兩段用 │ 接起來）：
//   5h  — 用量 ≥95% 且離 reset 還超過 1 小時 → 建議使用者暫時中斷；不滿 1 小時就不提醒，
//         尾巴額度照常燒到撞牆。
//   週  — weeklyPaceInfo 依超前「按時間比例均攤」進度線幾個百分點顯示球號（<2🟢/3~5🟡/
//         6~8🟠/9~11🩷/≥12🔴，2~3% 留白），並附上剩餘天數的日均可用量。
function usageBridgeAndWarn(payload, cwd) {
  const fh = payload?.rate_limits?.five_hour;
  if (!fh || typeof fh !== 'object') return '';
  const usedPct = fh.used_percentage ?? null;
  const resetsAt = fh.resets_at ?? null;
  const sd = payload?.rate_limits?.seven_day;
  if (cwd) {
    try {
      fs.writeFileSync(usageBridgePath(claudeDir, cwd), JSON.stringify({
        used_percentage: usedPct,
        resets_at: resetsAt,
        seven_day: { used_percentage: sd?.used_percentage ?? null, resets_at: sd?.resets_at ?? null },
        ts: Date.now(),
      }));
    } catch { /* 落地失敗不影響顯示 */ }
  }
  const nowSec = Date.now() / 1000;
  const parts = [];
  if (usageState({ usedPct, resetsAt, nowSec }) === 'warn') {
    const hLeft = Math.round((resetsAt - nowSec) / 3600);
    parts.push(`⚠️ ${Math.round(usedPct)}%、離reset還${hLeft}h，建議暫停`); // ⚠️ NN%、離reset還Nh，建議暫停
  }
  const wp = weeklyPaceInfo({ usedPct: sd?.used_percentage ?? null, resetsAt: sd?.resets_at ?? null, nowSec });
  if (wp) {
    // 球 週超前X.X%，剩N.Nd均M.M%/天（，休息H.Hh回綠）：X 是超出「按時間比例均攤」
    // 進度線的百分點，均M.M%/天是把剩餘額度攤到視窗剩餘天數後接下來每天還能燒多少，
    // 休息段只在非綠球時出現——不再新增用量、單純等進度線爬上來要等多久才回綠球。
    let text = `${wp.ball} 週超前${wp.excess.toFixed(1)}%，剩${wp.daysRemaining.toFixed(1)}d均${wp.avgPerDayRemaining.toFixed(1)}%/天`;
    if (wp.recoverySec > 0) {
      const h = wp.recoverySec / 3600;
      text += h >= 24 ? `，休息${(h / 24).toFixed(1)}d回綠` : `，休息${h.toFixed(1)}h回綠`;
    }
    parts.push(text);
  }
  return parts.join(' │ ');
}

// AI 模式開關段：顯示無人值守 AI 模式 on/off 與切換熱鍵。狀態檔以 cwd 編碼命名
//（多 host 並行各寫各的），用 payload 的專案路徑對回；ts 過舊（>60s，沒有
// cwarm host 在跑或已退出）就不顯示，避免殘留假狀態。
function aiSegment(cwd) {
  if (!cwd) return '';
  const st = readAiState(claudeDir, cwd);
  if (!st) return '';
  const key = st.key || 'Ctrl+\\';
  return `\u{1F916}AI ${st.enabled ? 'on' : 'off'} (${key})`; // 🤖
}

// 跑使用者原本存起來的 statusLine 指令（餵同一份 stdin），回傳其輸出；沒有就 null。
function runOriginal(raw) {
  let orig;
  try { orig = JSON.parse(fs.readFileSync(ORIG, 'utf8')); } catch { return null; }
  if (!orig || orig.type !== 'command' || !orig.command) return null;
  try {
    const r = spawnSync(orig.command, { shell: true, input: raw, encoding: 'utf8', timeout: 3000, windowsHide: true });
    const out = (r.stdout || '').replace(/\s+$/, '');
    return out || null;
  } catch { return null; }
}

function minimalBase(payload) {
  const model = payload?.model?.display_name;
  return model ? `[${model}]` : 'claude';
}

const raw = readStdin();
let payload = {};
try { payload = JSON.parse(raw); } catch { /* 空/壞就用空物件 */ }

// 本 session transcript 落地給 host（session bridge）：payload 的 transcript_path 是
// session 專屬的正確值，host 端只能猜「資料夾裡最新的 .jsonl」——多分頁同資料夾時會
// 猜到隔壁 session、保溫失準。host 產生的 CWARM_HOST_ID 經 pty 環境變數傳到這裡；
// 沒有這個變數代表這個 session 不是 cwarm 帶起來的（純 claude），不落地。
if (process.env.CWARM_HOST_ID && payload?.transcript_path) {
  try {
    fs.writeFileSync(sessionBridgePath(claudeDir, process.env.CWARM_HOST_ID),
      JSON.stringify({ transcript_path: payload.transcript_path, ts: Date.now() }));
  } catch { /* 落地失敗不影響顯示 */ }
}

const cwd = payloadCwd(payload);
const seg = cacheSegment(payload);
const warn = usageBridgeAndWarn(payload, cwd);
let base = runOriginal(raw);
if (base == null) base = minimalBase(payload);
// 順序：帳號段 │ base 第一行 │ cache 倒數 │ 🤖AI 開關 │ ⚠️額度提醒；base 其餘行原樣跟在後面。
// 原 statusline（如 claude-hud）常是多行輸出，所有 cwarm 段一律掛在「第一行」頭尾，
// 不能傻傻接在字串末端（那會落到最後一行尾）。
const lines = base.split('\n');
const first = [accountSegment(), lines[0], seg, aiSegment(cwd), warn].filter(Boolean).join(' │ ');
const out = [first, ...lines.slice(1)].join('\n');
process.stdout.write(out + '\n');
