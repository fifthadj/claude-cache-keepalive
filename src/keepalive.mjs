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
// 必須原樣比照 Claude Code 的編碼（不可正規化大小寫），否則對不上它真正建立的資料夾。
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// cwarm 自家協定檔（AI 狀態、額度橋接）的 cwd 鍵：寫入方（host 的 process.cwd()）與
// 讀取方（statusline payload 回報的 cwd）可能只有大小寫或斜線方向不同（Windows 常見），
// 這裡雙方都不必比對 Claude Code 的真實資料夾，故先正規化再編碼，讓這類差異不致兜不起來。
// 大小寫/斜線方向正規化僅限 Windows：類 Unix 檔案系統多半大小寫敏感，硬轉小寫會把
// 兩個真正不同的目錄（如 /home/Alice 與 /home/alice）錯誤地映成同一把 key，狀態互相污染。
export function cwdKey(cwd) {
  let s = String(cwd).replace(/[\\/]+$/, ''); // 結尾斜線（正／反皆可）先去掉，兩平台通用
  if (os.platform() === 'win32') s = s.replace(/\//g, '\\').toLowerCase();
  return encodeProjectDir(s);
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
// sinceMs（通常給 host 啟動時刻）：mtime 早於它的 transcript 不算數 → 回 null。
// 語意 = 「Context 0% 不保溫」：本 session 還沒有任何內容時沒有 cache 可保，注入無意義；
// 也避免把上一個 session 舊檔的 mtime 誤當 idle（曾造成剛啟動就亂敲 "hi"）。
// 第一句話寫入 transcript（Context > 0%）後，保溫自然啟用。
// 給了 sinceMs 時**只認 cwd 自己的專案資料夾**、不走跨專案 fallback——否則別的專案
// 有並行 session 在跑時，其 transcript mtime 晚於啟動時刻、照樣通過 sinceMs 檢查，
// 等於借別人的活動對自己 0% context 的 session 亂敲。編碼對不上頂多 idle=null 不注入（保守正確）。
export function transcriptIdleMs(claudeDir, cwd, now = Date.now(), sinceMs = null) {
  let m;
  if (sinceMs != null) {
    const p = newestJsonlPath(path.join(claudeDir, 'projects', encodeProjectDir(cwd)));
    try { m = p == null ? null : fs.statSync(p).mtimeMs; } catch { m = null; }
  } else {
    m = transcriptMtimeMs(claudeDir, cwd);
  }
  if (m == null) return null;
  if (sinceMs != null && m < sinceMs) return null;
  return now - m;
}

// ---- 本 session transcript 針定（session bridge）----
// 多分頁在「同一個資料夾」各開一個 session 時，上面「取 mtime 最新的 .jsonl」會抓到
// 隔壁分頁的 transcript：只要隔壁還在活動，自己這邊的 idle 永遠算不滿門檻，保溫不發、
// cache 冷掉（倒數走到🔴）。TTL 檔位偵測也可能讀到別人的檔。
// 解法：只有 statusline 拿得到 Claude Code payload 的 transcript_path（session 專屬、
// 絕對正確），由 segment.mjs 落地成 per-host 橋接檔（cwarm-session-<hostId>.json），
// host 每 tick 讀回，從此針定自己的 transcript。hostId 由 host 產生、經 CWARM_HOST_ID
// 環境變數傳進 pty 裡的 claude，statusline 子行程自然繼承。
// 沒裝 statusline（未跑 cwarm setup）就沒有橋接檔 → 回退舊行為（單 session 不受影響）。
export function sessionBridgePath(claudeDir, hostId) {
  // hostId 進檔名前先消毒：值理論上只來自自家 host，但環境變數可被外部塞怪字元，不給路徑穿越機會。
  return path.join(claudeDir, `cwarm-session-${String(hostId).replace(/[^a-zA-Z0-9_-]/g, '-')}.json`);
}

// 讀橋接檔取回本 session 的 transcript 路徑；hostId 空、檔案不存在、或路徑已失效 → null。
// 不做 ts 時效檢查：檔案是本 host 專屬（hostId 每次啟動唯一），內容只會被自己 session 的
// statusline 更新，路徑本身不會「過期」（/clear 換 session 檔時 statusline 下次刷新就改寫）。
export function readSessionTranscript(claudeDir, hostId) {
  if (!hostId) return null;
  const o = readJsonSafe(sessionBridgePath(claudeDir, hostId));
  const p = o && typeof o.transcript_path === 'string' && o.transcript_path ? o.transcript_path : null;
  if (!p) return null;
  try { fs.statSync(p); } catch { return null; }
  return p;
}

// 針定版 idle：直接看指定 transcript 的 mtime，語意同 transcriptIdleMs（含 sinceMs 的
// 「Context 0% 不保溫」檢查——resume 舊 session 未寫入前 mtime 早於啟動時刻 → null 不注入）。
export function transcriptIdleMsAt(tpath, now = Date.now(), sinceMs = null) {
  if (!tpath) return null;
  let m;
  try { m = fs.statSync(tpath).mtimeMs; } catch { return null; }
  if (sinceMs != null && m < sinceMs) return null;
  return now - m;
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

// ---- 計費模式偵測（subscription vs credits/API）----
// 保溫只在「訂閱制」下划算：額度是 rate limit，cache 保溫省的是額度。若 /login 切到
// Console 帳號（credits / API 計費），每次注入的 "hi" 與 cache 續寫都是實際花錢，
// 保溫反而燒錢 → 偵測到 credits 就自動暫停注入。
// 判斷順序：CWARM_BILLING 強制指定 → .credentials.json 的 claudeAiOauth.subscriptionType
// （/login 當下就會改寫，最即時）→ .claude.json 的 oauthAccount.billingType →
// ANTHROPIC_API_KEY 環境變數 → null（無法判斷，維持現行行為照常保溫）。
export function billingModeFromSources({ env = {}, credentials = null, config = null } = {}) {
  const forced = String(env.CWARM_BILLING || '').toLowerCase();
  if (forced === 'subscription' || forced === 'credits') return forced;
  const oauth = credentials && credentials.claudeAiOauth;
  if (oauth && typeof oauth === 'object') {
    const sub = oauth.subscriptionType;
    if (typeof sub === 'string' && /^(pro|max|team|enterprise)/i.test(sub)) return 'subscription';
    return 'credits'; // 有 OAuth 登入但沒有訂閱層級 → Console 帳號（credits 計費）
  }
  const billing = config && config.oauthAccount && config.oauthAccount.billingType;
  if (billing === 'stripe_subscription') return 'subscription';
  if (typeof billing === 'string' && billing) return 'credits';
  if (env.ANTHROPIC_API_KEY) return 'credits'; // 沒有任何登入痕跡、只有 API key → 純 API 計費
  return null;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// 讀取憑證/設定來源（billing 與 account 偵測共用，statusline 每次刷新只需讀一遍）：
// claudeDir 下的 .credentials.json 與 .claude.json（CLAUDE_CONFIG_DIR 佈局），
// 後者找不到再退回 homedir 的 ~/.claude.json（預設佈局）。macOS 憑證在 Keychain、
// 沒有 .credentials.json 檔，會自然落到 config 判斷。
export function readAuthSources(claudeDir, { homedir = os.homedir() } = {}) {
  const credentials = readJsonSafe(path.join(claudeDir, '.credentials.json'));
  const config = readJsonSafe(path.join(claudeDir, '.claude.json'))
    ?? readJsonSafe(path.join(homedir, '.claude.json'));
  return { credentials, config };
}

export function detectBillingMode(claudeDir, { env = process.env, homedir } = {}) {
  const { credentials, config } = readAuthSources(claudeDir, { homedir });
  return billingModeFromSources({ env, credentials, config });
}

// ---- 帳號/訂閱偵測（statusline 顯示用）----
// 常在兩個帳號間 /login 切換時，光看模型名不知道現在燒的是哪個帳號的額度。
// email 取自 .claude.json 的 oauthAccount（/login 當下改寫）；訂閱層級取自
// .credentials.json 的 claudeAiOauth.subscriptionType，rateLimitTier
//（如 default_claude_max_5x）尾碼可再補上倍率 → "Max 5x"。
export function accountInfoFromSources({ credentials = null, config = null } = {}) {
  const email = (config && config.oauthAccount && config.oauthAccount.emailAddress) || null;
  const oauth = credentials && credentials.claudeAiOauth;
  let plan = null;
  const sub = oauth && typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : '';
  if (sub) {
    plan = sub.charAt(0).toUpperCase() + sub.slice(1);
    const m = /_(\d+x)$/.exec((oauth && oauth.rateLimitTier) || '');
    if (m) plan += ` ${m[1]}`;
  }
  return { email, plan };
}

// IO 版：與 detectBillingMode 共用 readAuthSources（macOS 憑證在 Keychain 時 plan 會是 null，僅顯示 email）。
export function detectAccountInfo(claudeDir, { homedir } = {}) {
  return accountInfoFromSources(readAuthSources(claudeDir, { homedir }));
}

// ---- 額度視窗（5h window）狀態 ----
// 資料來源：Claude Code 餵給 statusline 的 payload 有 rate_limits.five_hour 的
// used_percentage / resets_at（epoch 秒），但 host 收不到 payload，故由 segment.mjs
// 每次刷新落地成 claudeDir/cwarm-usage.json 橋接檔，host 每 tick 讀取。
// 狀態語意：
//   warn    — 用量 ≥ warnPct 且離 reset 還超過 warnGapS（1h）→ 提醒使用者暫時中斷；
//             不滿 1h 就不提醒，讓尾巴額度照常燒到撞牆（反正 reset 後就作廢）
//             （保溫照常用 "hi"，不改行為，提醒顯示在 statusline）
//   limited — 已撞牆（≥ limitPct）→ 注入無意義，暫停等 reset
//   reset   — 橋接檔裡的 resets_at 已過（撞牆後視窗重置）→ host 下一發改敲 "go on"
export function usageState({ usedPct, resetsAt, nowSec }, { warnPct = 95, warnGapS = 3600, limitPct = 99 } = {}) {
  if (usedPct == null || resetsAt == null) return 'unknown';
  if (nowSec >= resetsAt) return 'reset';
  if (usedPct >= limitPct) return 'limited';
  if (usedPct >= warnPct && (resetsAt - nowSec) > warnGapS) return 'warn';
  return 'normal';
}

// 以 cwd 編碼進檔名（同 aiStatePath）：不同帳號/專案的並行 session 各寫各的橋接檔，
// 不會互相覆蓋彼此的額度視窗（曾經全域共用一份，A 帳號會讀到 B 帳號的用量）。
export function usageBridgePath(claudeDir, cwd) {
  return path.join(claudeDir, `cwarm-usage-${cwdKey(cwd)}.json`);
}

// 讀橋接檔；太舊（statusline 停更，如 claude 已關）視同沒有 → null。
// weekPct / weekResetsAt 為 7 天視窗（rate_limits.seven_day），供週配速管控用。
export function readUsageBridge(claudeDir, cwd, { maxAgeMs = 600_000, now = Date.now() } = {}) {
  const o = readJsonSafe(usageBridgePath(claudeDir, cwd));
  if (!o || typeof o !== 'object' || o.ts == null) return null;
  if (now - o.ts > maxAgeMs) return null;
  const sd = o.seven_day && typeof o.seven_day === 'object' ? o.seven_day : {};
  return {
    usedPct: o.used_percentage ?? null,
    resetsAt: o.resets_at ?? null,
    weekPct: sd.used_percentage ?? null,
    weekResetsAt: sd.resets_at ?? null,
  };
}

// ---- 週配速管控（7 天視窗）----
// 5h 視窗管當下衝刺，7 天視窗管整週配速：週額度日均只有 100/7 ≈ 14.3%，無人值守
// 快跑不能只看 5h 有空間。以「按時間比例均攤的進度線」為基準（開窗至今應該用掉
// elapsed/7d × 100%）分三檔：
//   ok   — 用量在進度線內 → 快跑無妨
//   slow — 超線但不到一個日均量 → 退回一個 TTL 一步的慢節奏
//   off  — 超線一個日均量以上 → 暫停 AI 工作（只剩 "hi" 純保溫），別把週額度燒穿
// 資料缺失回 'unknown'（交由 5h 檔決策，維持既有行為）。
export function weeklyGate({ usedPct, resetsAt, nowSec, graceDays = 1 } = {}) {
  if (usedPct == null || resetsAt == null) return 'unknown';
  const WEEK = 7 * 86400;
  const elapsed = Math.min(Math.max(nowSec - (resetsAt - WEEK), 0), WEEK);
  const expectedPct = (elapsed / WEEK) * 100;
  const dailyPct = 100 / 7;
  if (usedPct >= expectedPct + graceDays * dailyPct) return 'off';
  if (usedPct > expectedPct) return 'slow';
  return 'ok';
}

// ---- 無人值守 AI 模式 ----
// 連續兩次注入之間完全沒有人為鍵盤輸入 → 判定無人值守，第三發起改敲「能與 AI 互動」
// 的訊息（續推任務/回報進度），而不是傻傻的 "hi"；使用者一敲鍵就歸零回到 "hi"。
//
// 人為輸入判斷分兩個世界：
// - Unix raw mode：純打字（含 Enter）不以 ESC 開頭；終端自動回報（DSR/DA 等 CSI 序列）
//   都以 ESC 開頭 → 「首位元組不是 ESC」即是人。方向鍵等 ESC 序列被漏算可接受。
// - Windows：node-pty 對真終端開 win32-input-mode（?9001h），**所有**按鍵都以
//   ESC[Vk;Sc;Uc;Kd;Cs;Rc_ 封包送達（首位元組必為 ESC）。此時要解封包：
//   key-down（Kd=1）且帶實際字元（Uc≠0）才算人——這樣終端合成的回報與 key-up 都不誤判。
const WIN32_INPUT_PACKET_RE = /\x1b\[([0-9;]*)_/g;
function* win32InputPackets(s) {
  WIN32_INPUT_PACKET_RE.lastIndex = 0;
  let m;
  while ((m = WIN32_INPUT_PACKET_RE.exec(s)) !== null) {
    const f = m[1].split(';').map((x) => Number(x || 0));
    yield { vk: f[0] || 0, sc: f[1] || 0, uc: f[2] || 0, kd: f[3] || 0, raw: m[0] };
  }
}

// Bracketed paste（\x1b[200~…\x1b[201~）一定是人為貼上——終端自動回報（DSR/DA 等）
// 不會用這個包法送達，故不論內容為何，含這對標記即視為人為輸入，讓 humanQuiet 正確
// 為「貼了草稿還沒送出」武裝，不會被開頭的 ESC 誤判成非人。
const BRACKETED_PASTE_RE = /\x1b\[20[01]~/;

export function looksLikeHumanInput(chunk) {
  if (!chunk || chunk.length === 0) return false;
  const s = typeof chunk === 'string' ? chunk : chunk.toString('latin1');
  if (BRACKETED_PASTE_RE.test(s)) return true;
  if (s.charCodeAt(0) !== 0x1b) return true;
  for (const p of win32InputPackets(s)) {
    if (p.kd === 1 && p.uc !== 0) return true; // win32-input-mode 的實際按鍵
  }
  return false;
}

// AI 模式切換熱鍵。預設 Ctrl+\（0x1C）——Ctrl+] 會被中文輸入法攔成全形】，故棄用；
// CWARM_TOGGLE_KEY 給單一字元（如 ']'、'\\'、'g'）換成 Ctrl+該鍵，再撞衝突不必改 code。
// 控制碼算法：字元碼 & 0x1F（']'→0x1D、'\'→0x1C、字母 g→0x07）。無效輸入回預設。
export function toggleKeySpec(ch) {
  const c = String(ch ?? '')[0] || '\\';
  const code = c.charCodeAt(0) & 0x1f;
  if (code < 1 || code > 31) return toggleKeySpec('\\');
  return { code, label: `Ctrl+${c.toUpperCase()}` };
}

// 熱鍵偵測 + 剝除（code = toggleKeySpec().code）。兩種形態，都要求「這個 chunk 恰好
// 就是熱鍵本身」才觸發，同一標準套用到 Windows：
// - Unix raw mode：裸控制位元組——**僅當 chunk 恰為單一位元組**才視為熱鍵；
//   貼上內容夾帶該位元組（log/CSV/條碼 dump）不得誤觸、更不得剝除毀損內容。
// - win32-input-mode：ConPTY 對真終端永遠開著，大量貼上內容也會被轉成逐字元封包——
//   若只挑出 Uc=code 的封包來剝除，貼上內容裡剛好含這個字元就會被誤觸且毀損。
//   故要求**整個 chunk 解出的封包全部都是該熱鍵**（單鍵的 down(+up)，至多 2 個
//   封包）才算熱鍵；只要混雜其他按鍵封包（含批次貼上），整包原樣放行、不觸發也不剝除。
// 回傳 { toggled, rest }：rest 為應轉送給 claude 的剩餘位元組。
export function extractAiToggle(chunk, code = 0x1c) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
  if (buf.length === 1 && buf[0] === code) return { toggled: true, rest: Buffer.alloc(0) };
  const s = buf.toString('latin1');
  if (!/^(?:\x1b\[[0-9;]*_)+$/.test(s)) return { toggled: false, rest: buf };
  const packets = [...win32InputPackets(s)];
  if (packets.length > 0 && packets.every((p) => p.uc === code)) {
    return { toggled: packets.some((p) => p.kd === 1), rest: Buffer.alloc(0) };
  }
  return { toggled: false, rest: buf }; // 混雜其他按鍵/批次貼上 → 一律原樣放行
}

// humanQuiet 門檻不得吃掉「提早注入」的保命餘裕：short 檔 idleThreshold 240s 就是為了
// 趕在 300s TTL 前 60s 注入，若 humanQuiet 比它還長，注入會被拖到 cache 冷掉之後。
// 故上限鉗在 idleThreshold - 60s（不足時歸零，等同不套用）。
export function clampHumanQuiet(humanQuietMs, idleThresholdS) {
  return Math.min(humanQuietMs, Math.max(0, idleThresholdS * 1000 - 60_000));
}

// 這一發該敲什麼：reset 後續跑 > 無人值守 AI 訊息 > 一般 "hi"。
// aiMsg 可以是字串（固定一句）或陣列（循環工作流：第 3 發起依序輪替，如
// review → critical review → 保守建議 → 依建議執行 → 回到 review …）。
// aiAllowed=false（如週配速 'off'）時即使無人值守也只敲一般 "hi"，暫停 AI 工作。
// aiStep（獨立於 consecInjects 的循環位置計數）：consecInjects 統計「連續注入次數」，
// 用來判定是否進入無人值守（≥2），但暫停期間送出的普通 "hi" 也會讓它累加——若拿它直接
// 當循環索引，暫停後恢復會整段跳號、破壞步驟間的依賴（如「依建議執行」承接前一步的發現）。
// 故循環位置改用呼叫端維護、只在真的敲出 AI 循環訊息時才遞增的 aiStep。
// briefing：每輪無人值守的第一步（aiStep===0）附加一次性說明，讓被驅動的 Claude 知道自己
// 在被 cwarm 自動驅動、規則是什麼（見 host.mjs 的 AI_BRIEFING）；同一輪其餘步驟不重複附加。
// 只在真的選中陣列循環的第一格時才附加——固定字串 aiMsg（CWARM_AI_MSG）或非陣列不適用。
export function pickInjectMsg({ pendingResume, consecInjects, aiStep = 0, resumeMsg, aiMsg, msg, aiAllowed = true, briefing = null }) {
  if (pendingResume) return resumeMsg;
  if (consecInjects >= 2 && aiAllowed) {
    if (Array.isArray(aiMsg)) {
      const step = aiMsg[aiStep % aiMsg.length];
      return briefing && aiStep === 0 ? `${briefing} ${step}` : step;
    }
    return aiMsg;
  }
  return msg;
}

// 無人值守 AI 模式的節奏：保溫節奏（一個 TTL 一發）是為省注入次數設計的，但 AI 模式
// 的目標是推進工作——十分鐘做完一步不該空等五十分鐘。故額度充裕時改用快節奏
//（paceS，預設 5 分鐘：transcript 靜止 + 冷卻都縮短到 paceS），下列任一條件則退回
// 原節奏：尚未進入 AI 模式、無橋接資料（保守）、用量 ≥ fastMaxPct、或額度狀態非
// normal（warn/limited/reset 自有其處理）。快節奏注入間隔遠小於 TTL，cache 恆熱。
// weekly（weeklyGate 結果）：'slow'/'off' 都不快跑；'unknown' 交由 5h 條件決定。
// enabled=false（未開 --ai/CWARM_AI，純保溫使用者）時永遠維持原節奏。
export function aiPacing({ enabled = true, consecInjects, usedPct, ustate, weekly = 'unknown', ttl, idleThreshold, paceS = 300, fastMaxPct = 70 }) {
  const fast = enabled
    && consecInjects >= 2
    && usedPct != null && usedPct < fastMaxPct
    && ustate === 'normal'
    && (weekly === 'ok' || weekly === 'unknown');
  if (!fast) return { ttl, idleThreshold };
  return { ttl: Math.min(ttl, paceS), idleThreshold: Math.min(idleThreshold, paceS) };
}

// ---- AI 模式開關狀態檔（host ↔ statusline 溝通用）----
// host 在啟動、每個 tick、與 Ctrl+] 切換時寫入 {enabled, ts}；statusline 讀取顯示
// 開關狀態與熱鍵提示。ts 同時是心跳——太舊代表沒有 cwarm host 在跑（或已退出），
// statusline 就不顯示這一段（避免殘留假狀態）。
// 以 cwd 編碼進檔名（cwarm-ai-<proj>.json）：多個 cwarm host 並行時各寫各的，
// statusline 用 payload 的 cwd 對回自己那份，不會 last-writer-wins 互蓋。
export function aiStatePath(claudeDir, cwd) {
  return path.join(claudeDir, `cwarm-ai-${cwdKey(cwd)}.json`);
}

// AI 模式開機初值：--ai 旗標 > CWARM_AI 環境變數（=0/off 可強制關）> 上次持久化狀態
//（同一個 per-cwd 狀態檔、忽略心跳時效——Ctrl+\ 切過的選擇跨重啟記住）> 預設關。
export function initialAiEnabled({ flagAi, envAi, persisted } = {}) {
  if (flagAi === true) return true;
  if (envAi != null && envAi !== '') return /^(1|on|true|yes)$/i.test(String(envAi));
  return !!(persisted && persisted.enabled);
}

export function readAiState(claudeDir, cwd, { maxAgeMs = 60_000, now = Date.now() } = {}) {
  const o = readJsonSafe(aiStatePath(claudeDir, cwd));
  if (!o || typeof o !== 'object' || o.ts == null) return null;
  if (now - o.ts > maxAgeMs) return null;
  return { enabled: !!o.enabled, key: typeof o.key === 'string' ? o.key : null };
}

// 讀自訂無人值守指令檔（CWARM_AI_MSG_FILE）：一行一條指令、# 開頭與空行忽略。
// 內建循環是軟體工程導向的；其他領域（寫作/研究/翻譯…）用這個換掉整套。
// 檔案不存在或沒有有效行 → null（回退內建循環）。
export function readAiMsgFile(p) {
  if (!p) return null;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去掉 UTF-8 BOM（Windows Notepad 常見），
  // 否則第一行的 '#' 判斷會被隱形的 BOM 字元擋掉，該行不被當註解、悄悄混進指令循環。
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  return lines.length ? lines : null;
}

// 純決策：現在該不該注入 keepalive？idleMs = 距上次訊息多久（由 transcriptIdleMs 算）。
// screenIdleMs = 距 claude 最近一次「畫面輸出」多久；quietMs = 需靜止多久才放行。
// 為什麼要這個畫面靜默門檻：transcript 在「等你回答必答提示（權限/選單/計畫批准）」與
// 「跑長工具/生成中」時都不會更新，光看 idleMs 無法分辨這兩種「忙/卡」狀態與「真的閒置在輸入框」。
// 但畫面活動可以：閒置在輸入框時畫面靜止；提示等待時 spinner 在動、生成中持續輸出。
// 故只有畫面靜止夠久才注入——避免把 hi 的 Enter 送進 modal 誤選預設項，也避免打斷長工具執行。
// quietMs 省略（null）時不套此門檻（保持純 idle 決策，供既有測試/呼叫者使用）。
// humanIdleMs/humanQuietMs：距使用者最後一次敲鍵多久／需靜多久才放行。打字中途停下來
// 想事情（畫面靜止 >quietMs）不代表人不在——半句草稿 + "hi" + Enter 一起送出就是事故。
// 故人剛敲過鍵（預設 5 分鐘內）一律不注入；null 不套用（相容既有呼叫者）。
export function decideInject({ now, idleMs, lastFire, idleThreshold, ttl, disabled, screenIdleMs, quietMs, humanIdleMs, humanQuietMs }) {
  if (disabled) return false;                          // 暫停開關
  if (idleMs == null) return false;                    // 找不到 transcript → 保守不發
  if (idleMs < idleThreshold * 1000) return false;     // 距上次訊息還不夠久
  if (now - lastFire < ttl * 1000) return false;       // 冷卻未滿一個 TTL
  if (quietMs != null && screenIdleMs != null && screenIdleMs < quietMs) return false; // 畫面還在動（提示/生成/打字中）
  if (humanQuietMs != null && humanIdleMs != null && humanIdleMs < humanQuietMs) return false; // 人剛敲過鍵（可能在打字）
  return true;
}

// 畫面上是否正顯示 Claude Code 的「資料夾信任」對話框（"Do you trust the files in this folder?"）。
// 保溫的「Esc 先行」是用來收掉一般必答 modal（權限/選單/計畫批准），但信任框特殊：被 Esc 掉會在
// ~/.claude.json 寫下 hasTrustDialogAccepted:false，使該資料夾的 .claude/settings.local.json 權限
// 整批失效、且之後不再自動跳框。這種框只能由使用者本人回答——偵測到就整輪跳過注入（連 Esc 都不送）。
// 傳入的是原始終端輸出（含 ANSI），先剝掉控制序列再比對，避免顏色/游標碼把字拆開。
const TRUST_PROMPT_RE = /trust\s+the\s+files\s+in\s+this\s+(?:folder|workspace)/i;
export function looksLikeTrustPrompt(screenText) {
  if (!screenText) return false;
  const plain = String(screenText)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')  // OSC …（BEL 或 ST 結尾）
    .replace(/\x1b[@-Z\\-_]/g, ' ')                       // 兩位元組跳脫
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ' ')          // CSI（顏色/游標）
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');           // 其餘控制碼 → 空白
  return TRUST_PROMPT_RE.test(plain);
}
