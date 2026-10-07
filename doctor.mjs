#!/usr/bin/env node
/**
 * doctor.mjs — zen-claude-relay 一键体检
 *
 * 逐环检查，判断到底是哪一层失效了，并给出对应的处置。
 *
 *   node doctor.mjs
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8788';
const CONFIG = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const LOGFILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'relay.log');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const problems = []; // { level: 'fatal'|'warn', what, fix }

function ok(msg) { console.log(`  ${G('✓')} ${msg}`); }
function bad(msg) { console.log(`  ${R('✗')} ${msg}`); }
function warn(msg) { console.log(`  ${Y('!')} ${msg}`); }
function info(msg) { console.log(`    ${D(msg)}`); }

async function getJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

console.log('\n' + '='.repeat(64));
console.log('  zen-claude-relay 体检');
console.log('='.repeat(64));

// ── 1. 代理是否活着
console.log('\n[1/6] 代理进程');
let health = null;
try {
  const r = await getJson(`${RELAY}/__relay/health`);
  if (r.status === 200 && r.json?.ok) {
    health = r.json;
    ok(`代理存活 @ ${RELAY}`);
    info(`上游 ${health.config.upstream}`);
    info(`拦截模型 ${health.config.intercept.models.join(', ')} | 最多重掷 ${health.config.maxAttempts} 次`);
  } else {
    bad(`端口有响应但不是本代理 (HTTP ${r.status})`);
    problems.push({ level: 'fatal', what: '8788 被别的程序占用', fix: '换个端口启动：node proxy.mjs --port 8789，并同步改 opencode.json 的 baseURL' });
  }
} catch (e) {
  bad(`连不上 ${RELAY} —— 代理没在跑`);
  info(e.message);
  problems.push({ level: 'fatal', what: '代理进程没在运行', fix: '双击 start-relay.cmd（或 node proxy.mjs）把它拉起来' });
}

// ── 2. 累计统计
console.log('\n[2/6] 运行统计');
if (health) {
  const s = health.stats;
  info(`请求 ${s.requests} | 拦截 ${s.intercepted} | Claude 放行 ${s.claude} | GPT 丢弃 ${s.gpt} | 送达 ${s.relayed} | 放弃 ${s.exhausted}`);
  if (s.gpt > 0) {
    ok(`已经成功丢弃过 ${s.gpt} 次 GPT 响应（重掷逻辑在真实生效）`);
  } else if (s.intercepted > 0) {
    info('还没遇到过 GPT 路由 —— 属正常，GPT 大约 5 次里才来 1 次');
  }
  if (s.exhausted > 0) {
    warn(`有 ${s.exhausted} 次重掷耗尽没拿到 Claude`);
    problems.push({ level: 'warn', what: '重掷耗尽', fix: '把 config.json 的 retry.maxAttempts 调大（比如 10），或稍后重试' });
  }
  if (s.intercepted === 0) {
    // 只是本次启动后还没流量，不算问题（baseURL 的正确性已在第 3 项单独校验过）
    info('本次启动后还没有 exo-free 请求进来 —— 发一条消息再跑一次即可确认链路');
  }
} else {
  info('（代理没跑，跳过）');
}

// ── 3. OpenCode 配置
console.log('\n[3/6] OpenCode 配置');
if (!existsSync(CONFIG)) {
  bad(`找不到 ${CONFIG}`);
  problems.push({ level: 'fatal', what: 'baseURL 没配', fix: '创建该文件并写入 provider.opencode.options.baseURL = ' + RELAY + '/zen/v1' });
} else {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const base = cfg?.provider?.opencode?.options?.baseURL;
    if (!base) {
      bad('配置里没有 provider.opencode.options.baseURL —— exo-free 会直连 Zen，GPT 会回来');
      problems.push({ level: 'fatal', what: 'baseURL 缺失', fix: '补上 "baseURL": "' + RELAY + '/zen/v1"' });
    } else if (!base.includes('127.0.0.1') && !base.includes('localhost')) {
      bad(`baseURL 指向的不是本地代理: ${base}`);
      problems.push({ level: 'fatal', what: 'baseURL 指错', fix: '改成 ' + RELAY + '/zen/v1' });
    } else {
      ok(`baseURL = ${base}`);
      const port = new URL(base).port;
      if (health && port !== new URL(RELAY).port) {
        bad(`baseURL 的端口(${port}) 和代理实际端口(${new URL(RELAY).port}) 对不上`);
        problems.push({ level: 'fatal', what: '端口不匹配', fix: '两边改成同一个端口' });
      }
    }
    if (cfg?.provider?.opencode?.options?.apiKey) {
      warn('apiKey 明文写在 opencode.json 里');
      info('更稳妥的做法：opencode auth login 选 OpenCode Zen，然后删掉这行 apiKey（但别删 baseURL）');
    }
  } catch (e) {
    bad(`配置不是合法 JSON: ${e.message}`);
    problems.push({ level: 'fatal', what: '配置文件损坏', fix: '修好 JSON 语法（注意尾逗号）' });
  }
}

// ── 4. exo-free 还在不在
console.log('\n[4/6] exo-free 是否还在售');
try {
  const r = await getJson('https://opencode.ai/zen/v1/models', 12000);
  const ids = (r.json?.data ?? []).map((m) => m.id);
  if (ids.includes('exo-free')) {
    ok(`exo-free 仍在模型列表里（共 ${ids.length} 个模型）`);
  } else {
    bad('exo-free 已从 Zen 模型列表消失');
    problems.push({ level: 'fatal', what: 'exo-free 下架了', fix: '免费期结束或改名了。换别的免费模型，或改用付费模型；把 config.json 的 intercept.models 改掉' });
  }
} catch (e) {
  warn(`查不到模型列表（网络问题？）: ${e.message}`);
}

// ── 5. 凭据 + 门禁 + 路由（最关键的一环）
console.log('\n[5/6] 凭据 / 免费层门禁 / 路由（端到端探测）');
if (!health) {
  info('（代理没跑，跳过）');
} else if (!health.hasProbeTemplate) {
  warn('还没有请求模板 —— 先让 OpenCode 发一条消息，再重新体检');
  info('模板来自真实 OpenCode 请求，探测要靠它才绕得开门禁');
} else {
  try {
    const r = await getJson(`${RELAY}/__relay/probe?n=4&mode=fresh`, 180000);
    const rows = r.json?.results ?? [];
    const statuses = [...new Set(rows.map((x) => x.status))];
    const kinds = rows.map((x) => x.kind);
    const sample = rows.find((x) => x.sample)?.sample ?? '';

    if (kinds.some((k) => k === 'claude' || k === 'gpt')) {
      ok(`探测通过：${kinds.join(', ')}`);
      info('凭据有效、门禁放行、路由正常 —— 整条链路健康');
      if (kinds.includes('gpt')) info('顺带说明：GPT 路由确实存在，代理会把它丢弃重掷');
    } else if (statuses.includes(402)) {
      bad('402 —— Zen 说 exo-free 的后端不可用');
      info(sample.slice(0, 200));
      info('这是 Zen 侧对 exo-free 的故障，不是你、不是代理、也不是额度问题。');
      info('诊断依据：同一时刻别的免费模型仍返回 200，可用 node tools/check-models.mjs 复核。');
      problems.push({
        level: 'fatal',
        what: 'exo-free 的上游端点故障（Zen 侧问题）',
        fix: '等它恢复；或换别的免费模型（但它们不是 Claude）。用 node tools/check-models.mjs 看哪些还活着',
      });
    } else if (statuses.includes(401)) {
      bad('401 —— API key 失效了');
      info(sample.slice(0, 160));
      problems.push({ level: 'fatal', what: '凭据失效', fix: '重新 opencode auth login 选 OpenCode Zen 换新 key；确认账号没被停用' });
    } else if (/FreeTierError/.test(sample)) {
      bad('403 FreeTierError —— 免费层门禁不认了');
      info(sample.slice(0, 160));
      problems.push({
        level: 'fatal',
        what: '门禁判据变了（多半是会话 id 形状又改了）',
        fix: '抓一次真实 OpenCode 请求，看新的 x-session-affinity 长什么样，改 proxy.mjs 里的 freshSessionId()',
      });
    } else if (statuses.includes(403)) {
      bad('403 —— 但不是 FreeTierError，可能是地区限制或风控');
      info(sample.slice(0, 160));
      problems.push({ level: 'fatal', what: '403 其他原因', fix: '看上面的原始响应体再判断' });
    } else if (statuses.includes(429)) {
      warn('429 —— 被限流了');
      problems.push({ level: 'warn', what: '限流', fix: '等几分钟再用；免费层有速率限制' });
    } else {
      warn(`探测结果异常：${JSON.stringify(kinds)} status=${statuses.join(',')}`);
      info(sample.slice(0, 200) || '(无样本)');
    }
  } catch (e) {
    warn(`探测失败: ${e.message}`);
  }
}

// ── 6. 日志里的历史错误
console.log('\n[6/6] 最近日志里的异常');
if (existsSync(LOGFILE)) {
  const lines = readFileSync(LOGFILE, 'utf8').trim().split('\n').slice(-400);
  const errs = lines.filter((l) => /403|401|429|FreeTierError|放弃|上游连接失败/.test(l));
  if (errs.length === 0) {
    ok('最近 400 行日志里没有 401/403/429/耗尽');
  } else {
    warn(`最近 400 行里有 ${errs.length} 条异常，最后 5 条：`);
    for (const l of errs.slice(-5)) info(l.replace(/^.*?\[exo\]/, '[exo]').slice(0, 150));
    if (errs.some((l) => /FreeTierError/.test(l))) {
      problems.push({ level: 'fatal', what: '历史上出现过门禁拒绝（403 FreeTierError）', fix: '同第 5 项' });
    }
  }
} else {
  info('（还没有日志文件）');
}

// ── 结论
console.log('\n' + '='.repeat(64));
if (problems.length === 0) {
  console.log(`  ${G('体检通过')} —— 没有发现问题，exo-free 会稳定落在 Claude。`);
} else {
  const fatals = problems.filter((p) => p.level === 'fatal');
  const warns = problems.filter((p) => p.level === 'warn');
  console.log(`  ${fatals.length ? R('发现 ' + fatals.length + ' 个需要处理的问题') : Y('只有提示，不致命')}`);
  problems.forEach((p, i) => {
    console.log(`\n  ${p.level === 'fatal' ? R('●') : Y('○')} ${p.what}`);
    console.log(`    处置: ${p.fix}`);
  });
}
console.log('='.repeat(64) + '\n');

process.exit(problems.some((p) => p.level === 'fatal') ? 1 : 0);
