#!/usr/bin/env node
// cli.mjs — `cwarm` 指令。攔截 `setup` 子指令，其餘原樣轉給 claude。
import { startHost } from './host.mjs';

const argv = process.argv.slice(2);
const first = argv[0];

if (first === 'setup') {
  const { runSetup } = await import('./setup.mjs');
  process.exit((await runSetup(argv.slice(1))) || 0);
} else if (first === 'help' || first === '--cwarm-help') {
  printHelp();
  process.exit(0);
} else {
  // `--ai` 是 cwarm 自己的旗標（開啟無人值守 AI 模式），要在透傳前攔掉，其餘原樣給 claude。
  // filter 在沒有 '--ai' 時本就回傳等價陣列，不必額外用三元式判斷要不要濾。
  const ai = argv.includes('--ai');
  const args = argv.filter((a) => a !== '--ai');
  startHost({ args, ai }); // 完全透傳給 claude；不帶參數就是乾淨的 claude（不再隱含 --continue）
}

function printHelp() {
  process.stdout.write(`cwarm — keep Claude Code's prompt cache warm while idle.

Usage:
  cwarm [claude args...]   Launch claude inside the keepalive host. Args pass straight
                           through, so \`cwarm\` === plain \`claude\`; use \`cwarm --continue\`
                           to resume your last session.
  cwarm setup              Optionally install the cache-countdown statusline (opt-in).
  cwarm setup --remove     Remove the statusline this tool installed.
  cwarm help               Show this help.

Everything except the 'setup' subcommand is passed straight to claude
(e.g. \`cwarm --version\`, \`cwarm resume\`, \`cwarm -p "..."\`).

Unattended AI mode (opt-in, off by default):
  cwarm --ai [claude args]  After two keepalive pings with no human keystrokes,
                            inject a cycling set of safe work instructions
                            (review / tests / docs / ...) instead of plain "hi",
                            pacing itself by your 5h + weekly quota headroom.
                            Also: CWARM_AI=1, or press Ctrl+\\ anytime to toggle
                            (state shows in the statusline; CWARM_TOGGLE_KEY=]
                            etc. rebinds it if your IME steals the default).
                            The toggle persists across restarts, per project;
                            --ai / CWARM_AI=0 override the remembered state.
                            Customize the cycle
                            with CWARM_AI_MSG (single message) or
                            CWARM_AI_MSG_FILE (one instruction per line, # = comment)
                            — the built-in cycle is software-engineering oriented.

Keepalive only fires after you've been idle past the cache-TTL threshold.
The TTL is auto-detected from the transcript's cache_creation (1h cache ->
fire after ~58min idle; 5m cache -> ~4min), not guessed from your plan.
Keepalive auto-suspends when you're on credits/API billing (Console account
via /login, or ANTHROPIC_API_KEY) — injections would cost real money there.
Override with CWARM_BILLING=subscription|credits if detection is wrong.
Pause anytime:  touch ~/.claude/cwarm.disabled
Log:  ~/.claude/cwarm-keepalive.log
`);
}
