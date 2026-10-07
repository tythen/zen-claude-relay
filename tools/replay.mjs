#!/usr/bin/env node
/**
 * replay.mjs — 二分定位 Zen 免费层门禁 ("free tier can only be used from within OpenCode")
 * 到底靠哪个请求头通过。
 *
 * 依据：真实 OpenCode 走代理时 Zen 返回 401 Invalid API key（说明门禁已过），
 * 而裸请求返回 403 FreeTierError。差别一定在请求头里。
 */

import https from 'node:https';
import { randomBytes } from 'node:crypto';

const KEY = process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('缺少 OPENCODE_API_KEY');
  process.exit(1);
}

// 从真实 OpenCode 2.0.24 抓到的头
const PROJECT = '0123456789abcdef0123456789abcdef01234567';
const SESSION = 'ses_eeac130b9ffefoM89qy46Cgdr0';
const UA = 'opencode/latest/2.0.24/cli';

function trace() {
  const tid = randomBytes(16).toString('hex');
  const sid = randomBytes(8).toString('hex');
  return { b3: `${tid}-${sid}-1-${randomBytes(8).toString('hex')}`, traceparent: `00-${tid}-${sid}-01` };
}

function call(extraHeaders, label) {
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
      accept: '*/*',
      'accept-encoding': 'identity',
      ...extraHeaders,
    };
    const req = https.request({ hostname: 'opencode.ai', port: 443, path: '/zen/v1/chat/completions', method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
        if (d.length > 1200) {
          req.destroy();
          resolve({ label, status: res.statusCode, body: d.slice(0, 400) });
        }
      });
      res.on('end', () => resolve({ label, status: res.statusCode, body: d.slice(0, 400) }));
      res.on('error', () => resolve({ label, status: res.statusCode, body: d.slice(0, 400) }));
    });
    req.on('error', (e) => resolve({ label, status: 0, body: `ERR ${e.message}` }));
    req.setTimeout(45000, () => {
      req.destroy();
      resolve({ label, status: 0, body: 'TIMEOUT' });
    });
    req.write(body);
    req.end();
  });
}

function verdict(r) {
  if (r.status === 0) return `✗ 网络错误: ${r.body}`;
  if (r.status === 403) {
    let t = '';
    try { t = JSON.parse(r.body)?.error?.type ?? ''; } catch {}
    return t === 'FreeTierError' ? '✗ 被免费层门禁挡住' : `✗ 403 ${r.body.slice(0, 120)}`;
  }
  if (r.status === 401) return '✓ 门禁已过！（401 只是因为 key 无效）';
  if (r.status === 200) return '✓✓ 完全通过，拿到内容';
  return `? ${r.status} ${r.body.slice(0, 150)}`;
}

const t = trace();
const S = { 'x-opencode-session': SESSION, 'x-opencode-session-id': SESSION, 'x-session-affinity': SESSION, 'x-session-id': SESSION };

const cases = [
  ['最小头（复现 403）', { 'user-agent': UA, 'x-opencode-client': 'cli' }],
  ['完整复刻真实 OpenCode 头', { 'user-agent': UA, 'x-opencode-client': 'cli', 'x-opencode-project': PROJECT, ...S, b3: t.b3, traceparent: t.traceparent }],
  ['仅 + user-agent', { 'user-agent': UA }],
  ['仅 + x-opencode-client', { 'x-opencode-client': 'cli' }],
  ['仅 + b3/traceparent', { 'user-agent': UA, 'x-opencode-client': 'cli', b3: t.b3, traceparent: t.traceparent }],
  ['仅 + x-opencode-project', { 'user-agent': UA, 'x-opencode-client': 'cli', 'x-opencode-project': PROJECT }],
  ['仅 + 会话头系列', { 'user-agent': UA, 'x-opencode-client': 'cli', ...S }],
  ['无 user-agent，其余全给', { 'x-opencode-client': 'cli', 'x-opencode-project': PROJECT, ...S, b3: t.b3, traceparent: t.traceparent }],
];

console.log('二分定位 Zen 免费层门禁');
console.log('═'.repeat(74));
const results = [];
for (const [label, headers] of cases) {
  const r = await call(headers, label);
  const v = verdict(r);
  results.push({ label, v, status: r.status });
  console.log(`\n${label}`);
  console.log('  ' + v);
  if (r.status === 200) console.log('  body: ' + r.body.slice(0, 200).replace(/\n/g, ' '));
  await new Promise((r) => setTimeout(r, 900));
}

console.log('\n' + '═'.repeat(74));
const passed = results.filter((r) => r.status === 200 || r.status === 401);
if (passed.length) {
  console.log('通过门禁的组合：');
  for (const p of passed) console.log('  · ' + p.label);
} else {
  console.log('没有任何组合通过 —— 门禁不是靠请求头，可能是 TLS/客户端指纹。');
}
