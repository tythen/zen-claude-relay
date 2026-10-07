#!/usr/bin/env node
/**
 * auth-test.mjs — 对比两个凭据在 Zen 上到底哪个有效。
 *
 * 原理：鉴权发生在免费层门禁之前，所以裸请求也能判别：
 *   401 Invalid API key   -> 凭据无效
 *   403 FreeTierError     -> 凭据有效，只是被"必须在 OpenCode 内使用"挡住
 */
import https from 'node:https';

const creds = [
  ['oc_sk_ 格式的 key', process.env.CRED_KEYSK],
  ['st_ Console 令牌（桌面端登录存的）', process.env.CRED_ST],
];

function probe(auth) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'exo-free', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
    const req = https.request(
      {
        hostname: 'opencode.ai',
        port: 443,
        path: '/zen/v1/chat/completions',
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'opencode/latest/2.0.24/cli',
          'x-opencode-client': 'cli',
          accept: '*/*',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 220) }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.setTimeout(40000, () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.write(body);
    req.end();
  });
}

for (const [label, auth] of creds) {
  if (!auth) { console.log(`\n${label}\n  (未提供，跳过)`); continue; }
  const r = await probe(auth);
  let verdict;
  if (r.status === 401) verdict = '\x1b[31m✗ 凭据无效（Zen 拒绝了这个 token）\x1b[0m';
  else if (r.status === 403 && /FreeTierError/.test(r.body)) verdict = '\x1b[32m✓ 凭据有效\x1b[0m（只是被免费层门禁挡住，走代理就能过）';
  else if (r.status === 200) verdict = '\x1b[32m✓ 完全可用\x1b[0m';
  else verdict = `? 未预期状态 ${r.status}`;
  console.log(`\n${label}`);
  console.log(`  HTTP ${r.status}  ${verdict}`);
  console.log(`  ${r.body.replace(/\n/g, ' ')}`);
  await new Promise((r) => setTimeout(r, 1200));
}
console.log('');
