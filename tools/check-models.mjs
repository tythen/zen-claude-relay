#!/usr/bin/env node
/**
 * check-models.mjs — 逐个体检 Zen 的免费模型，看哪些还能用。
 *
 * 当某个模型报 "Endpoint is unavailable" / 402 时，用这个一眼看出
 * 是「整个账号出问题」还是「只有那一个模型的后端挂了」。
 *
 * 原理：复用代理已捕获的真实 OpenCode 请求模板，逐个换 model 字段去试。
 * 所以需要先让 OpenCode 至少发过一次消息。
 *
 *   node tools/check-models.mjs
 *   node tools/check-models.mjs --all        # 连付费模型也测（会暴露余额问题）
 *   node tools/check-models.mjs --n 2        # 每个模型测 2 次
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const ALL = argv.includes('--all');
const N = Number(opt('--n', 1));

const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  B: (s) => `\x1b[1m${s}\x1b[0m`,
};

function relayPort() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).listen.port;
  } catch {
    return 8788;
  }
}
const PORT = relayPort();
const RELAY = `http://127.0.0.1:${PORT}`;

let health;
try {
  const r = await fetch(`${RELAY}/__relay/health`, { signal: AbortSignal.timeout(4000) });
  health = r.ok ? await r.json() : null;
} catch {
  health = null;
}

if (!health) {
  console.log(`\n  ${C.r('✗')} 代理没在跑。先启动：node proxy.mjs\n`);
  process.exit(1);
}
if (!health.hasProbeTemplate) {
  console.log(`\n  ${C.y('!')} 还没有请求模板。`);
  console.log(`    先让 OpenCode 发一条消息（随便哪个模型），代理捕获到模板后才能探测。\n`);
  process.exit(1);
}

// 拿 Zen 的公开模型列表
let ids = [];
try {
  const r = await fetch('https://opencode.ai/zen/v1/models', { signal: AbortSignal.timeout(15000) });
  ids = (await r.json()).data.map((m) => m.id);
} catch (e) {
  console.log(`\n  ${C.r('✗')} 拉不到 Zen 模型列表：${e.message}\n`);
  process.exit(1);
}

const targets = ALL ? ids : ids.filter((i) => i.endsWith('-free'));

console.log('');
console.log(C.B(`  Zen 模型体检  —  共 ${ids.length} 个模型，本次测 ${targets.length} 个`));
console.log(C.d('  ' + '─'.repeat(64)));

const results = [];
for (const m of targets) {
  let status = 0;
  let note = '';
  for (let i = 0; i < N; i++) {
    try {
      const r = await fetch(`${RELAY}/__relay/probe?n=1&mode=fresh&model=${encodeURIComponent(m)}`, {
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json();
      const x = j.results?.[0];
      status = x?.status ?? 0;
      if (x?.id) note = x.id;
      else if (x?.sample) note = x.sample.replace(/^\{.*?"message":"?/, '').replace(/"?\}*$/, '').slice(0, 58);
    } catch (e) {
      status = 0;
      note = e.message.slice(0, 50);
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  let verdict;
  if (status === 200) verdict = C.g('✓ 可用  ');
  else if (status === 402) verdict = C.r('✗ 402 后端故障');
  else if (status === 403 && /Model access is disabled/i.test(note)) verdict = C.y('· 无权限（要付费）');
  else if (status === 403) verdict = C.y('! 403 门禁/风控');
  else if (status === 401) verdict = C.r('✗ 401 凭据失效');
  else if (status === 429) verdict = C.y('! 429 限流');
  else verdict = C.y(`? ${status}`);

  console.log(`  ${verdict}  ${m.padEnd(36)} ${C.d(note)}`);
  results.push({ m, status });
}

console.log(C.d('  ' + '─'.repeat(64)));
const okCount = results.filter((r) => r.status === 200).length;
const dead = results.filter((r) => r.status === 402);
const noPerm = results.filter((r) => r.status === 403);

console.log(`  ${C.g(okCount + ' 个可用')}   ${dead.length ? C.r(dead.length + ' 个后端故障') : ''}   ${noPerm.length ? C.y(noPerm.length + ' 个无权限') : ''}`);
if (dead.length) {
  console.log('');
  console.log(`  ${C.y('后端故障的模型：')}${dead.map((r) => r.m).join(', ')}`);
  console.log(C.d('  这类是 Zen 侧的问题，等它恢复即可 —— 不是你、不是代理、也不是额度。'));
}
console.log('');
