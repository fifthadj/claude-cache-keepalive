#!/usr/bin/env node
// segment.mjs — cwarm 的 statusLine：跑使用者原本的 statusline（若有）再接上「cache 保溫倒數」。
//   純 Node、跨平台（不依賴 Python）；emoji 走 Node UTF-8 stdout，沒有 Windows cp950 問題。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultClaudeDir, readTtlRegime, regimeParams } from '../keepalive.mjs';

const claudeDir = defaultClaudeDir();
const ORIG = path.join(claudeDir, 'cwarm-statusline-orig.json');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// cache 倒數段：用 transcript mtime 當 idle、用 transcript 實測的 cache_creation 判 TTL（1h / 5m）。
function cacheSegment(payload) {
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

const seg = cacheSegment(payload);
let base = runOriginal(raw);
if (base == null) base = minimalBase(payload);
// 接在末行尾（base 末端即最後一行末端）
const out = seg ? `${base} │ ${seg}` : base;
process.stdout.write(out + '\n');
