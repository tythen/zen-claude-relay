#!/usr/bin/env node
/**
 * test-relay.mjs — 端到端验证 zen-claude-relay 的核心逻辑（不需要 API key）。
 *
 * 做法：起一个「假 Zen 网关」，按脚本化序列决定这次返回 Claude 还是 GPT，
 * 然后让真代理去打它，断言：
 *   1. GPT 会被丢弃并重掷，直到拿到 Claude
 *   2. 每次重掷的 x-session-affinity 都不一样
 *   3. 一直是 GPT 时最终报 relay_exhausted
 *   4. 非 exo-free 的请求逐字节原样转发，不被碰
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 8801;
const PROXY_PORT = 8799;

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ───────────────────────────────────────────── 假 Zen 网关

let seq = [];
let seen = [];

const CHUNKS = {
  claude: { id: 'msg_01ABCDEFxyz', text: 'HELLO_FROM_CLAUDE_BACKEND' },
  gpt: { id: 'resp_0a1b2c3d4e5f', text: 'HELLO_FROM_GPT_BACKEND' },
};

function frame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseBody(kind) {
  const { id, text } = CHUNKS[kind];
  return (
    frame({ id, object: 'chat.completion.chunk', created: 1, model: 'exo-free', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
    frame({ id, object: 'chat.completion.chunk', created: 1, model: 'exo-free', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) +
    frame({ id, object: 'chat.completion.chunk', created: 1, model: 'exo-free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n'
  );
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/zen/v1/chat/completions') && (() => { try { return JSON.parse(body).model === 'exo-free'; } catch { return false; } })()) {
      const kind = seq.length ? seq.shift() : 'claude';

      // seq 里若是数字，表示这次直接返回该 HTTP 状态码（用来测「端点抖动重试」）
      if (typeof kind === 'number') {
        seen.push({ kind: `status${kind}`, affinity: req.headers['x-session-affinity'] ?? null });
        res.writeHead(kind, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'server_error', message: 'Upstream request failed: Endpoint is unavailable.' } }));
        return;
      }
      seen.push({
        kind,
        affinity: req.headers['x-session-affinity'] ?? null,
        session: req.headers['x-opencode-session'] ?? null,
        relayReq: req.headers['x-opencode-request'] ?? null,
        acceptEncoding: req.headers['accept-encoding'] ?? null,
        body,
      });
      const payload = sseBody(kind);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      // 拆成三段发，模拟真实分块；第一段就带 id
      const third = Math.ceil(payload.length / 3);
      res.write(payload.slice(0, third));
      setTimeout(() => {
        if (res.destroyed) return;
        res.write(payload.slice(third, third * 2));
        setTimeout(() => {
          if (res.destroyed) return;
          res.end(payload.slice(third * 2));
        }, 40);
      }, 40);
      return;
    }
    // 透传测试用的回声端点
    seen.push({
      kind: 'echo',
      relayReq: req.headers['x-opencode-request'] ?? null,
      affinity: req.headers['x-session-affinity'] ?? null,
      acceptEncoding: req.headers['accept-encoding'] ?? null,
      body,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: JSON.parse(body || '{}'), acceptEncoding: req.headers['accept-encoding'] ?? null }));
  });
  req.on('aborted', () => {});
});

// ───────────────────────────────────────────── 主流程

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__relay/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

async function waitForMock(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ping`);
      return true;
    } catch {
      await sleep(100);
    }
  }
  return false;
}

await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
await waitForMock(MOCK_PORT);
console.log(`[test] 假 Zen 网关已启动 :${MOCK_PORT}`);

const proxy = spawn(
  process.execPath,
  [path.join(__dirname, 'proxy.mjs'), '--port', String(PROXY_PORT), '--upstream', `http://127.0.0.1:${MOCK_PORT}`, '--verbose'],
  { cwd: __dirname, stdio: 'ignore' },
);

const ok = await waitForPort(PROXY_PORT);
if (!ok) {
  console.log('[test] 代理没起来，退出');
  proxy.kill();
  mock.close();
  process.exit(1);
}
console.log(`[test] 代理已启动 :${PROXY_PORT}\n`);

async function callProxy(body, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/zen/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

// ── 用例 1：GPT,GPT,Claude → 应当重掷两次后成功
console.log('用例 1 — 前两次 GPT、第三次 Claude，应当重掷后成功');
seq = ['gpt', 'gpt', 'claude'];
seen = [];
{
  const r = await callProxy({ model: 'exo-free', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'x-opencode-session': 'ses_' + 'a'.repeat(64) });
  check('HTTP 200', r.status === 200, `got ${r.status}`);
  check('拿到的是 Claude 的内容', r.text.includes('HELLO_FROM_CLAUDE_BACKEND'), r.text.slice(0, 200));
  check('没有泄漏 GPT 的内容', !r.text.includes('HELLO_FROM_GPT_BACKEND'));
  check('SSE 流完整（含 [DONE]）', r.text.trimEnd().endsWith('data: [DONE]'));
  check('上游共收到 3 次请求', seen.length === 3, `got ${seen.length}`);
  check('第 1 次是原始头（未被改动）', seen[0].session === 'ses_' + 'a'.repeat(64));
  check('第 2、3 次换了新的 x-opencode-session', seen[1].session !== seen[0].session && seen[2].session !== seen[1].session,
    `${seen[1].session?.slice(0, 12)} / ${seen[2].session?.slice(0, 12)}`);
  check('第 2、3 次换了新的 x-session-affinity', !!seen[1].affinity && !!seen[2].affinity && seen[1].affinity !== seen[2].affinity);
  check('重掷用的会话 id 形状正确 (ses_ + 12hex + 14base62 = 26)', /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/.test(seen[1].affinity || ''), seen[1].affinity);
  check('形状不对会被 Zen 门禁 403 —— 这条是回归护栏', seen[1].affinity.length === 30 && seen[1].affinity.slice(4, 16) === seen[1].affinity.slice(4, 16).toLowerCase());
  check('偷看用的流未被压缩（accept-encoding: identity）', seen[0].acceptEncoding === 'identity', seen[0].acceptEncoding);
  check('请求体被完整转发', JSON.parse(seen[0].body).model === 'exo-free');
}
console.log('');

// ── 用例 2：一直是 GPT → 应当报 relay_exhausted
console.log('用例 2 — 六次全是 GPT，应当报错而不是把 GPT 内容给客户端');
seq = ['gpt', 'gpt', 'gpt', 'gpt', 'gpt', 'gpt'];
seen = [];
{
  const r = await callProxy({ model: 'exo-free', stream: true, messages: [] });
  check('HTTP 502', r.status === 502, `got ${r.status}`);
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch {}
  check('错误类型是 relay_exhausted', parsed?.error?.type === 'relay_exhausted', r.text.slice(0, 160));
  check('正好尝试了 6 次', seen.length === 6, `got ${seen.length}`);
  check('客户端没收到任何 GPT 内容', !r.text.includes('HELLO_FROM_GPT_BACKEND'));
}
console.log('');

// ── 用例 3：第一个就是 Claude → 一次成功
console.log('用例 3 — 第一次就是 Claude，应当零重掷');
seq = ['claude'];
seen = [];
{
  const r = await callProxy({ model: 'exo-free', stream: true, messages: [] });
  check('HTTP 200', r.status === 200);
  check('内容是 Claude 的', r.text.includes('HELLO_FROM_CLAUDE_BACKEND'));
  check('上游只被调用 1 次', seen.length === 1, `got ${seen.length}`);
}
console.log('');

// ── 用例 4：非 exo-free → 原样转发
console.log('用例 4 — 其它模型必须原样转发，不被拦截');
seq = [];
seen = [];
{
  const r = await callProxy(
    { model: 'claude-sonnet-4-5', stream: true, messages: [] },
    { 'accept-encoding': 'gzip, deflate' },
  );
  check('HTTP 200', r.status === 200);
  const parsed = JSON.parse(r.text);
  check('上游看到的 accept-encoding 原样保留', parsed.acceptEncoding === 'gzip, deflate', String(parsed.acceptEncoding));
  check('上游只被调用 1 次', seen.length === 1, `got ${seen.length}`);
  check('未被注入 x-opencode-request', seen[0]?.relayReq === null);
}
console.log('');

// ── 用例 5：非流式 exo-free → 也应当识别并重掷
console.log('用例 5 — 非流式请求也应当识别 id 并重掷');
seq = ['gpt', 'claude'];
seen = [];
{
  const r = await callProxy({ model: 'exo-free', stream: false, messages: [] });
  check('HTTP 200', r.status === 200, `got ${r.status}`);
  check('重掷了一次', seen.length === 2, `got ${seen.length}`);
}
console.log('');

// ── 用例 6：上游端点抖动（402/503）应当自动重试
console.log('用例 6 — 上游先返回 503、402，再正常：应当自动重试而非直接报错');
seq = [503, 402, 'claude'];
seen = [];
{
  const r = await callProxy({ model: 'exo-free', stream: true, messages: [] });
  check('HTTP 200（没有被 503/402 直接打回）', r.status === 200, `got ${r.status}`);
  check('最终拿到 Claude 内容', r.text.includes('HELLO_FROM_CLAUDE_BACKEND'));
  check('上游共被调用 3 次（重试了 2 次）', seen.length === 3, `got ${seen.length}`);
  check('第 1 次确实是 503', seen[0].kind === 'status503', seen[0].kind);
  check('第 2 次确实是 402', seen[1].kind === 'status402', seen[1].kind);
}

// ── 用例 7：不可重试的状态码应当立刻回给客户端
console.log('');
console.log('用例 7 — 401（不可重试）应当立刻透传，不做无谓重试');
seq = [401, 'claude'];
seen = [];
{
  const r = await callProxy({ model: 'exo-free', stream: true, messages: [] });
  check('HTTP 401 原样返回', r.status === 401, `got ${r.status}`);
  check('上游只被调用 1 次（没有重试）', seen.length === 1, `got ${seen.length}`);
}
console.log('');

console.log('──────────────────────────────');
console.log(`结果: ${pass} 通过, ${fail} 失败`);

proxy.kill();
mock.close();
await sleep(300);
process.exit(fail === 0 ? 0 : 1);
