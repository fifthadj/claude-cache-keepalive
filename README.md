# claude-cache-keepalive (`cwarm`)

Keep [Claude Code](https://claude.com/claude-code)'s **prompt cache warm while you're idle**, so coming back to a session you stepped away from doesn't pay a full cache‑miss.

It runs `claude` inside a PTY it controls (via [node-pty](https://github.com/microsoft/node-pty)) and, when you've been idle past your plan's cache TTL, injects a tiny keepalive so the cache stays warm. Because injection is an in‑process PTY write, **it keeps working when the window is unfocused, minimized, or in the background** — only closing the window stops it.

Cross‑platform, **no tmux required**. This is the missing piece for setups (Windows / Git Bash, plain terminals) where the usual tmux‑based keepalive isn't available.

> ⚠️ **Honest note — this uses your usage/quota.** Keeping the cache warm means sending a small message (`hi`) when you go idle, which counts against your plan usage and leaves `hi` turns in the conversation. It only fires after a long idle (≈58 min on Max, ≈4 min on Pro) with a one‑TTL cooldown, so it's conservative — but it is opt‑in by design. If that trade‑off isn't for you, don't use it.

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
- **Idle detection** — idle = time since your last keystroke. Self‑contained, no external files. When you step away, idle grows; when you type, it resets.
- **Plan‑aware** — reads your plan from `~/.claude/.credentials.json`:
  - **Max** → cache TTL 1 h → inject after ~58 min idle, cooldown 1 h.
  - **Pro** → cache TTL 5 min → inject after ~4 min idle, cooldown 5 min.
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
| `CWARM_THRESHOLD_S` | override idle threshold (seconds) |
| `CWARM_TTL_S` | override cooldown (seconds) |
| `CWARM_CLAUDE` | path to the `claude` executable (otherwise auto‑detected via `which`/`where`) |
| `CLAUDE_CONFIG_DIR` | Claude config dir (default `~/.claude`) |

## Limitations

- **No detach.** Closing the window ends the session — there's no tmux‑style detach/reattach (that would mean reimplementing a terminal multiplexer; out of scope). But minimize / background / unfocused all keep working.
- **Single session.** Designed for one `cwarm` session at a time.
- If you walk away mid‑typing, an injected `hi` is appended to whatever's in the input box. Rare and harmless.

## Platform support

- **Windows** (Git Bash / PowerShell / cmd / Windows Terminal): verified, including non‑ASCII (CJK) input.
- **Linux arm64 / aarch64**: verified on a Raspberry Pi 4 (Debian, Node 22) — global install (node-pty compiled cleanly), `cwarm` launch, and live keepalive injection all confirmed. x64 expected to behave the same.
- **macOS**: same cross‑platform mechanism (node-pty + your shell's `claude`); expected to work, not yet tested. Reports welcome.

## 繁體中文

讓 [Claude Code](https://claude.com/claude-code) 的 **prompt cache 在你離開時保持溫熱**，回來時就不必再付一次完整的 cache‑miss。

`cwarm` 把 `claude` 跑在自己控制的 PTY 裡；當你閒置超過方案的 cache TTL 時，注入一個極小的 keepalive 訊息讓 cache 不過期。因為注入是行程內部的 PTY 寫入，**視窗非焦點、縮小、在背景都照常運作**——只有關閉視窗才會停。跨平台、**不需要 tmux**。

> ⚠️ **誠實說明**：保溫＝閒置時送一則小訊息（`hi`），會消耗你的方案用量、並在對話留下 `hi` 紀錄。只在長時間閒置後才觸發（Max 約 58 分、Pro 約 4 分）且有冷卻，屬保守設計、明確 opt‑in。不接受這個取捨就別用。

- **安裝**：`npm install -g claude-cache-keepalive`
- **使用**：`cwarm`（＝`claude --continue` 跑在保溫 host 裡；其餘參數原樣轉給 claude）
- **暫停**：`touch ~/.claude/cwarm.disabled`；**紀錄**：`~/.claude/cwarm-keepalive.log`
- **選配 statusline**（顯示 `♻️ cache 58m12s` 倒數；會先備份、包裝既有 statusline、可一鍵還原）：`cwarm setup` / `cwarm setup --remove`
- **限制**：不能 detach（關視窗＝結束，但縮小／背景照常保溫）。

## License

MIT

