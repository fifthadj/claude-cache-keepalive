// setup.mjs — opt-in 安裝/移除 cache-countdown statusline。
//   原則：會動 settings.json → 先備份、互動確認、絕不偷蓋既有 statusline（改成「包裝」它）、可一鍵還原。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { defaultClaudeDir } from './keepalive.mjs';

const claudeDir = defaultClaudeDir();
const SETTINGS = path.join(claudeDir, 'settings.json');
const ORIG = path.join(claudeDir, 'cwarm-statusline-orig.json');
const SEGMENT = fileURLToPath(new URL('./statusline/segment.mjs', import.meta.url));

const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };
const cwarmCommand = () => `node "${SEGMENT}"`;
const isCwarmStatusline = (sl) =>
  !!(sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.includes('segment.mjs'));

async function confirm(q) {
  if (process.argv.includes('--yes') || process.env.CWARM_YES) return true;
  if (!process.stdin.isTTY) { console.log('(non-interactive; re-run with --yes to proceed)'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

function backup() {
  if (!fs.existsSync(SETTINGS)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const bak = `${SETTINGS}.cwarm-bak.${ts}`;
  fs.copyFileSync(SETTINGS, bak);
  return bak;
}

export async function runSetup(args = []) {
  return args.includes('--remove') ? removeStatusline() : installStatusline();
}

async function installStatusline() {
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const settings = readJson(SETTINGS, {});
  const existing = settings.statusLine;

  if (isCwarmStatusline(existing)) { console.log('cwarm statusline already installed. Nothing to do.'); return 0; }

  console.log('\ncwarm setup — cache-countdown statusline (opt-in)\n');
  if (existing) {
    console.log('You already have a statusLine. cwarm will WRAP it (run yours, then append');
    console.log('a "♻️ cache …" countdown). Your original is saved and fully restorable.');
  } else {
    console.log('No existing statusLine. cwarm installs a minimal one:  [model] │ ♻️ cache …');
  }
  console.log(`\nThis edits ${SETTINGS} (a timestamped backup is made first).`);
  if (!(await confirm('Proceed? [y/N] '))) { console.log('Aborted. Nothing changed.'); return 1; }

  const bak = backup();
  fs.writeFileSync(ORIG, JSON.stringify(existing ?? null, null, 2)); // 存原 statusLine 物件供還原
  settings.statusLine = { type: 'command', command: cwarmCommand(), refreshInterval: 3 };
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

  console.log(`\n✓ Installed.${bak ? ' Backup: ' + path.basename(bak) : ''}`);
  console.log('  Remove anytime:  cwarm setup --remove');
  return 0;
}

async function removeStatusline() {
  const settings = readJson(SETTINGS, null);
  if (!settings) { console.log('No settings.json found; nothing to remove.'); return 0; }
  if (!isCwarmStatusline(settings.statusLine)) { console.log("Current statusLine isn't cwarm's; leaving it alone."); return 0; }

  backup();
  const orig = readJson(ORIG, null); // 還原成安裝前的物件（或無）
  if (orig) settings.statusLine = orig; else delete settings.statusLine;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  try { fs.unlinkSync(ORIG); } catch {}

  console.log('✓ Removed cwarm statusline; restored your previous setting.');
  return 0;
}
