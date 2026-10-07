#!/usr/bin/env node
/**
 * gate-test.mjs — 单发一次，复刻「代理实际转发出去」的头，判断免费层门禁
 * 到底是「看请求头」还是「看频率/时间窗」。
 */
import https from 'node:https';
import { randomBytes } from 'node:crypto';

const KEY = process.env.OPENCODE_API_KEY;
const PROJECT = '0123456789abcdef0123456789abcdef01234567';

function trace() {
  const tid = randomBytes(16).toString('hex');
  const sid = randomBytes(8).toString('hex');
  return { b3: `${tid}-${sid}-1-${randomBytes(8).toString('hex')}`, traceparent: `00-${tid}-${sid}-01` };
}

function one(label, opts = {}) {
  return new Promise((resolve) => {
    const t = trace();
    const body = JSON.stringify({
      model: 'exo-free',
      stream: true,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: 'You are OpenCode, an AI coding agent.' },
        { role: 'user', content: 'hi' },
      ],
    });
    const headers = {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'user-agent': opts.ua ?? 'opencode/latest/2.0.24/cli',
      b3: t.b3,
      traceparent: t.traceparent,
      'x-opencode-client': 'cli',
      'x-opencode-project': PROJECT,
      'x-opencode-session': opts.session ?? 'ses_a1b2c3d4e5f6G7h8I9j0K1l2M3',
      'x-opencode-session-id': opts.session ?? 'ses_a1b2c3d4e5f6G7h8I9j0K1l2M3',
      'x-session-affinity': opts.affinity ?? opts.session ?? 'ses_a1b2c3d4e5f6G7h8I9j0K1l2M3',
      'x-session-id': opts.session ?? 'ses_a1b2c3d4e5f6G7h8I9j0K1l2M3',
      accept: opts.accept ?? '*/*',
      'accept-encoding': opts.ae ?? 'identity',
      ...(opts.extra ?? {}),
    };
    if (opts.drop) for (const h of opts.drop) delete headers[h];

    const req = https.request({ hostname: 'opencode.ai', port: 443, path: '/zen/v1/chat/completions', method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
        if (d.includes('msg_') || d.includes('resp_') || d.length > 900) {
          req.destroy();
          resolve({ label, status: res.statusCode, body: d.slice(0, 350) });
        }
      });
      res.on('end', () => resolve({ label, status: res.statusCode, body: d.slice(0, 350) }));
      res.on('error', () => resolve({ label, status: res.statusCode, body: d.slice(0, 350) }));
    });
    req.on('error', (e) => resolve({ label, status: 0, body: `ERR ${e.message}` }));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ label, status: 0, body: 'TIMEOUT' });
    });
    req.write(body);
    req.end();
  });
}

const label = process.argv[2] ?? '完整复刻';
const r = await one(label);
console.log(`[${label}] status=${r.status}`);
console.log('body: ' + r.body.replace(/\n/g, ' ').slice(0, 350));
const m = r.body.match(/"id":"((?:msg|resp)_[^"]+)"/);
if (m) console.log('>>> 第一帧 id: ' + m[1]);
