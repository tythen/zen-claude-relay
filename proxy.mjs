#!/usr/bin/env node
/**
 * zen-claude-relay — 让 OpenCode 的 `opencode/exo-free` 只落到 Claude 后端。
 *
 * 原理
 *   1. OpenCode 用 `@ai-sdk/openai-compatible` 打 `POST {baseURL}/chat/completions`（流式 SSE）。
 *   2. exo-free 在 Zen 网关侧会被随机路由到 Claude 或 GPT 后端，上游返回的
 *      message id 会原样透传：`msg_...` = Claude（Anthropic Messages），
 *      `resp_...` = GPT（OpenAI Responses）。
 *   3. 本代理拿到响应后 **先不下发响应头**，偷看第一段带 id 的 SSE 数据块：
 *        - msg_*  → 照常把字节原样传给客户端（成功）
 *        - resp_* → 立刻断开上游连接，改掉路由相关请求头重发（默认重试 6 次）
 *        - 认不出 → 默认放行（fail-open，避免把本来能用的请求搞坏）
 *   4. 非 exo-free 的请求完全不碰，逐字节原样转发。
 *
 * 零依赖，只用 Node 内置模块。Node >= 18（本机 v24.9.0）。
 *
 * 用法
 *   node proxy.mjs [--port 8788] [--config config.json] [--verbose]
 */

import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pipeline } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────── 配置

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8788 },
  upstream: 'https://opencode.ai',
  // 只有这些 model 名的请求会被拦截检查；其余一律原样转发
  intercept: {
    models: ['exo-free'],
    // 只有路径以它结尾才拦截，避免误伤 /zen/v1/models 之类的元数据请求
    pathSuffix: '/chat/completions',
  },
  retry: {
    maxAttempts: 6,
    peekTimeoutMs: 30000,
    maxPeekBytes: 262144,
    // 重试时替换掉这些请求头，用以“重新掷骰子”
    regenerateHeaders: ['x-session-affinity', 'x-opencode-session', 'x-opencode-request'],
    // 额外附加/覆盖的请求头（留空即不附加）
    extraHeaders: {},
    // 上游返回这些状态码时也当作「可重试」——端点抖动/临时故障。
    // Zen 上 402/503 常表示 "Endpoint is unavailable"，属临时故障而非真的欠费，
    // 实测同一错误会以 402/429/503 交替出现，所以按状态码重试是有意义的。
    retryableStatuses: [402, 500, 502, 503, 504],
    retryStatusDelayMs: 400,
  },
  classify: {
    claudePrefixes: ['msg_'],
    gptPrefixes: ['resp_', 'chatcmpl-'],
    // 'forward' = 认不出就放行；'retry' = 认不出也重试
    unknownPolicy: 'forward',
  },
  // 代理自行替换 Authorization，避免被 OpenCode 的凭据状态影响。
  // override 留空时会依次回退到 RELAY_ZEN_KEY 环境变量、zen-key.txt 文件。
  auth: { override: '', applyTo: 'intercepted' },
  logging: { file: 'relay.log', verbose: false },
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--upstream') out.upstream = argv[++i];
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

const configPath = args.config ? path.resolve(args.config) : path.join(__dirname, 'config.json');
let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`[relay] 配置文件解析失败 ${configPath}: ${e.message}`);
    process.exit(1);
  }
}

const CFG = deepMerge(DEFAULTS, fileConfig);
if (args.port) CFG.listen.port = args.port;
if (args.host) CFG.listen.host = args.host;
if (args.upstream) CFG.upstream = args.upstream;
if (args.verbose) CFG.logging.verbose = true;

const UPSTREAM = new URL(CFG.upstream);
const UPSTREAM_MODULE = UPSTREAM.protocol === 'https:' ? https : http;
const VERBOSE = !!CFG.logging.verbose;

// 极简着色，只用于致命错误提示
const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ─────────────────────────────────────────────────────────────── 鉴权覆盖

function maskKey(k) {
  return k.length > 18 ? `${k.slice(0, 14)}…(${k.length})` : '***';
}

function resolveAuthOverride() {
  const cfgKey = String(CFG.auth?.override ?? '').trim();
  if (cfgKey) return { key: cfgKey, source: 'config.json 的 auth.override' };
  const envKey = String(process.env.RELAY_ZEN_KEY ?? '').trim();
  if (envKey) return { key: envKey, source: 'RELAY_ZEN_KEY 环境变量' };
  try {
    const t = readFileSync(path.join(__dirname, 'zen-key.txt'), 'utf8').trim();
    if (t) return { key: t, source: 'zen-key.txt' };
  } catch {
    /* 没有就算了 */
  }
  return null;
}

const AUTH_OVERRIDE = resolveAuthOverride();

// ─────────────────────────────────────────────────────────────── 日志

let logStream = null;
try {
  const { createWriteStream } = await import('node:fs');
  logStream = createWriteStream(CFG.logging.file ? path.join(__dirname, CFG.logging.file) : path.join(__dirname, 'relay.log'), {
    flags: 'a',
  });
} catch {
  logStream = null;
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  if (VERBOSE) console.log(line);
  logStream?.write(line + '\n');
}
function say(...parts) {
  console.log(...parts);
}

// ─────────────────────────────────────────────────────────────── 统计

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  passthrough: 0,
  intercepted: 0,
  attempts: 0,
  claude: 0,
  gpt: 0,
  unknown: 0,
  relayed: 0,
  exhausted: 0,
  upstreamErrors: 0,
};

// ─────────────────────────────────────────────────────────────── 小工具

// 必须剥掉的 hop-by-hop 头；transfer-encoding 交给 Node 重新分帧
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';

/**
 * 造一个与 OpenCode 真实会话 id 同形状的值。
 * 实测 2.0.24 发的 id 形如 ses_ + 12位小写hex + 14位base62，共 26 字符，例如
 *   ses_a1b2c3d4e5f6G7h8I9j0K1l2M3
 * 形状不对会被免费层门禁以 403 FreeTierError 拒掉。
 */
function freshSessionId() {
  const b = randomBytes(26);
  let s = '';
  for (let i = 0; i < 12; i++) s += HEX[b[i] & 0xf];
  for (let i = 12; i < 26; i++) s += B62[b[i] % 62];
  return `ses_${s}`;
}

/**
 * 重掷时给某个请求头造新值。
 * 实测 OpenCode 2.0.24 的请求头里：
 *   x-session-affinity / x-opencode-session / x-opencode-session-id / x-session-id
 * 都是同一个 `ses_<22位>` 值的会话 id，其中 x-session-affinity 是最可能被网关
 * 用来做「粘性路由」的那个键。x-opencode-request 在当前版本里并不存在，
 * 这里保留它只是为了向前兼容（将来上游真加了也能跟上）。
 */
function freshValue(headerName) {
  const h = headerName.toLowerCase();
  if (h === 'x-session-affinity' || h === 'x-opencode-session' || h === 'x-opencode-session-id' || h === 'x-session-id') {
    return freshSessionId();
  }
  if (h === 'x-opencode-request') return `relay-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
  return randomBytes(32).toString('hex');
}

function classifyId(id) {
  if (typeof id !== 'string' || !id) return 'unknown';
  const { claudePrefixes, gptPrefixes } = CFG.classify;
  if (claudePrefixes.some((p) => id.startsWith(p))) return 'claude';
  if (gptPrefixes.some((p) => id.startsWith(p))) return 'gpt';
  return 'unknown';
}

/**
 * 在 SSE 文本里找第一段带 `id` 字段的数据块。
 * 返回 { kind, id } 或 null（还没看到）。
 */
function makeSseScanner() {
  let text = '';
  return {
    /** @returns {{kind:'claude'|'gpt'|'unknown', id:string|null, done:boolean}|null} */
    push(chunk) {
      text += chunk.toString('utf8');
      let nl;
      while ((nl = text.indexOf('\n')) !== -1) {
        const line = text.slice(0, nl).replace(/\r$/, '');
        text = text.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return { kind: 'unknown', id: null, done: true };
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (obj && typeof obj.id === 'string' && obj.id) {
          return { kind: classifyId(obj.id), id: obj.id, done: false };
        }
      }
      return null;
    },
  };
}

// ─────────────────────────────────────────────────────────────── 上游请求

/**
 * 发一次上游请求，返回 { status, headers, stream }。
 */
function upstreamRequest({ method, reqPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = UPSTREAM_MODULE.request(
      {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
        method,
        path: reqPath,
        headers,
      },
      (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res, abort: () => res.destroy() }),
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('upstream request timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

// 最近一次被拦截的真实 OpenCode 请求，作为探测模板（含 body 与全部头）
let lastIntercept = null;

// ─────────────────────────────────────────────────────────────── 请求体

/**
 * 一次性探测：只读到第一帧带 id 的 SSE 就断开，用来快速摸清路由。
 * 复用真实 OpenCode 的请求模板（头 + body），因为裸请求会被免费层门禁挡住。
 */
function probeOnce({ headers, body, affinity, auth, model }) {
  return new Promise((resolve) => {
    const h = { ...headers, 'content-length': String(body.length), 'accept-encoding': 'identity' };
    delete h.host;
    let sendBody = body;
    if (model) {
      try {
        const b = JSON.parse(body.toString('utf8'));
        b.model = model;
        sendBody = Buffer.from(JSON.stringify(b));
      } catch {
        /* 解析不了就原样发 */
      }
    }
    h['content-length'] = String(sendBody.length);

    if (auth === null) {
      delete h.authorization; // 明确要求：一个凭据都不发
    } else if (auth) {
      h.authorization = auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`;
    } else if (AUTH_OVERRIDE) {
      h.authorization = `Bearer ${AUTH_OVERRIDE.key}`;
    }
    if (affinity) {
      h['x-session-affinity'] = affinity;
      h['x-opencode-session'] = affinity;
      h['x-opencode-session-id'] = affinity;
      h['x-session-id'] = affinity;
    } else if (affinity === null) {
      for (const k of ['x-session-affinity', 'x-opencode-session', 'x-opencode-session-id', 'x-session-id']) delete h[k];
    }
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = UPSTREAM_MODULE.request(
      {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
        method: 'POST',
        path: '/zen/v1/chat/completions',
        headers: h,
      },
      (res) => {
        const scanner = makeSseScanner();
        let text = '';
        res.on('data', (chunk) => {
          text += chunk.toString('utf8');
          const hit = scanner.push(chunk);
          if (hit && hit.id) {
            done({ status: res.statusCode, id: hit.id, kind: hit.kind });
            req.destroy();
          }
        });
        res.on('end', () => done({ status: res.statusCode, id: null, kind: 'no-id-frame', sample: text.slice(0, 200) }));
        res.on('error', () => done({ status: res.statusCode, id: null, kind: 'aborted' }));
      },
    );
    req.on('error', (e) => done({ status: 0, id: null, kind: `err:${e.message}` }));
    req.setTimeout(60000, () => {
      req.destroy();
      done({ status: 0, id: null, kind: 'timeout' });
    });
    req.write(sendBody);
    req.end();
  });
}

const TEMPLATE_FILE = path.join(__dirname, 'probe-template.json');
const PID_FILE = path.join(__dirname, 'relay.pid');

/** 退出时清掉 pid 文件（只在确实是自己写的那份时才删） */
function cleanupPidFile() {
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch {
    /* 无所谓 */
  }
}

/** 把模板落盘，让探测能力能跨代理重启保留。注意：落盘时剥掉 authorization。 */
function saveTemplate() {
  if (!lastIntercept) return;
  try {
    const { authorization, ...safe } = lastIntercept.headers;
    writeFileSync(TEMPLATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), headers: safe, body: lastIntercept.body.toString('base64') }, null, 2));
  } catch {
    /* 落盘失败无所谓 */
  }
}

function loadTemplate() {
  try {
    const t = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8'));
    lastIntercept = { headers: t.headers, body: Buffer.from(t.body, 'base64') };
    return t.savedAt;
  } catch {
    return null;
  }
}

/** 按模式重复探测 n 次，统计落在 Claude / GPT 的分布 */
async function runProbe(n, mode, auth, model) {
  if (!lastIntercept) {
    return { error: '还没有捕获到 exo-free 请求模板。请先用 OpenCode 发一次消息，让代理看到真实请求。' };
  }
  const fixed = freshSessionId();
  const results = [];
  for (let i = 0; i < n; i++) {
    const affinity = mode === 'same' ? undefined : mode === 'none' ? null : mode === 'fixed' ? fixed : freshSessionId();
    const r = await probeOnce({ headers: lastIntercept.headers, body: lastIntercept.body, affinity, auth, model });
    results.push({ i: i + 1, affinity: affinity ? affinity.slice(0, 18) : null, ...r });
    log(`[probe] ${i + 1}/${n} mode=${mode} -> ${r.kind} ${r.id ?? ''}`);
    await new Promise((res) => setTimeout(res, 700));
  }
  const counts = {};
  for (const r of results) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return { mode, n, counts, fixedAffinity: mode === 'fixed' ? fixed : null, bodyBytes: lastIntercept.body.length, results };
}

async function readBody(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────── 响应中继

/**
 * 只剥掉 hop-by-hop 头。content-length / content-encoding 一律保留：
 * 我们转发的是与上游完全相同的字节，所以这些头依然有效。
 */
function relayHeaders(upstreamHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function sendJsonError(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
  });
  res.end(buf);
}

// ─────────────────────────────────────────────────────────────── 主处理

function isIntercepted(req, bodyBuf) {
  const p = (req.url || '').split('?')[0];
  if (!p.endsWith(CFG.intercept.pathSuffix)) return false;
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('json')) return false;
  let parsed;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    return false;
  }
  const model = parsed?.model;
  return typeof model === 'string' && CFG.intercept.models.includes(model);
}

async function handleIntercepted(req, res, bodyBuf, t0) {
  stats.intercepted++;
  lastIntercept = { headers: { ...req.headers }, body: Buffer.from(bodyBuf) };
  saveTemplate();
  const reqPath = req.url;
  const max = CFG.retry.maxAttempts;
  const original = { ...req.headers };
  // 会话短标签，便于按"对话"归组排查
  const sid = String(original['x-opencode-session'] || original['x-session-affinity'] || '');
  const stag = sid ? sid.replace(/^ses_/, '').slice(0, 8) : '--------';

  // 让上游发未压缩的字节，才能可靠地偷看 SSE
  const baseHeaders = { ...original, 'accept-encoding': 'identity' };
  delete baseHeaders.host;
  if (AUTH_OVERRIDE && CFG.auth.applyTo !== 'never') {
    baseHeaders.authorization = `Bearer ${AUTH_OVERRIDE.key}`;
  }

  let lastErr = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    stats.attempts++;
    const headers = { ...baseHeaders };
    if (attempt > 1) {
      for (const h of CFG.retry.regenerateHeaders) headers[h] = freshValue(h);
      for (const [h, v] of Object.entries(CFG.retry.extraHeaders)) headers[h] = v;
    }
    headers['content-length'] = String(bodyBuf.length);
    if (VERBOSE && attempt === 1) log(`[exo]   即将发出的头(顺序敏感): ${JSON.stringify(Object.entries(headers))}`);

    log(`[exo ${stag}] attempt ${attempt}/${max} → ${reqPath}`);
    if (VERBOSE && attempt === 1) log(`[exo]   收到请求头: ${JSON.stringify(req.headers)}`);
    if (VERBOSE && attempt > 1) {
      log(`[exo]   retry headers: ${CFG.retry.regenerateHeaders.map((h) => `${h}=${headers[h]?.slice(0, 24)}…`).join(' ')}`);
    }

    let up;
    try {
      up = await upstreamRequest({ method: req.method, reqPath, headers, body: bodyBuf });
    } catch (e) {
      lastErr = e;
      stats.upstreamErrors++;
      log(`[exo] attempt ${attempt}: 上游连接失败 ${e.message}`);
      await new Promise((r) => setTimeout(r, 250 * attempt));
      continue;
    }

    // 非 200：先看是不是「端点抖动」这类可重试的
    if (up.status !== 200) {
      const chunks = [];
      for await (const c of up.stream) chunks.push(c);
      const buf = Buffer.concat(chunks);

      const retryable = (CFG.retry.retryableStatuses ?? []).includes(up.status);
      if (retryable && attempt < max) {
        stats.upstreamErrors++;
        const wait = (CFG.retry.retryStatusDelayMs ?? 400) * attempt;
        log(
          `[exo ${stag}] attempt ${attempt}: 上游 HTTP ${up.status}（端点抖动？）` +
            `${wait}ms 后重发 — ${buf.toString('utf8').slice(0, 120)}`,
        );
        await sleep(wait);
        continue;
      }

      stats.relayed++;
      log(`[exo ${stag}] attempt ${attempt}: 上游 HTTP ${up.status}，原样转发`);
      res.writeHead(up.status, relayHeaders(up.headers));
      res.end(buf);
      return;
    }

    const ct = String(up.headers['content-type'] || '');
    const isSse = ct.includes('text/event-stream') || /stream/i.test(ct);

    // ── 非流式：整体读完再判断 id
    if (!isSse) {
      const chunks = [];
      for await (const c of up.stream) chunks.push(c);
      const buf = Buffer.concat(chunks);
      let id = null;
      try {
        id = JSON.parse(buf.toString('utf8'))?.id ?? null;
      } catch {
        /* ignore */
      }
      const kind = classifyId(id);
      if (kind === 'gpt' || (kind === 'unknown' && CFG.classify.unknownPolicy === 'retry')) {
        stats.gpt += kind === 'gpt' ? 1 : 0;
        stats.unknown += kind === 'unknown' ? 1 : 0;
        log(`[exo] attempt ${attempt}: 非流式响应命中 GPT (id=${id})，重掷`);
        continue;
      }
      if (kind === 'claude') stats.claude++;
      stats.relayed++;
      log(`[exo] attempt ${attempt}: 非流式响应放行 (id=${id})`);
      res.writeHead(up.status, relayHeaders(up.headers));
      res.end(buf);
      return;
    }

    // ── 流式：偷看第一段带 id 的数据块
    const scanner = makeSseScanner();
    const buffered = [];
    let bufferedBytes = 0;
    let decision = null;
    let decided = false;
    let peekTimedOut = false;
    let resolvePeek;
    const peekDone = new Promise((r) => (resolvePeek = r));
    let peekTimer = null;

    // 结束后先 pause 再摘监听：已到的字节留在流内部缓冲里，pipeline 时不会丢
    const finishPeek = (d) => {
      if (decided) return;
      decided = true;
      if (d && typeof d === 'object' && typeof d.kind === 'string') decision = d;
      clearTimeout(peekTimer);
      up.stream.pause();
      up.stream.off('data', onData);
      up.stream.off('end', finishPeek);
      up.stream.off('close', finishPeek);
      up.stream.off('error', finishPeek);
      resolvePeek();
    };

    const onData = (chunk) => {
      if (decided) return;
      buffered.push(chunk);
      bufferedBytes += chunk.length;
      const hit = scanner.push(chunk);
      if (hit && (hit.kind !== 'unknown' || hit.done)) return finishPeek(hit);
      if (bufferedBytes >= CFG.retry.maxPeekBytes) {
        return finishPeek({ kind: 'unknown', id: null, done: false, reason: 'maxPeekBytes' });
      }
    };

    peekTimer = setTimeout(() => {
      peekTimedOut = true;
      // 认不出就别硬等，按 unknown 放行
      finishPeek({ kind: 'unknown', id: null, done: false, reason: 'peekTimeout' });
    }, CFG.retry.peekTimeoutMs);

    up.stream.on('data', onData);
    up.stream.on('end', finishPeek);
    up.stream.on('close', finishPeek);
    up.stream.on('error', finishPeek);
    await peekDone;

    const kind = decision?.kind ?? 'unknown';
    const id = decision?.id ?? null;

    if (kind === 'gpt' || (kind === 'unknown' && CFG.classify.unknownPolicy === 'retry')) {
      if (kind === 'gpt') stats.gpt++;
      else stats.unknown++;
      log(`[exo ${stag}] attempt ${attempt}: ✗ GPT (id=${id}) — 断开上游，重新请求`);
      up.stream.destroy();
      // 给上游一点时间彻底释放连接
      await new Promise((r) => setTimeout(r, 150 * attempt));
      continue;
    }

    // Claude 或认不出 → 放行
    if (kind === 'claude') stats.claude++;
    else stats.unknown++;
    stats.relayed++;
    log(
      `[exo ${stag}] attempt ${attempt}: ✓ 放行 (${kind}${id ? `, id=${id}` : ''}${peekTimedOut ? ', 偷看超时' : ''})` +
        ` — 用时 ${Date.now() - t0}ms`,
    );

    const outHeaders = relayHeaders(up.headers);
    res.writeHead(up.status, outHeaders);
    for (const c of buffered) res.write(c);
    await new Promise((resolve) => {
      pipeline(up.stream, res, () => resolve());
      res.on('close', () => {
        up.stream.destroy();
        resolve();
      });
    });
    return;
  }

  // 所有尝试都是 GPT / 出错
  stats.exhausted++;
  log(`[exo ${stag}] ✗ ${max} 次全是 GPT 或失败，放弃`);
  if (!res.headersSent) {
    sendJsonError(res, 502, {
      error: {
        type: 'relay_exhausted',
        message:
          `zen-claude-relay: 连续 ${max} 次都被 Zen 路由到 GPT 后端，没有拿到 Claude。` +
          (lastErr ? ` 最后一次错误: ${lastErr.message}` : '') +
          ` 请稍后重试，或在 config.json 里调大 retry.maxAttempts。`,
      },
    });
  }
}

async function handlePassthrough(req, res, bodyBuf) {
  stats.passthrough++;
  const reqPath = req.url;
  const headers = { ...req.headers };
  delete headers.host;
  try {
    const up = await upstreamRequest({ method: req.method, reqPath, headers, body: bodyBuf });
    res.writeHead(up.status, relayHeaders(up.headers));
    await new Promise((resolve) => {
      pipeline(up.stream, res, () => resolve());
      res.on('close', () => {
        up.stream.destroy();
        resolve();
      });
    });
  } catch (e) {
    log(`[passthrough] 失败 ${reqPath}: ${e.message}`);
    if (!res.headersSent) sendJsonError(res, 502, { error: { type: 'relay_upstream', message: e.message } });
  }
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  stats.requests++;

  if (req.url?.startsWith('/__relay/')) {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/__relay/health') {
      sendJsonError(res, 200, {
        ok: true,
        config: { upstream: CFG.upstream, intercept: CFG.intercept, retry: CFG.retry.regenerateHeaders, maxAttempts: CFG.retry.maxAttempts },
        stats,
        authOverride: AUTH_OVERRIDE ? { source: AUTH_OVERRIDE.source, key: maskKey(AUTH_OVERRIDE.key) } : null,
        hasProbeTemplate: !!lastIntercept,
      });
    } else if (u.pathname === '/__relay/probe') {
      const n = Math.min(Number(u.searchParams.get('n')) || 8, 30);
      const mode = u.searchParams.get('mode') || 'fresh';
      const authRaw = u.searchParams.get('auth');
      const auth = authRaw === null ? undefined : authRaw === 'none' ? null : authRaw;
      const model = u.searchParams.get('model') || undefined;
      try {
        sendJsonError(res, 200, await runProbe(n, mode, auth, model));
      } catch (e) {
        sendJsonError(res, 500, { error: String(e.message) });
      }
    } else {
      res.writeHead(404).end();
    }
    return;
  }

  let bodyBuf = Buffer.alloc(0);
  try {
    bodyBuf = await readBody(req);
  } catch (e) {
    log(`[http] 读取请求体失败: ${e.message}`);
    sendJsonError(res, 400, { error: { type: 'relay_bad_request', message: e.message } });
    return;
  }

  try {
    if (isIntercepted(req, bodyBuf)) {
      await handleIntercepted(req, res, bodyBuf, t0);
    } else {
      await handlePassthrough(req, res, bodyBuf);
    }
  } catch (e) {
    log(`[http] 未捕获错误 ${req.url}: ${e.stack || e.message}`);
    if (!res.headersSent) sendJsonError(res, 500, { error: { type: 'relay_internal', message: String(e.message) } });
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    say('');
    say(`  ${C.r(`✗ 端口 ${CFG.listen.port} 已被占用`)}`);
    say('');
    say('  多半是已经有一个代理在跑了。先确认一下：');
    say(`    curl http://127.0.0.1:${CFG.listen.port}/__relay/health`);
    say('');
    say('  如果确实要再开一个，换个端口即可：');
    say(`    node proxy.mjs --port ${CFG.listen.port + 1}`);
    say('  （同时记得把 OpenCode 配置里的 baseURL 端口一起改掉）');
    say('');
    process.exit(1);
  }
  if (e.code === 'EACCES') {
    say(`\n  ${C.r(`✗ 没有权限监听端口 ${CFG.listen.port}`)}\n`);
    process.exit(1);
  }
  throw e;
});

const restoredAt = loadTemplate();
if (restoredAt) log(`[relay] 已恢复上次的探测模板（保存于 ${restoredAt}）`);

process.on('exit', cleanupPidFile);

server.listen(CFG.listen.port, CFG.listen.host, () => {
  try { writeFileSync(PID_FILE, String(process.pid)); } catch { /* 无所谓 */ }
  say('');
  say('  zen-claude-relay  —  让 opencode/exo-free 只走 Claude');
  say('  ─────────────────────────────────────────────────────');
  say(`  监听      http://${CFG.listen.host}:${CFG.listen.port}`);
  say(`  上游      ${CFG.upstream}`);
  say(`  拦截模型  ${CFG.intercept.models.join(', ')}  (路径 *${CFG.intercept.pathSuffix})`);
  say(`  最多重试  ${CFG.retry.maxAttempts} 次，重掷请求头 ${CFG.retry.regenerateHeaders.join(', ')}`);
  say(AUTH_OVERRIDE ? `  鉴权覆盖  ` + AUTH_OVERRIDE.source + ` → ` + maskKey(AUTH_OVERRIDE.key) : `  鉴权覆盖  未启用（沿用 OpenCode 自己的凭据）`);
  say(`  健康检查  http://${CFG.listen.host}:${CFG.listen.port}/__relay/health`);
  say('');
  say('  把 OpenCode 指过来 (opencode.json)：');
  say('  { "provider": { "opencode": { "options": {');
  say(`      "baseURL": "http://${CFG.listen.host}:${CFG.listen.port}/zen/v1"`);
  say('  } } } }');
  say('');
});

process.on('SIGINT', () => {
  say('\n[relay] 关闭中…');
  log('[relay] SIGINT, shutting down');
  cleanupPidFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
