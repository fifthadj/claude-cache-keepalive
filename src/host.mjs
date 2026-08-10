// host.mjs — 把 claude 跑在自己控制的 PTY 裡，做透明 I/O 多工 + 內建 prompt cache 保溫。
//   注入是行程內部的 pty.write，與視窗焦點/縮小無關；只要 host 行程活著就保溫。
//   跨平台：靠 node-pty（Windows=ConPTY、mac/Linux=forkpty），不需 tmux。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultClaudeDir, regimeParams, detectTtlRegime, decideInject, transcriptIdleMs, looksLikeTrustPrompt, detectBillingMode, readUsageBridge, usageState, looksLikeHumanInput, pickInjectMsg, aiPacing, weeklyGate, readAiMsgFile, aiStatePath, extractAiToggle, clampHumanQuiet, toggleKeySpec, readAiState, initialAiEnabled } from './keepalive.mjs';

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

// 讀數字型環境變數：空/未設回 def；非數字（如打錯成 "5m"）回 def 並記警告（不可靜默失效
// 掉安全機制，如 CWARM_HUMAN_QUIET_S 打錯字就悄悄關掉打字防護）；用 isFinite 而非 `|| def`，
// 讓合法的 "0"（如使用者故意要 CWARM_AI_FAST_PCT=0 關閉快節奏）不會被 falsy 誤當未設定。
function envNumber(name, def, log) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (log) { try { fs.appendFileSync(log, `${new Date().toISOString()} warn: ${name}=${JSON.stringify(raw)} is not a number, using default ${def}\n`); } catch {} }
    return def;
  }
  return n;
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

  // 完全透傳：cwarm [args] === claude [args]。不帶參數就是乾淨的 `claude`（全新 session）；
  // 要接續上次請自己打 `cwarm --continue`。不再隱含補 --continue。
  const args = opts.args || [];
  const { file, args: spawnArgs } = spawnSpec(resolveClaude(), args);

  // 固定取一次 cwd，全程共用（host 不會 chdir）：writeAiState/usage bridge/transcript 查找
  // 都用同一個值，避免不同時間點呼叫 process.cwd() 理論上不一致、間接影響 cwdKey 對應。
  const hostCwd = process.cwd();
  const ptyProc = pty.spawn(file, spawnArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: hostCwd,
    env: process.env,
  });

  // ---- 透明 I/O 多工 ----
  // 直接寫 Buffer（純位元組轉送）：UTF-8 多位元組（中文等）才不會被重編碼弄壞。
  // 注意：閒置判斷改看 transcript mtime（距上次「訊息」多久），不再用 stdin 計時——
  // 終端輸入（捲動／讀回覆／打到一半沒送出）不會刷新 cache，拿來計時會誤判成「使用者還在忙」。
  if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
  process.stdin.resume();
  // 無人值守 AI 模式總開關：預設關（其他使用者多半只要純保溫）。
  // 開法三種：`cwarm --ai`、CWARM_AI=1、或執行中按熱鍵隨時切換——預設 Ctrl+\
  //（Ctrl+] 會被中文輸入法攔成全形】），CWARM_TOGGLE_KEY 可換；
  //（Unix=裸控制位元組、Windows=win32-input-mode 封包，偵測與剝除都在 extractAiToggle）。
  // 狀態寫進 cwarm-ai-<cwd>.json（含 ts 心跳、per-cwd 檔名——多 host 並行不互蓋、
  // key=熱鍵標籤供 statusline 顯示提示），statusline 用 payload 的 cwd 對回同一份。
  // 初值持久化：Ctrl+\ 切過的狀態記在 per-cwd 狀態檔，重啟沿用（--ai / CWARM_AI 可覆蓋）。
  let aiEnabled = initialAiEnabled({
    flagAi: opts.ai,
    envAi: process.env.CWARM_AI,
    persisted: readAiState(claudeDir, hostCwd, { maxAgeMs: Infinity }),
  });
  const toggleKey = toggleKeySpec(process.env.CWARM_TOGGLE_KEY);
  function writeAiState() {
    try { fs.writeFileSync(aiStatePath(claudeDir, hostCwd), JSON.stringify({ enabled: aiEnabled, ts: Date.now(), key: toggleKey.label })); } catch {}
  }
  writeAiState();

  // consecInjects：連續注入計數（無人值守偵測用）。人一敲鍵就歸零；判斷含 win32-input-mode
  // 封包解析（Windows 所有按鍵都以 ESC[..._ 封包送達，不能用「非 ESC 開頭」判人）。
  // lastHumanMs：使用者最後一次敲鍵時刻——敲鍵後一段時間內（humanQuietMs）絕不注入，
  // 避免把打到一半的草稿連同 "hi" 一起 Enter 送出。
  // aiStep：無人值守 18 階段循環的實際位置，只在真的敲出 AI 循環訊息時遞增（見下方 tick）。
  // 與 consecInjects 分開維護：consecInjects 只用來判定「是否已無人值守」，暫停期間
  // 送出的普通 "hi" 仍會累加它——若拿它直接當循環索引，暫停恢復後會整段跳號。
  let consecInjects = 0;
  let aiStep = 0;
  let lastHumanMs = 0;
  process.stdin.on('data', (d) => {
    const { toggled, rest } = extractAiToggle(d, toggleKey.code);
    if (toggled) {
      aiEnabled = !aiEnabled;
      writeAiState();
      consecInjects = 0;
      aiStep = 0;
      lastHumanMs = Date.now(); // 按熱鍵也是人為活動
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} ai mode ${aiEnabled ? 'ON' : 'OFF'} (${toggleKey.label} toggle)\n`); } catch {}
    }
    if (rest.length === 0) return;
    if (looksLikeHumanInput(rest)) { consecInjects = 0; aiStep = 0; lastHumanMs = Date.now(); }
    ptyProc.write(rest);
  });
  // 追蹤 claude 最近一次有輸出到畫面的時刻：閒置在輸入框時畫面靜止；提示等待回答時 spinner 在動、
  // 生成/跑工具時持續輸出。注入前要求畫面已靜止一段時間（見下方 quietMs），就能避開「忙/卡」狀態。
  let lastOutputMs = Date.now();
  // 保留最近一小段螢幕輸出（含 ANSI），供偵測「資料夾信任」對話框用：那個框被保溫 Esc 掉會留下
  // hasTrustDialogAccepted:false，害該資料夾 settings.local.json 權限整批失效，故它在畫面上時整輪不注入。
  let screenBuf = '';
  ptyProc.onData((d) => {
    lastOutputMs = Date.now();
    process.stdout.write(d);
    screenBuf = (screenBuf + d.toString('utf8')).slice(-8192);
  });
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

  // reset 後的回溫訊息："go on"（續跑任務）也算 AI 自主行為，未開 AI 模式時只補一般訊息回溫。
  // 做成函式：Ctrl+] 隨時切換 aiEnabled，用時才取值。
  const resumeMsg = () => process.env.CWARM_RESUME_MSG || (aiEnabled ? 'go on' : msg);
  // 無人值守 AI 模式：連兩發 "hi" 都沒人碰鍵盤後，第三發起改敲 12 階段循環工作流，
  // 讓閒置視窗產生實際價值。設計原則：每步「安全、有界、可驗證」——檢視類在前、
  // 執行類帶安全閥（不可部署、不可破壞性操作、不可展開大型新工作，對齊全域 SOP）、
  // 末段自我迭代與收尾報告，使用者回來直接驗收。CWARM_AI_MSG 可覆蓋成固定一句
  //（設成 "hi" 即等於關掉本模式）。1h 檔位一步一小時，一輪約半天。
  // 指令用英文（注入訊息本來就是 hi / go on 一路英文，且較省 token）；回覆語言由使用者的
  // CLAUDE.md 控制，不受注入語言影響。18 階段中文對照：
  // 檢視段：review → 批判 review → TODO/FIXME 掃描 → 保守建議
  // 執行段：依建議執行 → 測試覆蓋 → mutation check（測試有效性）→ 錯誤處理稽核 →
  //         資安自查 → 相依套件體檢（只報告不升級）→ 效能低垂果實 → 小步重構 → 跨平台審視
  // 收斂段：文件同步 → README 快速上手驗證 → 對照方案探索（防路徑依賴）→
  //         經驗蒸餾（寫進 memory/CLAUDE.md，複利最高）→ 收尾報告＋決策佇列（睡醒五分鐘拍板解鎖下一天）
  // 指令來源優先序：CWARM_AI_MSG（固定一句）> CWARM_AI_MSG_FILE（自訂循環，一行一條）> 內建循環。
  const aiMsg = process.env.CWARM_AI_MSG
    || readAiMsgFile(process.env.CWARM_AI_MSG_FILE)
    || [
    'Unattended: review the work done in this session; briefly list problems and possible improvements.',
    'Unattended: critical review — challenge earlier assumptions and approaches; point out risks, blind spots, and missing test scenarios.',
    'Unattended: sweep the code for TODO / FIXME / HACK markers; triage into quick-fix / should-fix / ignore, and fix the quick ones.',
    'Unattended: based on the findings above, propose a conservative, low-risk improvement list with priorities.',
    'Unattended: execute the safest suggested items one by one, verifying each. No deploys, no destructive operations, no large new work.',
    'Unattended: check test coverage — find uncovered branches and edge cases, add the needed tests, run the full suite.',
    'Unattended: mutation check — mentally (or on a scratch copy) break one small piece of logic and verify existing tests would catch it; where they would not, that coverage is fake — add a real test.',
    'Unattended: audit error handling — walk the failure paths (bad input, missing files, timeouts, permissions); patch gaps minimally, with tests.',
    'Unattended: light security self-check — leaked secrets in code/logs, injection risks, over-broad permissions; fix only clear issues.',
    'Unattended: dependency health check — outdated or vulnerable dependencies (e.g. npm outdated / npm audit); report findings only, do not upgrade.',
    'Unattended: performance pass — find low-hanging fruit (repeated IO, needless polling, cacheable recomputation); small certain wins only, no big refactors.',
    'Unattended: small refactors — naming, duplication, readability; behavior must not change, tests guard every step.',
    'Unattended: cross-platform review — check assumptions about paths, line endings, shells and permissions across Windows/macOS/Linux; list suspicious spots and add guards where clearly needed.',
    'Unattended: sync docs — check README, comments and usage notes against reality; update stale parts, fill gaps.',
    'Unattended: verify the README quickstart — follow the install/usage steps literally from scratch and note where documentation and reality diverge; fix the docs.',
    "Unattended: devil's advocate — pick one design decision made in this session, seriously sketch a different approach, compare trade-offs, and conclude; analysis only, no code changes.",
    'Unattended: distill lessons — write the non-obvious, durable lessons from this session into project memory / CLAUDE.md so every future session benefits; skip anything already recorded.',
    'Unattended: wrap up — write a concise report of all changes and open items, plus a decision queue: questions only the user can answer, each with context, options, and your recommendation.',
  ];
  // 無人值守循環第一步附帶一次性簡報：被驅動的 Claude 本身看不到 cwarm 的原始碼與這段機制，
  // 光靠 "Unattended: review …" 猜不出「為什麼會收到這句」「還會不會繼續來」「額度用完會
  // 怎樣」「使用者真的回來打字算不算數」。實際判斷（只在陣列循環剛回到第 0 步時附加一次，
  // 不是每步都附）交給 pickInjectMsg（keepalive.mjs）——那裡才有 aiStep/aiMsg 的完整脈絡，
  // 這裡只需把說明文字傳進去；CWARM_AI_MSG（固定一句）情境自動不適用（非陣列）。
  const AI_BRIEFING = "Unattended: heads up — cwarm's AI mode is now driving this session on its own. "
    + 'Whenever this terminal sits idle past a threshold with no human keystrokes, it injects one instruction '
    + "like this automatically, cycling through a fixed checklist (review, tests, docs, refactors, …); it's not "
    + "you deciding to keep going, it's the tool. Pace is quota-aware — faster when there's headroom, paused near "
    + "your usage limit and resumed with a plain 'go on' once it resets. If real human input ever shows up in this "
    + 'session, that always takes priority over anything below. Stay conservative: no deploys, no destructive '
    + 'operations, no large new scope — verify each step before moving to the next.';
  // 使用者敲鍵後需靜默這麼久才可注入（預設 5 分鐘）。CWARM_HUMAN_QUIET_S 可調；
  // 打錯成非數字（如 "5m"）會記警告並退回預設，不會悄悄關掉這個安全機制。
  const humanQuietMs = envNumber('CWARM_HUMAN_QUIET_S', 300, LOG) * 1000;
  // startedMs：只認啟動後有寫入的 transcript（Context 0% 不保溫；見 transcriptIdleMs 註解）。
  // lastFire 也從啟動起算當第二道保險：即使第一句話立刻寫入，仍需滿一個冷卻週期才可能注入。
  const startedMs = Date.now();
  let lastFire = startedMs;
  let trustGuardLogged = false;
  let creditsGuardLogged = false;
  // 額度視窗狀態：撞牆時記下 resets_at 並暫停注入；reset 過後第一發改敲 resumeMsg
  //（"go on"）——既回溫 cache，又讓被額度打斷的任務自動續跑。資料來自 statusline
  // 落地的橋接檔（cwarm-usage.json）；95% 提醒由 statusline 顯示，host 不改行為（照用 "hi"）。
  let limitResetsAt = null;
  let pendingResume = false;
  let limitLogged = false;
  let noUsageWarned = false; // --ai 但讀不到額度橋接檔時警告一次（額度閘門全數失效）
  let noTranscriptWarned = false; // 啟動夠久了還是找不到本專案 transcript，警告一次（診斷路徑不符等問題）
  const timer = setInterval(() => {
    writeAiState(); // 心跳：statusline 靠 ts 新鮮度判斷 host 還活著才顯示開關段
    // credits / API 計費（/login 切到 Console 帳號、或只用 ANTHROPIC_API_KEY）時，每次注入
    // 都是實際花錢，保溫沒有意義 → 自動暫停。每個 tick 重新偵測，session 中 /login 切回
    // 訂閱帳號會自動恢復保溫。要強制指定：CWARM_BILLING=subscription|credits。
    const billing = detectBillingMode(claudeDir);
    if (billing === 'credits') {
      if (!creditsGuardLogged) {
        creditsGuardLogged = true;
        try { fs.appendFileSync(LOG, `${new Date().toISOString()} skip: credits/API billing detected — keepalive suspended (CWARM_BILLING=subscription to override)\n`); } catch {}
      }
      return;
    }
    if (creditsGuardLogged) {
      creditsGuardLogged = false;
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} resume: subscription billing detected — keepalive re-enabled\n`); } catch {}
    }
    // 信任對話框在畫面上時，這輪完全不動作（連 Esc 都不送）——那是使用者本人該回答的框，被保溫
    // Esc 掉會留下 hasTrustDialogAccepted:false，害該資料夾 settings.local.json 權限失效、之後不再跳框。
    if (looksLikeTrustPrompt(screenBuf)) {
      if (!trustGuardLogged) {
        trustGuardLogged = true;
        try { fs.appendFileSync(LOG, `${new Date().toISOString()} skip: trust dialog on screen — left for the user to answer\n`); } catch {}
      }
      return;
    }
    trustGuardLogged = false;
    // ---- 額度視窗（5h window）----
    // 以 hostCwd 為鍵：不同帳號/專案的並行 host 各讀各的橋接檔，不會互相覆蓋額度視窗。
    const usage = readUsageBridge(claudeDir, hostCwd);
    // AI 模式的撞牆偵測/週配速/reset 續跑全靠 statusline 落地的橋接檔；沒裝 statusline
    //（cwarm setup）或 payload 沒有 rate_limits 時所有閘門都是 unknown——明講，別靜默裸奔。
    if (aiEnabled && usage == null && !noUsageWarned) {
      noUsageWarned = true;
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} warn: ai mode has no usage data (run \`cwarm setup\` to install the statusline bridge) — quota gates inactive\n`); } catch {}
    }
    if (usage != null) noUsageWarned = false;
    const nowSec = Date.now() / 1000;
    const ustate = usage ? usageState({ usedPct: usage.usedPct, resetsAt: usage.resetsAt, nowSec }) : 'unknown';
    if (ustate === 'limited') {
      limitResetsAt = usage.resetsAt;
      if (!limitLogged) {
        limitLogged = true;
        try { fs.appendFileSync(LOG, `${new Date().toISOString()} skip: usage limit reached (${Math.round(usage.usedPct)}%) — waiting for reset at ${new Date(usage.resetsAt * 1000).toISOString()}\n`); } catch {}
      }
      return; // 撞牆期間注入到不了伺服器，暫停等 reset
    }
    if (limitResetsAt != null && nowSec > limitResetsAt) {
      limitResetsAt = null;
      limitLogged = false;
      pendingResume = true; // 視窗已重置：下一發改敲 resumeMsg，回溫 cache 兼續跑被打斷的任務
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} window reset — next inject will send "${resumeMsg()}"\n`); } catch {}
    }
    const regime = detectTtlRegime(claudeDir, hostCwd);        // 從 transcript 實測 1h/5m，不再猜方案
    // 週配速：7 天視窗以日均（100/7 ≈ 14.3%/天）攤出進度線，ok=可快跑、slow=退回
    // 一個 TTL 一步、off=超線一天日均以上 → 暫停 AI 工作只剩純保溫 "hi"。
    const wgate = weeklyGate({
      usedPct: usage ? usage.weekPct : null,
      resetsAt: usage ? usage.weekResetsAt : null,
      nowSec,
    });
    // AI 模式且額度充裕（5h < CWARM_AI_FAST_PCT 預設 70%，且週配速在線內）時改快節奏
    //（CWARM_AI_PACE_S，預設 5 分），讓 12 階段循環按完工速度推進而不是空等 TTL。
    const { ttl, idleThreshold } = aiPacing({
      enabled: aiEnabled,
      consecInjects,
      usedPct: usage ? usage.usedPct : null,
      ustate,
      weekly: wgate,
      ...regimeParams(regime, overrides),
      paceS: envNumber('CWARM_AI_PACE_S', 300, LOG),
      fastMaxPct: envNumber('CWARM_AI_FAST_PCT', 70, LOG),
    });
    const now = Date.now();
    const idleMs = transcriptIdleMs(claudeDir, hostCwd, now, startedMs);
    // idleMs 找不到 transcript 時保溫整個靜默失效，且原本沒有任何提示——啟動超過 2 分鐘
    // （早期本來就會是 null，Context 0% 正常現象，不必吵）仍找不到才警告一次，提示可能是
    // cwd 與 Claude Code 建立的 transcript 資料夾對不上（磁碟代號大小寫、junction 等）。
    if (idleMs == null) {
      if (!noTranscriptWarned && now - startedMs > 120_000) {
        noTranscriptWarned = true;
        try { fs.appendFileSync(LOG, `${new Date().toISOString()} warn: no transcript found for this project after 2min — keepalive inactive (check for a cwd / drive-letter mismatch against Claude Code's project folder)\n`); } catch {}
      }
    } else if (noTranscriptWarned) {
      noTranscriptWarned = false;
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} resume: transcript found — keepalive active\n`); } catch {}
    }
    const screenIdleMs = now - lastOutputMs;
    // reset 後若使用者自己先回來發了訊息（transcript 剛更新過），就不必再補 "go on"
    if (pendingResume && idleMs != null && idleMs < 60_000) {
      pendingResume = false;
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} resume skipped — user already active after reset\n`); } catch {}
    }
    const humanIdleMs = now - lastHumanMs;
    // humanQuiet 鉗在 idleThreshold-60s 內：short 檔（TTL 300s/門檻 240s）若照吃 300s
    // 靜默，注入會落在 cache 冷掉之後——保命的提早注入餘裕不能被這個門檻吃掉。
    const hqMs = clampHumanQuiet(humanQuietMs, idleThreshold);
    if (decideInject({ now, idleMs, lastFire, idleThreshold, ttl, disabled: fs.existsSync(DISABLE), screenIdleMs, quietMs, humanIdleMs, humanQuietMs: hqMs })) {
      // 先送 Esc：把任何「必答」modal（權限/選單/計畫批准）收掉、退回輸入框，後面那個 Enter 才不會誤選預設項；
      // 空輸入框時 Esc 等同 no-op。隔一小段再送訊息——讓 claude 先把 modal 收乾淨，也避免 ESC 與字元被併成 Meta 鍵。
      const aiAllowed = aiEnabled && wgate !== 'off';
      const injectMsg = pickInjectMsg({ pendingResume, consecInjects, aiStep, resumeMsg: resumeMsg(), aiMsg, msg, aiAllowed, briefing: AI_BRIEFING });
      // 只有真的敲出 AI 循環裡的一步才推進 aiStep；被 wgate='off' 等閘門擋下、退回一般
      // "hi" 或 resume 的那些發送不算，避免恢復後循環整段跳號（見上方 aiStep 宣告的說明）。
      const firedAiStep = !pendingResume && consecInjects >= 2 && aiAllowed && Array.isArray(aiMsg);
      pendingResume = false;
      consecInjects++;
      if (firedAiStep) aiStep++;
      ptyProc.write('\x1b');
      lastFire = now;
      setTimeout(() => { if (!exiting) { try { ptyProc.write(injectMsg + '\r'); } catch {} } }, escDelayMs);
      const idle = idleMs == null ? -1 : Math.round(idleMs / 1000);
      const msgLabel = injectMsg.length > 24 ? `${injectMsg.slice(0, 24)}…` : injectMsg;
      try { fs.appendFileSync(LOG, `${new Date().toISOString()} inject "${msgLabel}" regime=${regime ?? 'unknown'} idle=${idle}s screenIdle=${Math.round(screenIdleMs / 1000)}s consec=${consecInjects} aiStep=${aiStep} weekly=${wgate}\n`); } catch {}
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
