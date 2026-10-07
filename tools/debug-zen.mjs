#!/usr/bin/env node
// debug-zen.mjs — 打印 Zen 的原始响应，用于诊断 401/403/429
import https from 'node:https';

const KEY = process.env.OPENCODE_API_KEY;

function call({ path, method = 'POST', body, headers = {} }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = {
      authorization: `Bearer ${KEY}`,
      'user-agent': 'opencode/latest/2.0.24/cli',
      accept: 'application/json',
      ...headers,
    };
    if (payload) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: 'opencode.ai', port: 443, path, method, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: `ERR ${e.message}` }));
    req.setTimeout(45000, () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: 'TIMEOUT' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const results = [];

results.push(['GET /zen/v1/models (无鉴权)', await call({ path: '/zen/v1/models', method: 'GET' })]);

results.push([
  'GET /zen/v1/models (带鉴权)',
  await call({ path: '/zen/v1/models', method: 'GET', headers: { accept: 'application/json' } }),
]);

results.push([
  'POST /zen/v1/chat/completions exo-free 非流式',
  await call({
    path: '/zen/v1/chat/completions',
    body: { model: 'exo-free', stream: false, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
  }),
]);

results.push([
  'POST /zen/v1/chat/completions exo-free 流式',
  await call({
    path: '/zen/v1/chat/completions',
    body: { model: 'exo-free', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    headers: { accept: 'text/event-stream' },
  }),
]);

results.push([
  'POST /zen/v1/chat/completions big-pickle 非流式 (另一个免费模型)',
  await call({
    path: '/zen/v1/chat/completions',
    body: { model: 'big-pickle', stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  }),
]);

for (const [name, r] of results) {
  console.log('\n' + '='.repeat(72));
  console.log(name);
  console.log('-'.repeat(72));
  console.log('status:', r.status);
  const interesting = ['content-type', 'x-request-id', 'cf-ray', 'www-authenticate', 'retry-after', 'server'];
  for (const k of interesting) if (r.headers[k]) console.log(`  ${k}: ${r.headers[k]}`);
  console.log('body:', r.body.slice(0, 700));
}
