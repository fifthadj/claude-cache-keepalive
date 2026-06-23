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
cwarm                 # = claude --continue, inside the keepalive host
cwarm new             # any claude args are passed straight through
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
- **Idle detection** — idle = time since your last **message**, measured from the newest transcript file under `~/.claude/projects/`. This is what actually governs cache age: scrolling, arrow‑key reading, or a half‑typed prompt are terminal input but don't refresh the cache, so they must *not* count as activity. (Earlier versions timed keystrokes, which let the cache go cold while you were reading.)
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
| `CWARM_CLAUDE` | path to the `claude` executable (otherwise auto‑detected via `which`/`where`) |
| `CLAUDE_CONFIG_DIR` | Claude config dir (default `~/.claude`) |

## Limitations

- **No detach.** Closing the window ends the session — there's no tmux‑style detach/reattach (that would mean reimplementing a terminal multiplexer; out of scope). But minimize / background / unfocused all keep working.
- **Single session.** Designed for one `cwarm` session at a time.
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
- **使用**：`cwarm`（＝`claude --continue` 跑在保溫 host 裡；其餘參數原樣轉給 claude）
- **暫停**：`touch ~/.claude/cwarm.disabled`；**紀錄**：`~/.claude/cwarm-keepalive.log`
- **選配 statusline**（顯示 `♻️ cache 58m12s` 倒數；會先備份、包裝既有 statusline、可一鍵還原）：`cwarm setup` / `cwarm setup --remove`
- **限制**：不能 detach（關視窗＝結束，但縮小／背景照常保溫）。

### 運作原理

- **PTY host**：`cwarm` 把 `claude` spawn 在一個它自己擁有的 pseudo-terminal 裡，透明地把你的鍵盤 ↔ claude ↔ 畫面（含視窗 resize）接起來。這跟 tmux／expect／VS Code 終端的做法相同，也是唯一穩健、能把輸入注入終端程式的方式。
- **閒置偵測**：閒置＝距你上次**訊息**多久，量自 `~/.claude/projects/` 底下最新的 transcript 檔。這才是決定 cache 年齡的訊號——捲動、用方向鍵讀、打到一半沒送出，都是終端輸入但不會刷新 cache，所以不該算成活動。（早期版本計時鍵盤輸入，會讓你在閱讀時 cache 冷掉。）
- **TTL 感知（實測，非猜測）**：cache TTL 直接讀自 transcript 的 `message.usage.cache_creation`，不從訂閱方案推斷——最近有寫 `ephemeral_1h_input_tokens` → 1h cache（閒置約 58 分才注入、冷卻 1h）；只有 `ephemeral_5m_input_tokens`（或還沒證據）→ 5m cache（保守，約 4 分注入、冷卻 5m）。這能撐過 client 版本、環境變數、伺服器旗標的變動（例如 Pro 帳號也可能拿到 1h cache）。
- **提示安全注入**：keepalive 只在 PTY **靜止一小段時間後**才觸發（`CWARM_QUIET_MS`，預設 2.5 秒）。必答提示（工具權限、`AskUserQuestion`、計畫批准）的 spinner 會一直動，忙著跑工具時也持續輸出，兩者都「不安靜」，所以 keepalive 不會送進去（不會誤選選單預設項、也不會打斷長工具執行）。而且注入時會**先送 `Esc`** 退回輸入框，那個 Enter 永遠落不到提示上。（提示真的卡住時 cache 本來就無法保溫，等你回答後會自動恢復。）
- **與焦點／縮小無關**：注入是行程內部的 `pty.write`，跟視窗狀態無關。只有關閉視窗（結束 host 行程）才會停。

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
| `CWARM_CLAUDE` | `claude` 執行檔路徑（否則用 `which`／`where` 自動偵測） |
| `CLAUDE_CONFIG_DIR` | Claude 設定目錄（預設 `~/.claude`） |

### 平台支援

- **Windows**（Git Bash／PowerShell／cmd／Windows Terminal）：已驗證，含非 ASCII（中日韓）輸入。
- **Linux arm64／aarch64**：已在 Raspberry Pi 4（Debian、Node 22）驗證——全域安裝（node-pty 乾淨編譯）、`cwarm` 啟動、即時 keepalive 注入都確認可用。x64 預期相同。
- **macOS**：同樣的跨平台機制（node-pty ＋ 你 shell 裡的 `claude`）；預期可用，尚未實測，歡迎回報。

## Changelog

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

