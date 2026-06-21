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
  startHost({ args: argv }); // 無參數時 host 內部預設 --continue
}

function printHelp() {
  process.stdout.write(`cwarm — keep Claude Code's prompt cache warm while idle.

Usage:
  cwarm [claude args...]   Launch claude (default: --continue) inside the keepalive host.
  cwarm setup              Optionally install the cache-countdown statusline (opt-in).
  cwarm setup --remove     Remove the statusline this tool installed.
  cwarm help               Show this help.

Everything except the 'setup' subcommand is passed straight to claude
(e.g. \`cwarm --version\`, \`cwarm resume\`, \`cwarm -p "..."\`).

Keepalive only fires after you've been idle past the plan threshold
(max ~58min / pro ~4min). Pause anytime:  touch ~/.claude/cwarm.disabled
Log:  ~/.claude/cwarm-keepalive.log
`);
}
