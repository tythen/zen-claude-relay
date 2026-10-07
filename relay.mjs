#!/usr/bin/env node
/**
 * relay.mjs — 交互式管理菜单
 *
 * 装完之后日常就用这个：启停、体检、探测、看日志、管自启。
 *
 *   node relay.mjs
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PID_FILE = path.join(__dirname, 'relay.pid');
const LOG_FILE = path.join(__dirname, 'relay.log');

const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[36m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  B: (s) => `\x1b[1m${s}\x1b[0m`,
};
const say = console.log;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}
const PORT = () => readConfig()?.listen?.port ?? 8788;
const HEALTH = () => `http://127.0.0.1:${PORT()}/__relay/health`;

async function health(timeout = 3000) {
  try {
    const r = await fetch(HEALTH(), { signal: AbortSignal.timeout(timeout) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function pidFromFile() {
  try {
    const p = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const rl = createInterface({ input, output });
const ask = async (q, d = '') => {
  const a = (await rl.question(`${q}${d ? C.d(` [${d}]`) : ''}: `)).trim();
  return a || d;
};
const pause = async () => {
  await rl.question(C.d('\n  按回车返回菜单…'));
};

// ────────────────────────────────────────────── 动作

async function showStatus() {
  say('');
  const cfg = readConfig();
  if (!cfg) {
    say(`  ${C.r('✗')} 找不到或读不懂 config.json —— 先跑 node setup.mjs`);
    return;
  }
  say(`  ${C.B('配置')}`);
  say(`    监听       127.0.0.1:${cfg.listen.port}`);
  say(`    上游       ${cfg.upstream}`);
  say(`    拦截模型   ${cfg.intercept.models.join(', ')}`);
  say(`    最多重掷   ${cfg.retry.maxAttempts} 次`);
  const authSrc = cfg.auth?.override
    ? `config.json (${String(cfg.auth.override).slice(0, 12)}…)`
    : process.env.RELAY_ZEN_KEY
      ? '环境变量 RELAY_ZEN_KEY'
      : fs.existsSync(path.join(__dirname, 'zen-key.txt'))
        ? 'zen-key.txt'
        : '未设置（沿用 OpenCode 自己的凭据）';
  say(`    凭据       ${authSrc}`);

  say('');
  say(`  ${C.B('运行状态')}`);
  const h = await health();
  if (!h) {
    say(`    ${C.r('● 未运行')}`);
  } else {
    say(`    ${C.g('● 正在运行')}  (PID ${pidFromFile() ?? '未知'})`);
    const s = h.stats;
    say(`    请求 ${s.requests}  拦截 ${s.intercepted}  Claude ${s.claude}  GPT丢弃 ${s.gpt}  送达 ${s.relayed}  放弃 ${s.exhausted}`);
    const rate = s.claude + s.gpt > 0 ? Math.round((s.gpt / (s.claude + s.gpt)) * 100) : 0;
    say(C.d(`    撞上 GPT 的比例约 ${rate}%`));
  }

  // OpenCode 侧配置
  const ocCfg = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  const base = (() => {
    try {
      return JSON.parse(fs.readFileSync(ocCfg, 'utf8'))?.provider?.opencode?.options?.baseURL ?? null;
    } catch {
      return null;
    }
  })();
  say('');
  say(`  ${C.B('OpenCode 侧')}`);
  if (base === HEALTH().replace('/__relay/health', '/zen/v1')) {
    say(`    ${C.g('✓')} baseURL 已指向本代理`);
  } else if (base) {
    say(`    ${C.y('!')} baseURL = ${base}`);
  } else {
    say(`    ${C.r('✗')} 没有配置 baseURL —— 不会走代理`);
  }
}

async function startProxy() {
  const h = await health();
  if (h) {
    say(`  ${C.y('!')} 已经在跑了（PID ${pidFromFile() ?? '未知'}）`);
    return;
  }
  try {
    spawn(process.execPath, [path.join(__dirname, 'proxy.mjs')], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname,
    }).unref();

    for (let i = 0; i < 15; i++) {
      await sleep(600);
      if (await health()) {
        say(`  ${C.g('✓')} 已启动，监听 127.0.0.1:${PORT()}`);
        return;
      }
    }
    say(`  ${C.y('!')} 启动了但没探测到，看看日志？`);
  } catch (e) {
    say(`  ${C.r('✗')} 启动失败：${e.message}`);
  }
}

async function stopProxy() {
  const h = await health();
  if (!h) {
    say(`  ${C.d('· 本来就没在跑')}`);
    return;
  }
  const pid = pidFromFile();
  if (!pid || !alive(pid)) {
    say(`  ${C.y('!')} 探测到有服务在跑，但读不到它的 PID（relay.pid 缺失）`);
    say(`    请手动去那个窗口按 Ctrl+C，或用任务管理器结束占用 ${PORT()} 端口的进程。`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      if (!(await health(1500))) {
        say(`  ${C.g('✓')} 已停止 (PID ${pid})`);
        return;
      }
    }
    say(`  ${C.y('!')} 发了停止信号但还没退出，可能要多等一会儿`);
  } catch (e) {
    say(`  ${C.r('✗')} 停止失败：${e.message}`);
  }
}

async function restartProxy() {
  await stopProxy();
  await sleep(600);
  await startProxy();
}

function runScript(file, label) {
  say(C.d(`  正在运行 ${file} …\n`));
  return new Promise((resolve) => {
    try {
      const p = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit', cwd: __dirname });
      p.on('close', resolve);
      p.on('error', (e) => {
        say(`  ${C.r('✗')} 跑不起来：${e.message}`);
        resolve();
      });
    } catch (e) {
      say(`  ${C.r('✗')} ${e.message}`);
      resolve();
    }
  });
}

async function showLog() {
  if (!fs.existsSync(LOG_FILE)) {
    say(`  ${C.d('· 还没有日志')}`);
    return;
  }
  const n = Number(await ask('  看最后多少行', '30'));
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
  say('');
  for (const l of lines.slice(-n)) {
    const s = l.replace(/^.*?(\[exo|\[probe|\[relay)/, '$1');
    if (/✓ 放行 \(claude/.test(l)) say('  ' + C.g(s));
    else if (/✗ GPT/.test(l)) say('  ' + C.y(s));
    else if (/403|401|放弃/.test(l)) say('  ' + C.r(s));
    else say('  ' + C.d(s));
  }
}

async function doProbe() {
  const h = await health();
  if (!h) {
    say(`  ${C.r('✗')} 代理没在跑`);
    return;
  }
  if (!h.hasProbeTemplate) {
    say(`  ${C.y('!')} 还没有请求模板 —— 先让 OpenCode 发一条消息再用`);
    return;
  }
  const n = Number(await ask('  探测几次', '5'));
  const mode = await ask('  模式 same/fresh/fixed/none', 'fresh');
  say(C.d('  探测中…'));
  try {
    const r = await fetch(`http://127.0.0.1:${PORT()}/__relay/probe?n=${n}&mode=${mode}`, { signal: AbortSignal.timeout(600000) });
    const j = await r.json();
    if (j.error) {
      say(`  ${C.y('!')} ${j.error}`);
      return;
    }
    say('');
    for (const x of j.results) {
      const tag = x.kind === 'claude' ? C.g('Claude') : x.kind === 'gpt' ? C.y('GPT') : C.r(x.kind);
      say(`    ${String(x.i).padStart(2)}. ${tag}  ${C.d(x.id ?? '')}`);
    }
    say('');
    const counts = Object.entries(j.counts).map(([k, v]) => `${k}=${v}`).join('  ');
    say(`  分布: ${counts}`);
    if (j.counts.claude && !j.counts.gpt) {
      say(`  ${C.g('✓')} 全部落在 Claude —— 重掷路径健康`);
    } else if (j.counts.gpt) {
      say(`  ${C.y('!')} 有 GPT 出现 —— 属正常，代理会丢弃重掷`);
    }
  } catch (e) {
    say(`  ${C.r('✗')} 探测失败：${e.message}`);
  }
}

async function doAutostart() {
  if (os.platform() !== 'win32') {
    say(`  ${C.d('  macOS/Linux 的开机自启见 README 的「开机自启」一节')}`);
    return;
  }
  const inst = path.join(__dirname, 'install-autostart.ps1');
  const unin = path.join(__dirname, 'uninstall-autostart.ps1');
  say('');
  say('  1) 安装开机自启');
  say('  2) 卸载开机自启');
  const pick = await ask('  选哪个', '1');
  const file = pick === '2' ? unin : inst;
  say(C.d(`  正在运行 ${path.basename(file)} …\n`));
  await new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: 'inherit', cwd: __dirname });
    p.on('close', resolve);
    p.on('error', (e) => {
      say(`  ${C.r('✗')} ${e.message}`);
      resolve();
    });
  });
}

async function editConfig() {
  const cfg = readConfig();
  if (!cfg) {
    say(`  ${C.r('✗')} 读不到 config.json`);
    return;
  }
  say('');
  say(`  当前端口: ${cfg.listen.port}`);
  const p = Number(await ask('  新端口（回车不改）', ''));
  if (p && p !== cfg.listen.port) {
    cfg.listen.port = p;
    say(`  ${C.y('!')} 改完端口后，OpenCode 的 baseURL 也要一起改：`);
    say(`    http://127.0.0.1:${p}/zen/v1`);
  }

  say('');
  const cur = cfg.auth?.override ? `${String(cfg.auth.override).slice(0, 12)}…` : '（未设置）';
  say(`  当前凭据: ${cur}`);
  const k = (await ask('  新 Zen key（回车不改，输入 - 表示清空）', '')).trim();
  if (k === '-') {
    cfg.auth = { ...(cfg.auth ?? {}), override: '' };
    say(`  ${C.g('✓')} 已清空，将沿用 OpenCode 自己的凭据`);
  } else if (k) {
    cfg.auth = { ...(cfg.auth ?? {}), override: k, applyTo: 'intercepted' };
    say(`  ${C.g('✓')} 已更新为 ${k.slice(0, 12)}…`);
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  say(`  ${C.g('✓')} config.json 已保存`);
  const h = await health();
  if (h) say(`  ${C.y('!')} 代理正在运行，改动要重启才生效（菜单选 4）`);
}

// ────────────────────────────────────────────── 主循环

const MENU = [
  ['查看状态', showStatus],
  ['启动代理', startProxy],
  ['停止代理', stopProxy],
  ['重启代理', restartProxy],
  ['体检（doctor）', () => runScript('doctor.mjs', 'doctor')],
  ['路由探测', doProbe],
  ['查看日志', showLog],
  ['开机自启（安装/卸载）', doAutostart],
  ['修改配置（端口/凭据）', editConfig],
  ['自测（不需要 key）', () => runScript('test-relay.mjs', 'test')],
];

async function main() {
  for (;;) {
    const h = await health(1500);
    say('');
    say(C.B('  ┌──────────────────────────────────────────────┐'));
    say(C.B('  │  zen-claude-relay  管理台                    │'));
    say(C.B('  └──────────────────────────────────────────────┘'));
    say(
      h
        ? `  状态: ${C.g('● 运行中')}  ${C.d(`127.0.0.1:${PORT()}`)}`
        : `  状态: ${C.r('○ 未运行')}`,
    );
    say('');
    MENU.forEach(([label], i) => say(`    ${C.B(String(i + 1))}) ${label}`));
    say(`    ${C.B('0')}) 退出`);
    say('');

    const pick = await ask('  选一项');
    if (pick === '0' || pick.toLowerCase() === 'q') break;

    const idx = Number(pick) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= MENU.length) {
      say(`  ${C.y('!')} 没这个选项`);
      continue;
    }

    say('');
    say(C.d('  ' + '─'.repeat(52)));
    try {
      await MENU[idx][1]();
    } catch (e) {
      say(`  ${C.r('✗')} 出错了：${e.message}`);
    }
    await pause();
  }
  rl.close();
  say('');
}

main().catch((e) => {
  say(`\n  ${C.r('✗')} ${e.stack || e.message}\n`);
  rl.close();
  process.exit(1);
});
