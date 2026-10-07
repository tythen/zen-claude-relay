#!/usr/bin/env node
/**
 * test-override.mjs — 证明代理的鉴权覆盖有效：
 * 客户端故意发一个无效的 Authorization，代理应当仍能拿到 Claude。
 * 这模拟的正是桌面端现在的情况（登录 Console 后发出的 st_ 令牌被 Zen 拒绝）。
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8788';
const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';

function sid() {
  const b = randomBytes(26);
  let s = 'ses_';
  for (let i = 0; i < 12; i++) s += HEX[b[i] & 0xf];
  for (let i = 12; i < 26; i++) s += B62[b[i] % 62];
  return s;
}

function send(badAuth, label) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'exo-free',
      stream: true,
      max_tokens: 32,
      messages: [{ role: 'system', content: 'You are OpenCode, an AI coding agent.' }, { role: 'user', content: 'say ping' }],
    });
    const s = sid();
    const tid = randomBytes(16).toString('hex');
    const span = randomBytes(8).toString('hex');
    const req = http.request(
      `${RELAY}/zen/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${badAuth}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'opencode/latest/2.0.24/cli',
          'x-opencode-client': 'cli',
          'x-opencode-project': '0123456789abcdef0123456789abcdef01234567',
          'x-opencode-session': s,
          'x-opencode-session-id': s,
          'x-session-affinity': s,
          'x-session-id': s,
          b3: `${tid}-${span}-1-${randomBytes(8).toString('hex')}`,
          traceparent: `00-${tid}-${span}-01`,
          accept: '*/*',
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ label, status: res.statusCode, body: d }));
      },
    );
    req.on('error', (e) => resolve({ label, status: 0, body: 'ERR ' + e.message }));
    req.setTimeout(90000, () => { req.destroy(); resolve({ label, status: 0, body: 'TIMEOUT' }); });
    req.write(body);
    req.end();
  });
}

for (const [label, bad] of [
  ['无效的 Console 令牌 st_（模拟桌面端现状）', 'st_00000000-0000-0000-0000-000000000000'],
  ['纯垃圾字符串', 'totally-bogus-key-xyz'],
]) {
  const r = await send(bad, label);
  const m = r.body.match(/"id":"((?:msg|resp)_[^"]*)"/);
  const status = r.status === 200 && m ? `\x1b[32m✓ HTTP 200，拿到 ${m[1].startsWith('msg_') ? 'Claude' : 'GPT'} (${m[1]})\x1b[0m` : `\x1b[31m✗ HTTP ${r.status}\x1b[0m`;
  console.log(`\n${label}`);
  console.log(`  ${status}`);
  if (r.status !== 200) console.log('  ' + r.body.slice(0, 180).replace(/\n/g, ' '));
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('');
