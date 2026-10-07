#!/usr/bin/env node
/**
 * probe.mjs — 用真实 Zen 凭据，实测 exo-free 的路由行为。
 *
 * 目的：搞清楚「GPT/Claude 到底是怎么被选中的」，从而确定重掷该改哪个请求头。
 * 做法：每个请求只读到第一条带 id 的 SSE 帧就立刻断开，所以又快又省。
 *
 * 用法：
 *   $env:OPENCODE_API_KEY = "oc_sk_..."; node probe.mjs [--n 10]
 */

import https from 'node:https';
import { randomBytes } from 'node:crypto';

const KEY = process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('缺少 OPENCODE_API_KEY 环境变量');
  process.exit(1);
}

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const N = Number(getArg('--n', 10));

const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function freshSessionId() {
  const b = randomBytes(22);
  let s = '';
  for (let i = 0; i < 22; i++) s += B62[b[i] % 62];
  return `ses_${s}`;
}

function classify(id) {
  if (!id) return 'unknown';
  if (id.startsWith('msg_')) return 'claude';
  if (id.startsWith('resp_')) return 'gpt';
  if (id.startsWith('chatcmpl-')) return 'gpt(chatcmpl)';
  return `unknown(${id.slice(0, 12)})`;
}

/** 发一次请求，读到第一帧带 id 的 SSE 就断开。返回 {id, kind, raw, status} */
function probeOnce({ affinity, label }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'exo-free',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const headers = {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      'user-agent': 'opencode/latest/2.0.24/cli',
      'x-opencode-client': 'cli',
    };
    if (affinity) {
      headers['x-session-affinity'] = affinity;
      headers['x-opencode-session'] = affinity;
    }

    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {}
      resolve(r);
    };

    const req = https.request(
      {
        hostname: 'opencode.ai',
        port: 443,
        path: '/zen/v1/chat/completions',
        method: 'POST',
        headers,
      },
      (res) => {
        let text = '';
        let buf = '';
        res.on('data', (chunk) => {
          text += chunk.toString('utf8');
          buf += chunk.toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let obj;
            try {
              obj = JSON.parse(payload);
            } catch {
              continue;
            }
            if (typeof obj.id === 'string' && obj.id) {
              return done({ status: res.statusCode, id: obj.id, kind: classify(obj.id), raw: line.slice(0, 200), label });
            }
          }
        });
        res.on('end', () => done({ status: res.statusCode, id: null, kind: 'no-id-frame', raw: text.slice(0, 300), label }));
        res.on('error', () => done({ status: res.statusCode, id: null, kind: 'stream-error', raw: text.slice(0, 300), label }));
      },
    );
    req.on('error', (e) => done({ status: 0, id: null, kind: `req-error:${e.message}`, raw: '', label }));
    req.setTimeout(60000, () => done({ status: 0, id: null, kind: 'timeout', raw: '', label }));
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarize(name, results) {
  const counts = {};
  for (const r of results) counts[r.kind] = (counts[r.kind] || 0) + 1;
  console.log(`\n  [${name}] 分布: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  return counts;
}

// ────────────────────────────────────────────── 主流程

console.log(`exo-free 路由行为实测 (每个变体 n=${N})`);
console.log('═'.repeat(70));

// Phase A：完全不发亲和键
console.log('\n【阶段 A】不发送 x-session-affinity');
const A = [];
for (let i = 0; i < N; i++) {
  const r = await probeOnce({ label: `A${i + 1}` });
  A.push(r);
  console.log(`  ${String(i + 1).padStart(2)}. ${r.kind.padEnd(20)} id=${r.id ?? '(无)'}  status=${r.status}`);
  await sleep(1200);
}
const cA = summarize('无亲和键', A);

// Phase B：固定同一个亲和键
const FIXED = freshSessionId();
console.log(`\n【阶段 B】固定同一个 x-session-affinity = ${FIXED}`);
const B = [];
for (let i = 0; i < N; i++) {
  const r = await probeOnce({ affinity: FIXED, label: `B${i + 1}` });
  B.push(r);
  console.log(`  ${String(i + 1).padStart(2)}. ${r.kind.padEnd(20)} id=${r.id ?? '(无)'}  status=${r.status}`);
  await sleep(1200);
}
const cB = summarize('固定亲和键', B);

// Phase C：每次都换新亲和键
console.log('\n【阶段 C】每次都用全新的 x-session-affinity');
const C = [];
for (let i = 0; i < N; i++) {
  const aff = freshSessionId();
  const r = await probeOnce({ affinity: aff, label: `C${i + 1}` });
  C.push(r);
  console.log(`  ${String(i + 1).padStart(2)}. ${r.kind.padEnd(20)} id=${r.id ?? '(无)'}  affinity=${aff.slice(0, 14)}…`);
  await sleep(1200);
}
const cC = summarize('每次换新亲和键', C);

// ────────────────────────────────────────────── 结论

console.log('\n' + '═'.repeat(70));
console.log('结论');
console.log('─'.repeat(70));

const distinctB = new Set(B.map((r) => r.kind));
const distinctC = new Set(C.map((r) => r.kind));

if (B[0].kind.startsWith('req-error') || B[0].kind === 'timeout') {
  console.log('· 探测本身失败，先解决连通性/凭据问题：', B[0].kind, B[0].raw.slice(0, 200));
} else {
  console.log(`· 阶段 A（无亲和键）        出现 ${Object.keys(cA).length} 种后端`);
  console.log(`· 阶段 B（固定亲和键）      出现 ${distinctB.size} 种后端  -> ${distinctB.size === 1 ? '★ 粘性！同一个键始终同一个后端' : '非粘性'}`);
  console.log(`· 阶段 C（每次换新亲和键）  出现 ${distinctC.size} 种后端  -> ${distinctC.size > 1 ? '★ 换键确实能改变路由' : '换键没用'}`);

  if (distinctB.size === 1 && distinctC.size > 1) {
    console.log('\n>>> 判定：路由由 x-session-affinity 粘住。代理「换新亲和键重试」的策略可行。');
  } else if (distinctB.size > 1) {
    console.log('\n>>> 判定：路由本来就是每次随机的，粘性亲和键不是必需 —— 单纯重发即可重掷。');
  } else {
    console.log('\n>>> 判定：不确定。可能路由只看账号/IP，或还有别的键在起作用。');
    console.log('    建议：把 x-opencode-session-id / x-session-id 也加进 config.json 的 retry.regenerateHeaders 再试。');
  }
}

// 打印一条原始帧，确认 id 形态
const sample = [...A, ...B, ...C].find((r) => r.id);
if (sample) {
  console.log('\n原始首帧样例:');
  console.log('  ' + sample.raw);
}
