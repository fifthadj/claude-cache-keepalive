# claude-cache-keepalive (`cwarm`)

[![CI](https://github.com/fifthadj/claude-cache-keepalive/actions/workflows/test.yml/badge.svg)](https://github.com/fifthadj/claude-cache-keepalive/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/claude-cache-keepalive.svg)](https://www.npmjs.com/package/claude-cache-keepalive)
[![license: MIT](https://img.shields.io/npm/l/claude-cache-keepalive.svg)](./LICENSE)

Keep [Claude Code](https://claude.com/claude-code)'s **prompt cache warm while you're idle**, so coming back to a session you stepped away from doesn't pay a full cache‑miss.

It runs `claude` inside a PTY it controls (via [node-pty](https://github.com/microsoft/node-pty)) and, when you've been idle past your cache's TTL, injects a tiny keepalive so the cache stays warm. Because injection is an in‑process PTY write, **it keeps working when the window is unfocused, minimized, or in the background** — only closing the window stops it.

Cross‑platform, **no tmux required**. This is the missing piece for setups (Windows / Git Bash, plain terminals) where the usual tmux‑based keepalive isn't available.

> ⚠️ **Honest note — this uses your usage/quota.** Keeping the cache warm means sending a small message (`hi`) when you go idle, which counts against your plan usage and leaves `hi` turns in the conversation. It only fires after a long idle (≈58 min on a 1‑hour cache, ≈4 min on a 5‑minute cache) with a one‑TTL cooldown, so it's conservative — but it is opt‑in by design. If that trade‑off isn't for you, don't use it.

## Install

```sh
npm install -g claude-cache-keepalive
```

This puts a `cwarm` command on your PATH (npm creates both the Unix and Windows shims automatically).

## Usage

```sh
cwarm                 # = plain `claude`, inside the keepalive host (no implicit --continue)
cwarm --continue      # resume your last session; any claude args pass straight through
cwarm resume
cwarm -p "..."
cwarm --version       # (passed through → prints claude's version)
cwarm help            # cwarm's own help
```

It's transparent — type and use claude exactly as normal (no `Ctrl-b` prefix, no new keys). Exit claude (`/exit` or Ctrl‑C) and the host exits with it.

**Pause keepalive:** `touch ~/.claude/cwarm.disabled` (delete to resume).
**Log:** `~/.claude/cwarm-keepalive.log`.

## How it works

- **PTY host** — `cwarm` spawns `claude` inside a pseudo‑terminal it owns and transparently pipes your keyboard ↔ claude ↔ screen (and window resizes). This is the same approach tmux / expect / VS Code's terminal use, and the only robust way to inject input into a terminal program.
- **Idle detection** — idle = time since your last **message**, measured from this session's transcript file under `~/.claude/projects/`. This is what actually governs cache age: scrolling, arrow‑key reading, or a half‑typed prompt are terminal input but don't refresh the cache, so they must *not* count as activity. (Earlier versions timed keystrokes, which let the cache go cold while you were reading.) With the statusline add‑on installed (`cwarm setup`), the host **pins its own session's transcript** via a tiny per‑session bridge file (`~/.claude/cwarm-session-<id>.json`, written from the statusline's `transcript_path`, removed on exit) — so several tabs running sessions in the *same folder* no longer confuse each other. Without the statusline it falls back to "newest transcript in this project's folder".
- **TTL‑aware (measured, not guessed)** — the cache TTL is read straight from the transcript's `message.usage.cache_creation`, not inferred from your subscription:
  - any recent turn wrote `ephemeral_1h_input_tokens` → **1 h cache** → inject after ~58 min idle, cooldown 1 h.
  - only `ephemeral_5m_input_tokens` (or no evidence yet) → **5 min cache** (conservative) → inject after ~4 min idle, cooldown 5 min.
  - This survives client‑version, env‑var and server‑flag changes that the plan string can't see (e.g. a Pro account can still get a 1 h cache).
- **Prompt‑safe injection** — the keepalive only fires once the PTY has been **silent for a moment** (`CWARM_QUIET_MS`, default 2.5 s). A mandatory prompt (tool‑permission, `AskUserQuestion`, plan approval) keeps animating its spinner, and a busy tool‑run keeps streaming output — both are "not silent", so the keepalive won't fire into them (no accidental menu‑default selection, no interrupting a long tool‑run). And when it does fire it's **`Esc`‑prefixed**: it backs out to the input box first, so the keepalive's Enter can never land on a prompt and auto‑select. (While a prompt is genuinely blocking, the cache can't be kept warm regardless — no API turn can happen until you answer — so it simply resumes once you do.)
- **Focus/minimize independent** — injection is an in‑process `pty.write`, unrelated to window state. Only closing the window (ending the host process) stops it.

## Optional: cache‑countdown statusline

A small statusline add‑on shows the live countdown the keepalive is protecting:

```
[Opus 4.8] │ my-project │ ♻️ cache 58m12s
```

It's **opt‑in** and never clobbers your existing statusline — it **wraps** it (runs yours, then appends the `♻️ cache …` segment), backs up `settings.json` first, and is fully restorable:

```sh
cwarm setup            # interactive; asks before editing settings.json
cwarm setup --remove   # restores your previous statusline
```

(Written in Node — no Python dependency, no Windows codepage issues.)

### Quota segments

Once you run `cwarm setup`, the statusline also surfaces two quota warnings sourced straight from Claude Code's own `rate_limits` payload — no extra config needed:

```
⚠️ 96%、離reset還2h，建議暫停 │ 🔴 週超前15.0%，剩3.5d均10.0%/天，休息21.8h回綠
```

- **5-hour window** — once usage crosses 95% *and* the reset is still more than an hour away, an `⚠️ NN%、離reset還Nh，建議暫停` warning appears suggesting you pause. Nothing shows below 95%, or once you're within an hour of reset (the tail is going to burn either way).
- **7-day window** — a colored ball tracks how far ahead of a straight-line pace budget (100%/7 ≈ 14.3%/day) you're running: 🟢 under 2 points ahead (or behind), a quiet 2-3 point gap with no ball, 🟡 3-5, 🟠 6-8, 🩷 9-11 (no pink circle emoji exists, so it borrows the pink heart), 🔴 12+. Next to the ball: how many days are left in the window, the average %/day you can still spend if usage stays flat for the rest of it, and — once you're more than 2 points ahead — how long you'd need to rest (no further usage) before the pace line catches up and the ball turns green again.

Both segments are pure display; they never stop the keepalive from firing. `--ai` mode reads the same underlying numbers to actually throttle itself (see below).

## Unattended AI mode (opt-in, off by default)

Plain keepalive only sends `hi` — harmless, but it doesn't make idle time *useful*. `--ai` mode does: once cwarm decides you've genuinely stepped away, instead of `hi` it starts feeding Claude a repeating checklist of safe, self-verifying work (review the session, sweep for TODOs, add missing tests, sync docs, distill lessons into memory, …), so idle windows turn into progress instead of dead air.

### How it decides "you're gone"

- Two consecutive keepalive pings pass with **zero human keystrokes** in between → the third one switches from `hi` to the first step of the work cycle.
- Typing anything — even a single keystroke — resets it straight back to plain `hi`. Bracketed-paste and Windows' `win32-input-mode` batch-paste packets are recognized as what they are, so a large paste can never be mistaken for real typing, for the toggle hotkey, or corrupted in transit.
- A configurable quiet window (`CWARM_HUMAN_QUIET_S`, default 5 min) blocks injection entirely right after you type, so a half-finished draft you paused to think about can't get Enter-submitted by an untimely `hi`.
- The very first instruction of each fresh unattended stretch is prefixed with a one-time briefing telling Claude *why* it's receiving this — that cwarm is driving, not its own initiative, what the safety rules are, and that real human input always overrides it.

### How it paces itself

- **5-hour window:** below `CWARM_AI_FAST_PCT` (default 70%) usage and no other quota concern → fast pace (`CWARM_AI_PACE_S`, default 5 min) instead of waiting a full cache-TTL between injections, so the checklist actually gets somewhere. Above that — or once you're within an hour of the hard limit — it backs off; once you're actually rate-limited it stops injecting entirely and waits for the window to reset.
- **7-day window:** pro-rated against a flat daily budget (100%/7 ≈ 14.3%/day, with one day of grace). Running ahead of that pace pauses AI-mode work (falls back to plain `hi`) so a long unattended stretch can't burn a week's quota in a day.
- Once a quota window resets, the next injection is a plain `go on` instead of the next checklist step — resuming both the cache and whatever task was interrupted — unless you've already come back and sent something yourself.

### Should you turn it on?

Turn it **on** if: you're fine with Claude doing small, verifiable maintenance work (reviews, tests, docs, refactors) on its own while you're away, you trust the built-in bounds (no deploys, no destructive operations, no large new scope — see the cycle below), and you want idle time to produce something instead of just a warm cache.

Leave it **off** (the default) if: you only want the cache kept warm and nothing else to happen; you're on a tight quota and don't want background token spend; the session touches anything sensitive or production-adjacent where you'd rather nothing runs without you watching; or you simply haven't reviewed what the built-in checklist does yet.

### Turning it on/off

```sh
cwarm --ai              # on for this run
CWARM_AI=1 cwarm        # same, via env var
```

Or toggle **live**, anytime, with `Ctrl+\` (rebindable — see `CWARM_TOGGLE_KEY` below; useful if your IME steals the default). The toggle is **persisted per project** and survives restarts — `--ai` / `CWARM_AI=0` override the remembered state on the next launch. Current state shows in the statusline: `🤖AI on (Ctrl+\)`.

### The built-in cycle

18 steps, repeating: review → critical review → TODO/FIXME sweep → propose an improvement list → execute the safest items → test coverage → mutation-check the tests → error-handling audit → light security self-check → dependency health check (report only, no upgrades) → performance low-hanging fruit → small refactors → cross-platform review → sync docs → verify the README quickstart → devil's-advocate a design decision → distill lessons into project memory → wrap up with a report + decision queue. Every step is scoped to be safe, bounded, and verifiable — no deploys, no destructive operations, no large new work.

Replace it entirely with your own, or tune the pacing:

| Var | Meaning |
|-----|---------|
| `CWARM_AI` | `1`/`on`/`true`/`yes` to force on, `0`/`off` to force off (overrides the persisted toggle) |
| `CWARM_AI_MSG` | send this single fixed message instead of the cycle |
| `CWARM_AI_MSG_FILE` | path to a file with one instruction per line (`#` = comment) — swap out the whole cycle, e.g. for writing/research/translation work instead of software engineering |
| `CWARM_TOGGLE_KEY` | rebind the hotkey from `Ctrl+\` to `Ctrl+<char>` |
| `CWARM_HUMAN_QUIET_S` | seconds of silence required after a keystroke before injecting again (default `300`) |
| `CWARM_AI_PACE_S` | fast-pace interval in seconds when quota allows (default `300`) |
| `CWARM_AI_FAST_PCT` | 5h-usage ceiling below which fast pace applies (default `70`) |
| `CWARM_RESUME_MSG` | override the post-quota-reset resume message (default `go on`) |

Everything is logged to `~/.claude/cwarm-keepalive.log` — which step fired, why (or why not), and the quota state at the time — so you can audit what happened while you were away.

## Configuration

Environment variables (mostly for testing / advanced use):

| Var | Meaning |
|-----|---------|
| `CWARM_MSG` | keepalive message (default `hi`) |
| `CWARM_TICK_MS` | check interval (default `20000`) |
| `CWARM_QUIET_MS` | screen must be silent this long before injecting (default `2500`) |
| `CWARM_ESC_DELAY_MS` | gap between the `Esc` and the keepalive message (default `250`) |
| `CWARM_THRESHOLD_S` | override idle threshold (seconds) |
| `CWARM_TTL_S` | override cooldown (seconds) |
| `CWARM_BILLING` | force billing mode: `subscription` (keep warming) or `credits` (suspend); otherwise auto‑detected |
| `CWARM_CLAUDE` | path to the `claude` executable (otherwise auto‑detected via `which`/`where`) |
| `CLAUDE_CONFIG_DIR` | Claude config dir (default `~/.claude`) |

## Limitations

- **No detach.** Closing the window ends the session — there's no tmux‑style detach/reattach (that would mean reimplementing a terminal multiplexer; out of scope). But minimize / background / unfocused all keep working.
- **Concurrent sessions in the same folder need the statusline.** With the statusline add‑on installed (`cwarm setup`), each `cwarm` tab pins its own session's transcript and multiple tabs coexist cleanly — even in the same folder. Without it, two sessions in the *same* folder will read each other's transcript activity and the keepalive misfires (sessions in different folders are always fine).
- If you walk away with a half‑typed draft and stay idle past the threshold, the keepalive's `Esc` clears the draft before sending `hi`. Rare.
- **A genuinely blocking prompt can't be kept warm.** While Claude Code waits on a mandatory answer, no API turn can happen, so the cache may cool during that window; warming resumes automatically once you answer.

## Platform support

- **Windows** (Git Bash / PowerShell / cmd / Windows Terminal): verified, including non‑ASCII (CJK) input.
- **Linux arm64 / aarch64**: verified on a Raspberry Pi 4 (Debian, Node 22) — global install (node-pty compiled cleanly), `cwarm` launch, and live keepalive injection all confirmed. x64 expected to behave the same.
- **macOS**: same cross‑platform mechanism (node-pty + your shell's `claude`); expected to work, not yet tested. Reports welcome.

## 繁體中文

讓 [Claude Code](https://claude.com/claude-code) 的 **prompt cache 在你離開時保持溫熱**，回來時就不必再付一次完整的 cache‑miss。

`cwarm` 把 `claude` 跑在自己控制的 PTY 裡；當你閒置超過 cache 的 TTL 時，注入一個極小的 keepalive 訊息讓 cache 不過期。因為注入是行程內部的 PTY 寫入，**視窗非焦點、縮小、在背景都照常運作**——只有關閉視窗才會停。跨平台、**不需要 tmux**。

> ⚠️ **誠實說明**：保溫＝閒置時送一則小訊息（`hi`），會消耗你的方案用量、並在對話留下 `hi` 紀錄。只在長時間閒置後才觸發（1h cache 約 58 分、5m cache 約 4 分）且有冷卻，屬保守設計、明確 opt‑in。不接受這個取捨就別用。

- **安裝**：`npm install -g claude-cache-keepalive`
- **使用**：`cwarm`（＝乾淨的 `claude` 跑在保溫 host 裡，不再隱含 `--continue`；要接續上次打 `cwarm --continue`，其餘參數原樣轉給 claude）
- **暫停**：`touch ~/.claude/cwarm.disabled`；**紀錄**：`~/.claude/cwarm-keepalive.log`
- **選配 statusline**（顯示 `♻️ cache 58m12s` 倒數；會先備份、包裝既有 statusline、可一鍵還原）：`cwarm setup` / `cwarm setup --remove`
- **限制**：不能 detach（關視窗＝結束，但縮小／背景照常保溫）。

### 額度段位（statusline）

裝了 `cwarm setup` 之後，statusline 會直接從 Claude Code 自帶的 `rate_limits` payload 秀出兩段額度提醒，不用額外設定：

```
⚠️ 96%、離reset還2h，建議暫停 │ 🔴 週超前15.0%，剩3.5d均10.0%/天，休息21.8h回綠
```

- **5 小時視窗**：用量超過 95% 且離 reset 還超過 1 小時，才會出現 `⚠️ NN%、離reset還Nh，建議暫停`；不到 95%、或已經進入最後一小時（尾巴額度反正燒到撞牆），都不顯示。
- **7 天視窗**：用一顆彩色球表示「超前按時間比例均攤的日均進度線（100%/7 ≈ 14.3%/天）多少個百分點」：不到 2 個百分點（含落後）是 🟢，2~3 之間留白不顯示，3~5 是 🟡，6~8 是 🟠，9~11 是 🩷（Unicode 沒有粉紅圓形，借粉紅愛心最接近），12 以上是 🔴。球旁邊接著顯示視窗還剩幾天、照這剩餘天數均攤接下來每天還能燒多少 %，以及——只要超前 2 個百分點以上——要「休息」（不再新增用量）多久，進度線才會爬上來讓球回綠。

這兩段都只是顯示，不會擋掉保溫注入；`--ai` 模式才是拿同一組數字真的去踩剎車（見下方）。

### 運作原理

- **PTY host**：`cwarm` 把 `claude` spawn 在一個它自己擁有的 pseudo-terminal 裡，透明地把你的鍵盤 ↔ claude ↔ 畫面（含視窗 resize）接起來。這跟 tmux／expect／VS Code 終端的做法相同，也是唯一穩健、能把輸入注入終端程式的方式。
- **閒置偵測**：閒置＝距你上次**訊息**多久，量自 `~/.claude/projects/` 底下本 session 的 transcript 檔。這才是決定 cache 年齡的訊號——捲動、用方向鍵讀、打到一半沒送出，都是終端輸入但不會刷新 cache，所以不該算成活動。（早期版本計時鍵盤輸入，會讓你在閱讀時 cache 冷掉。）裝了 statusline 附加元件（`cwarm setup`）後，host 會透過一個極小的 per-session 橋接檔（`~/.claude/cwarm-session-<id>.json`，由 statusline 的 `transcript_path` 落地、退出時自動刪除）**針定自己 session 的 transcript**——多個分頁在**同一個資料夾**各開 session 也不會互相干擾。沒裝 statusline 則回退「本專案資料夾裡最新的 transcript」猜法。
- **TTL 感知（實測，非猜測）**：cache TTL 直接讀自 transcript 的 `message.usage.cache_creation`，不從訂閱方案推斷——最近有寫 `ephemeral_1h_input_tokens` → 1h cache（閒置約 58 分才注入、冷卻 1h）；只有 `ephemeral_5m_input_tokens`（或還沒證據）→ 5m cache（保守，約 4 分注入、冷卻 5m）。這能撐過 client 版本、環境變數、伺服器旗標的變動（例如 Pro 帳號也可能拿到 1h cache）。
- **提示安全注入**：keepalive 只在 PTY **靜止一小段時間後**才觸發（`CWARM_QUIET_MS`，預設 2.5 秒）。必答提示（工具權限、`AskUserQuestion`、計畫批准）的 spinner 會一直動，忙著跑工具時也持續輸出，兩者都「不安靜」，所以 keepalive 不會送進去（不會誤選選單預設項、也不會打斷長工具執行）。而且注入時會**先送 `Esc`** 退回輸入框，那個 Enter 永遠落不到提示上。（提示真的卡住時 cache 本來就無法保溫，等你回答後會自動恢復。）
- **與焦點／縮小無關**：注入是行程內部的 `pty.write`，跟視窗狀態無關。只有關閉視窗（結束 host 行程）才會停。

### 無人值守 AI 模式（選配，預設關）

純保溫只會送 `hi`——無害，但沒讓閒置時間產生任何價值。`--ai` 模式會：一旦 cwarm 判定你真的離開了，就不再送 `hi`，改成餵給 Claude 一組循環式的安全自我驗證工作（檢視這個 session、掃 TODO、補缺的測試、同步文件、把心得寫進 memory……），讓閒置視窗變成實際進度，而不只是空白等待。

**怎麼判定「你不在了」**

- 連續兩發保溫都完全沒有人為鍵盤輸入 → 第三發起，從 `hi` 改敲工作循環的第一步。
- 只要打了任何一個字（哪怕只有一個按鍵），就立刻歸零回到普通 `hi`。Bracketed-paste 與 Windows 的 `win32-input-mode` 批次貼上封包都會被正確識別，大量貼上內容不會被誤判成真人打字、不會誤觸切換熱鍵，也不會在轉送過程中被毀損。
- 可調的靜默窗（`CWARM_HUMAN_QUIET_S`，預設 5 分鐘）在你剛打完字之後完全封鎖注入——避免你停下來想事情時，半句沒送出的草稿被一發不合時宜的 `hi` 連 Enter 一起送出去。
- 每一輪全新的無人值守，第一句指令都會附上一次性簡報，跟 Claude 說明「為什麼會收到這句」——這是 cwarm 在驅動，不是它自己的主動行為，安全規則是什麼，以及真人輸入永遠優先於這些指令。

**怎麼配速**

- **5 小時視窗：**用量低於 `CWARM_AI_FAST_PCT`（預設 70%）且沒有其他額度疑慮 → 用快節奏（`CWARM_AI_PACE_S`，預設 5 分鐘），不必每次都空等一整個 cache TTL，循環才推得動。超過這個門檻、或離硬性上限不到一小時，就退回原節奏；真的撞到額度上限就整個暫停注入，等視窗重置。
- **7 天視窗：**按時間比例攤成一條日均進度線（100%/7 ≈ 14.3%/天，留一天緩衝）。用量跑到進度線前面就暫停 AI 工作（退回普通 `hi`），避免一段長時間的無人值守把一整週的額度燒穿。
- 額度視窗重置後，下一發改敲普通的 `go on` 而不是循環的下一步——同時回溫 cache 與接續被額度打斷的任務——除非你自己已經先回來發了訊息。

**要不要開？**

**開**的情境：你能接受 Claude 在你不在時做一些小而可驗證的維護工作（檢視、測試、文件、重構），信任內建的邊界（不部署、不做破壞性操作、不擴大範圍——見下方循環內容），而且希望閒置時間能產出東西，不只是保溫。

**維持關**（預設）的情境：你只想保溫、不想有任何額外動作；額度吃緊、不想有背景耗用；這個 session 涉及敏感或接近正式環境的內容，寧可沒人看著就什麼都不跑；或者你還沒看過內建循環到底會做什麼。

**開關方式**

```sh
cwarm --ai              # 這次啟動就開
CWARM_AI=1 cwarm        # 效果相同，走環境變數
```

或執行中隨時按 `Ctrl+\` **即時切換**（可換鍵，見下方 `CWARM_TOGGLE_KEY`；IME 搶走預設鍵時很有用）。切換狀態**依專案持久化**、重啟沿用——`--ai` / `CWARM_AI=0` 會覆蓋下次啟動時記住的狀態。目前狀態顯示在 statusline：`🤖AI on (Ctrl+\)`。

**內建循環**

18 步循環：review → 批判 review → TODO/FIXME 掃描 → 提出改進清單 → 執行最安全的項目 → 測試覆蓋 → mutation check（測試有效性）→ 錯誤處理稽核 → 輕量資安自查 → 相依套件體檢（只報告不升級）→ 效能低垂果實 → 小步重構 → 跨平台審視 → 文件同步 → README 快速上手驗證 → 對照方案探索 → 心得蒸餾進 project memory → 收尾報告＋決策佇列。每一步都刻意設計成安全、有界、可驗證——不部署、不做破壞性操作、不展開大型新工作。

想整套換掉、或調節奏，可用：

| 變數 | 意義 |
|-----|------|
| `CWARM_AI` | `1`/`on`/`true`/`yes` 強制開、`0`/`off` 強制關（覆蓋持久化狀態） |
| `CWARM_AI_MSG` | 改成固定敲這一句，取代整套循環 |
| `CWARM_AI_MSG_FILE` | 自訂指令檔路徑，一行一條（`#` 開頭為註解）——整套換掉，例如換成寫作／研究／翻譯而非軟體工程 |
| `CWARM_TOGGLE_KEY` | 把熱鍵從 `Ctrl+\` 換成 `Ctrl+<字元>` |
| `CWARM_HUMAN_QUIET_S` | 敲鍵後需靜默幾秒才可再注入（預設 `300`） |
| `CWARM_AI_PACE_S` | 額度充裕時的快節奏間隔秒數（預設 `300`） |
| `CWARM_AI_FAST_PCT` | 5h 用量低於此值才套用快節奏（預設 `70`） |
| `CWARM_RESUME_MSG` | 覆寫額度重置後的續跑訊息（預設 `go on`） |

所有動作都會記進 `~/.claude/cwarm-keepalive.log`——哪一步觸發、為什麼（或為什麼沒有）、當下的額度狀態——回來後可以稽核你不在的這段時間發生了什麼。

### 設定

環境變數（多為測試／進階用途）：

| 變數 | 意義 |
|-----|------|
| `CWARM_MSG` | keepalive 訊息（預設 `hi`） |
| `CWARM_TICK_MS` | 檢查間隔（預設 `20000`） |
| `CWARM_QUIET_MS` | 畫面需靜止多久才注入（預設 `2500`） |
| `CWARM_ESC_DELAY_MS` | `Esc` 與訊息之間的間隔（預設 `250`） |
| `CWARM_THRESHOLD_S` | 覆寫閒置門檻（秒） |
| `CWARM_TTL_S` | 覆寫冷卻（秒） |
| `CWARM_BILLING` | 強制指定計費模式：`subscription`（照常保溫）或 `credits`（暫停）；否則自動偵測 |
| `CWARM_CLAUDE` | `claude` 執行檔路徑（否則用 `which`／`where` 自動偵測） |
| `CLAUDE_CONFIG_DIR` | Claude 設定目錄（預設 `~/.claude`） |

### 平台支援

- **Windows**（Git Bash／PowerShell／cmd／Windows Terminal）：已驗證，含非 ASCII（中日韓）輸入。
- **Linux arm64／aarch64**：已在 Raspberry Pi 4（Debian、Node 22）驗證——全域安裝（node-pty 乾淨編譯）、`cwarm` 啟動、即時 keepalive 注入都確認可用。x64 預期相同。
- **macOS**：同樣的跨平台機制（node-pty ＋ 你 shell 裡的 `claude`）；預期可用，尚未實測，歡迎回報。

## Changelog

### 0.1.14
- **Feature:** the statusline's 7-day quota warning is now a real pace gauge, not just a raw number. A colored ball shows how far ahead of a straight-line pace budget (100%/7 ≈ 14.3%/day) you're running — 🟢 under 2pt ahead, 🟡 3-5pt, 🟠 6-8pt, 🩷 9-11pt, 🔴 12pt+ — alongside how many days are left in the window, the average %/day you can still spend at that pace, and (once you're 2pt+ ahead) how long you'd need to rest before the ball turns green again. See the new "Quota segments" section above.
- **功能：** statusline 的 7 天額度提醒從一個原始數字變成真正的配速計。彩色球顯示超前「按時間比例均攤」的日均進度線（100%/7 ≈ 14.3%/天）多少個百分點——🟢 不到 2pt、🟡 3~5pt、🟠 6~8pt、🩷 9~11pt、🔴 12pt+——旁邊接著顯示視窗剩幾天、照這個配速接下來每天還能燒多少 %，以及（超前 2pt 以上時）要休息多久球才會回綠。詳見上方新增的「額度段位（statusline）」章節。

### 0.1.13
- **Fix:** running multiple Claude Code sessions in tabs **in the same folder** no longer corrupts each other's keepalive timing. The host used to measure idle from the *newest* transcript in the project folder — with a busier sibling session next door, its own idle never crossed the threshold, the keepalive never fired, and the cache countdown ran cold (🔴). Now the statusline lands each session's exact `transcript_path` into a per‑session bridge file (`~/.claude/cwarm-session-<id>.json`, keyed by a `CWARM_HOST_ID` the host passes through the PTY environment), and the host pins idle *and* TTL‑regime detection to its own transcript. Bridge files are deleted on exit; stale orphans (crashes) are swept on startup. Without the statusline installed, behavior falls back to the previous folder‑newest heuristic.
- **修正：** 用分頁在**同一個資料夾**開多個 Claude Code session 時，保溫計時不再互相干擾。過去 host 是拿專案資料夾裡 *mtime 最新* 的 transcript 判閒置——隔壁分頁還在活動時，自己的閒置永遠算不滿門檻、keepalive 不發、cache 倒數一路走到冷掉（🔴）。現在 statusline 會把每個 session 精確的 `transcript_path` 落地成 per-session 橋接檔（`~/.claude/cwarm-session-<id>.json`，以 host 經 PTY 環境變數傳入的 `CWARM_HOST_ID` 為鍵），host 的閒置判定**與 TTL 檔位偵測**都針定自己的 transcript。橋接檔退出時自動刪除；crash 留下的孤兒檔啟動時順手清掉。沒裝 statusline 時回退原本「資料夾最新」的猜法。

### 0.1.12
- **Feature:** each fresh unattended stretch now opens with a one-time **briefing message** — the first checklist step of a new round (after human activity resets the cycle) is prefixed with a short explanation telling Claude that cwarm's AI mode is driving, why it's receiving instructions with no request from the user, how the quota pacing works, that a real human message always overrides it, and the built-in safety bounds. Mid-cycle wraparounds within the same unattended stretch don't repeat it. Implemented as a pure, tested `pickInjectMsg` option — no duplicated logic in the host loop.
- **Docs:** added a full **"Unattended AI mode"** section (English + 繁體中文) covering how it detects you've stepped away, how it paces itself against your 5h/weekly quota, when to turn it on vs. leave it off, how to toggle it, the built-in 18-step cycle, and every `CWARM_AI_*` config knob — previously this was only in `cwarm help` and the changelog, with no standalone explanation.
- **功能：** 每一輪全新的無人值守，開頭第一步（使用者活動歸零後、重新進入無人值守時）現在會附上一次性**簡報訊息**，跟 Claude 說明 cwarm 的 AI 模式正在驅動、為什麼會平白收到指令、額度配速怎麼運作、真人訊息永遠優先於這些指令、以及內建的安全邊界。同一輪無人值守中途繞圈不會重複附加。實作成 `pickInjectMsg` 的一個純函式選項（有測試涵蓋），host 迴圈裡沒有重複判斷邏輯。
- **文件：** 新增完整的**「無人值守 AI 模式」**專節（英文＋繁體中文），涵蓋怎麼判定「你不在了」、怎麼依 5 小時／週額度配速、什麼時候該開／該關、怎麼切換、內建 18 步循環內容、以及每一個 `CWARM_AI_*` 設定變數——先前這些只在 `cwarm help` 與 changelog 裡零散提過，沒有獨立完整說明。

### 0.1.11
- **Feature:** opt-in **unattended AI mode** (`cwarm --ai`, or `CWARM_AI=1`, or press `Ctrl+\` anytime to toggle — state persists per project and shows in the statusline). After two keepalive pings with no human keystrokes, cwarm injects a cycling set of safe work instructions (review → tests → docs → …) instead of plain `hi`, pacing itself by your 5h and weekly quota headroom (a bridge file written by the statusline feeds the host live `rate_limits`, since the host process can't see the statusline payload directly). Customize the cycle with `CWARM_AI_MSG` (single message) or `CWARM_AI_MSG_FILE` (one instruction per line, `#` = comment). Statusline also gains an account/plan segment (`👤you·Max 5x`, useful when switching accounts with `/login`) and a 95%-quota warning.
- **Hardening:** the AI-state and usage-bridge files are now isolated per project directory (they were briefly global during development, which would have let two accounts' quota windows overwrite each other); bracketed-paste and Windows batch-paste content can no longer be misread as the toggle hotkey or counted as "unattended activity"; a mistyped `CWARM_HUMAN_QUIET_S` now falls back to the 5-minute default with a logged warning instead of silently disabling the anti-half-typed-draft guard; the AI instruction cycle advances on its own step counter so a quota-gated pause can't skip steps; the cwd key used for cwarm's own state files only folds case/slashes on Windows, so it can't collapse two distinct directories that differ only by case on a case-sensitive filesystem.
- **功能：** 選配的**無人值守 AI 模式**（`cwarm --ai`、或 `CWARM_AI=1`、或執行中隨時按 `Ctrl+\` 切換——狀態依專案持久化、statusline 會顯示）。連兩發保溫 `hi` 都沒人碰鍵盤後，第三發起改敲一組循環式安全工作指令（檢視→測試→文件→……）取代單純的 `hi`，並依 5 小時與週額度餘裕自動調節節奏（額度資料由 statusline 落地成橋接檔給 host 讀，因為 host 行程本身收不到 statusline 的 payload）。可用 `CWARM_AI_MSG`（固定一句）或 `CWARM_AI_MSG_FILE`（一行一條指令，`#` 開頭為註解）自訂循環內容。statusline 同時新增帳號/訂閱段位（如 `👤you·Max 5x`，`/login` 切帳號時很好用）與 95% 額度警示。
- **強化：** AI 狀態檔與額度橋接檔改成依專案目錄各自隔離（開發過程中曾短暫全域共用，會讓兩個帳號的額度視窗互相覆蓋）；bracketed-paste 與 Windows 批次貼上內容不會再被誤判成切換熱鍵或算成「無人值守活動」；`CWARM_HUMAN_QUIET_S` 打錯字時會退回 5 分鐘預設值並記警告，不再靜默關掉防止半句草稿被送出的安全閥；AI 指令循環改用獨立的步進計數器推進，額度閘門暫停期間不會讓循環跳號；cwarm 自家狀態檔使用的路徑鍵只在 Windows 上做大小寫/斜線正規化，避免在大小寫敏感的檔案系統上把兩個真正不同的目錄錯誤地合併成同一份狀態。

### 0.1.10
- **Fix:** the optional statusline segment now reflects the 0.1.9 billing guard. On credits/API billing the keepalive is suspended, but the `♻️ cache …` countdown kept ticking as if warming were still active — misleading. The segment now shows `⏸️ cwarm off (API)` while `detectBillingMode` reports credits, and returns to the normal countdown once you're back on a subscription account.
- **修正：** 選配的 statusline 區段現在會反映 0.1.9 的計費防護。credits／API 計費時 keepalive 已暫停，但 `♻️ cache …` 倒數仍照跑，彷彿還在保溫——會造成誤導。現在 `detectBillingMode` 回報 credits 期間會改顯示 `⏸️ cwarm off (API)`，切回訂閱帳號後自動恢復正常倒數。

### 0.1.9
- **Fix:** keepalive now **auto-suspends on credits/API billing**. If you `/login` into an Anthropic Console account (credits usage) — or run purely on `ANTHROPIC_API_KEY` — every injected `hi` and every cache refresh costs real money, so warming the cache no longer makes sense (on a subscription it only spends rate-limit quota). cwarm now detects the billing mode each tick (from `~/.claude/.credentials.json`'s `claudeAiOauth.subscriptionType`, falling back to `~/.claude.json`'s `oauthAccount.billingType`, then the `ANTHROPIC_API_KEY` env var) and skips injection while on credits, logging `skip: credits/API billing detected` once; switching back to a subscription account mid-session resumes warming automatically. Override with `CWARM_BILLING=subscription|credits` if detection guesses wrong. Adds `billingModeFromSources` / `detectBillingMode`.
- **修正：** keepalive 現在會在 **credits／API 計費時自動暫停**。若你用 `/login` 切到 Anthropic Console 帳號（credits usage），或純靠 `ANTHROPIC_API_KEY` 執行，每次注入的 `hi` 與每次 cache 續寫都是實際花錢，保溫就失去意義（訂閱制下花的只是額度）。cwarm 現在每個 tick 偵測計費模式（先看 `~/.claude/.credentials.json` 的 `claudeAiOauth.subscriptionType`，再退回 `~/.claude.json` 的 `oauthAccount.billingType`，最後看 `ANTHROPIC_API_KEY` 環境變數），credits 期間跳過注入並記錄一次 `skip: credits/API billing detected`；session 中切回訂閱帳號會自動恢復保溫。偵測誤判可用 `CWARM_BILLING=subscription|credits` 強制指定。新增 `billingModeFromSources`／`detectBillingMode`。

### 0.1.8
- **Fix:** the keepalive's `Esc`‑prefix (added in 0.1.5) could dismiss Claude Code's **folder‑trust dialog** ("Do you trust the files in this folder?"). Since 0.1.7 dropped the implicit `--continue`, bare `cwarm` starts a *fresh* session, so an untrusted directory shows the trust dialog on launch; if you stepped away past the idle threshold, the keepalive's `Esc` cancelled it — which writes `hasTrustDialogAccepted: false` into `~/.claude.json` and makes that folder's `.claude/settings.local.json` permissions silently ignored (the "Ignoring N permissions.allow entries: this workspace has not been trusted" warning you only see after `/exit` restores the normal screen). The keepalive now detects the trust dialog on screen and **skips the whole tick** (no `Esc`, no message), leaving it for you to answer; all other mandatory prompts keep the 0.1.5 `Esc` behaviour. Adds `looksLikeTrustPrompt`.
- **修正：** 0.1.5 加入的 keepalive **`Esc` 先行**可能會把 Claude Code 的**資料夾信任對話框**（「Do you trust the files in this folder?」）給收掉。自 0.1.7 拿掉隱含的 `--continue` 後，單獨打 `cwarm` 會開*全新* session，所以進入未信任的資料夾時啟動就會跳信任框；若你人走開、閒置過門檻，keepalive 的 `Esc` 就把它取消掉——這會在 `~/.claude.json` 寫下 `hasTrustDialogAccepted: false`，使該資料夾的 `.claude/settings.local.json` 權限被靜默忽略（就是你 `/exit` 還原一般畫面後才看到的「Ignoring N permissions.allow entries: this workspace has not been trusted」警告）。keepalive 現在會偵測畫面上的信任框並**整輪跳過**（不送 `Esc`、不送訊息），交給你本人回答；其他必答提示維持 0.1.5 的 `Esc` 行為。新增 `looksLikeTrustPrompt`。

### 0.1.7
- **Change:** `cwarm` no longer implicitly adds `--continue`. It is now a fully transparent pass‑through — `cwarm [args]` is exactly `claude [args]`, so bare `cwarm` starts a clean session. To resume your last session, run `cwarm --continue`. (Previously bare `cwarm` auto‑resumed.)
- **變更：** `cwarm` 不再隱含補上 `--continue`，改為完全透傳——`cwarm [參數]` 就等於 `claude [參數]`，所以單獨打 `cwarm` 會開全新 session。要接續上次請打 `cwarm --continue`。（先前單獨打 `cwarm` 會自動接續。）

### 0.1.6
- **Docs:** every changelog entry now carries a Traditional Chinese version alongside the English. No code change.
- **文件：** 每條 changelog 現在都在英文旁附上繁體中文。無程式碼變動。

### 0.1.5
- **Fix:** the keepalive could fire while Claude Code was showing a **mandatory prompt** (tool‑permission, `AskUserQuestion`, plan approval). Because the injected `hi␍` ends in Enter, that Enter landed on the prompt and selected its highlighted default — e.g. **auto‑approving a tool** — instead of sending a message (the reported "can't send `hi`"). Two layers fix it: **(1)** injection now waits for the PTY to be **quiet** (`CWARM_QUIET_MS`, default 2.5 s) — an animating prompt and a busy tool‑run both keep emitting output, so the keepalive no longer fires into either (this also stops it interrupting a long tool‑run, which the transcript‑mtime idle timer can't see); **(2)** the keepalive is now **`Esc`‑prefixed** (`CWARM_ESC_DELAY_MS` gap, default 250 ms) — it backs out of any prompt to the input box before sending `hi`, so the Enter can never select a menu default. Investigated empirically: a pending tool turn isn't written to the transcript while blocked (so transcript inspection can't detect this state), but the screen reliably distinguishes idle (silent) from prompt/busy (animating). While a prompt is genuinely blocking the cache can't be kept warm regardless; warming resumes once you answer.
- **修正：** keepalive 可能在 Claude Code 跳出**必答提示**（工具權限、`AskUserQuestion`、計畫批准）時觸發。因為注入的 `hi` 訊息以 Enter 結尾，那個 Enter 會落在提示上、選中反白的預設項——例如**自動核准某個工具**——而不是送出訊息（就是你回報的「送不出 `hi`」）。兩層修正：**(1)** 注入前先等 PTY **靜止**（`CWARM_QUIET_MS`，預設 2.5 秒）——提示在動、忙著跑工具／生成時都會持續輸出，所以 keepalive 不會再送進這兩種狀態（也順帶不會打斷長時間的工具執行，那是 transcript mtime 閒置計時看不到的）；**(2)** keepalive 現在會**先送 `Esc`**（`CWARM_ESC_DELAY_MS` 間隔，預設 250 毫秒）——先退出任何提示、回到輸入框再送 `hi`，那個 Enter 就絕不會選到選單預設項。實測發現：卡住時那個 pending 的工具回合還沒被寫進 transcript（所以查 transcript 偵測不到這個狀態），但畫面能可靠分辨閒置（靜止）與提示／忙碌（在動）。提示真的卡住時 cache 本來就無法保溫；你回答後會自動恢復保溫。

### 0.1.4
- **Fix:** the terminal could be left unusable after `/exit` or Ctrl‑C (keystrokes garbled / no usable input). The PTY host now restores the terminal on every exit path: it emits an explicit reset (disabling alt‑screen, bracketed‑paste, mouse, cursor‑hide, and — critically on Windows — `win32‑input‑mode` `?9001` and focus‑reporting `?1004`, which otherwise make the shell receive keystrokes as unparseable `ESC[…_` packets) and flushes stdout before exiting. Adds a `SIGINT` handler that forwards `0x03` to claude instead of letting the host be killed before cleanup, plus `SIGHUP`/`exit` safety restores.
- **修正：** `/exit` 或 Ctrl-C 之後終端可能變得不能用（鍵盤輸入亂碼／打不了字）。PTY host 現在會在每條退出路徑都還原終端：主動送出一段明確的重置序列（關掉 alt-screen、bracketed-paste、滑鼠、隱藏游標，以及——在 Windows 上最關鍵的——`win32-input-mode` `?9001` 與 focus-reporting `?1004`，否則 shell 會把每個鍵碼當成無法解析的 `ESC[…_` 封包收下），並在退出前把 stdout flush 掉。新增 `SIGINT` handler 把 `0x03` 轉送給 claude，而不是讓 host 在清理前就被殺掉；另加 `SIGHUP`／`exit` 的保險還原。

### 0.1.3
- **Change:** the cache TTL is now **measured from the transcript** (`message.usage.cache_creation`'s `ephemeral_1h` / `ephemeral_5m` tokens) instead of being guessed from your subscription plan. A recent 1h write → 1h regime; only 5m writes (or no evidence) → 5m regime (conservative). This drops the `~/.claude/.credentials.json` read entirely and is correct even when a Pro account gets a 1h cache. Adds `transcriptPath` / `readTtlRegime` / `detectTtlRegime` / `regimeParams`; removes `detectPlan` / `planParams`.
- **變更：** cache TTL 現在**直接從 transcript 實測**（`message.usage.cache_creation` 裡的 `ephemeral_1h`／`ephemeral_5m` token），不再用你的訂閱方案去猜。最近有任一回合寫過 1h → 1h 檔位；只有 5m 寫入（或還沒有證據）→ 5m 檔位（保守）。這完全拿掉了對 `~/.claude/.credentials.json` 的讀取，連 Pro 帳號拿到 1h cache 的情況也判得對。新增 `transcriptPath`／`readTtlRegime`／`detectTtlRegime`／`regimeParams`；移除 `detectPlan`／`planParams`。

### 0.1.2
- **Fix:** idle is now measured from the newest transcript file's mtime — i.e. time since your last *message* — instead of keystrokes. Scrolling, arrow‑key reading, or a half‑typed prompt no longer reset the idle timer, so the keepalive actually fires while you're reading and the cache stops going cold. Adds `encodeProjectDir` / `transcriptMtimeMs` / `transcriptIdleMs`.
- **修正：** 閒置現在改用最新 transcript 檔的 mtime 來計算——也就是距你上次*發訊息*多久——而不是看鍵盤輸入。捲動、用方向鍵讀回覆、或打到一半還沒送出，都不會再重置閒置計時，所以 keepalive 會在你閱讀時照常觸發、cache 不再冷掉。新增 `encodeProjectDir`／`transcriptMtimeMs`／`transcriptIdleMs`。

### 0.1.0
- Initial release. (0.1.1 was a version‑only bump and was never published to npm.)
- **首次發佈。**（0.1.1 只是純版本號 bump，從未發佈到 npm。）

## License

MIT

