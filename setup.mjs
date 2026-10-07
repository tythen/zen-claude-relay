#!/usr/bin/env node
/**
 * setup.mjs — 冷启动向导
 *
 * 一条命令把整套东西装好：
 *   1. 检查 Node 版本
 *   2. 找到 OpenCode
 *   3. 引导你填入 OpenCode Zen 的 API key
 *   4. 生成 config.json
 *   5. 联网验证 key 是否真的可用
 *   6. 修改 OpenCode 的全局配置，把 opencode 提供方指向本代理（会先备份）
 *   7. 问你要不要立刻启动
 *
 * 用法：
 *   node setup.mjs                    # 交互式
 *   node setup.mjs --key oc_sk_xxx    # 直接给 key
 *   node setup.mjs --yes              # 全默认，不问
 *   node setup.mjs --no-opencode      # 不碰 OpenCode 的配置，只打印该写什么
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────────────────────────── 参数

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const AUTO = flag('--yes');
const KEY_ARG = opt('--key');
const PORT = Number(opt('--port', 8788));
const SKIP_OPENCODE = flag('--no-opencode');
const START_NOW = flag('--start');

const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[36m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  B: (s) => `\x1b[1m${s}\x1b[0m`,
};

const say = console.log;
const step = (n, t) => say(`\n${C.b(`[${n}/7]`)} ${C.B(t)}`);

const OPENCODE_CONFIG = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const RELAY_CONFIG = path.join(__dirname, 'config.json');
const EXAMPLE_CONFIG = path.join(__dirname, 'config.example.json');

const rl = input.isTTY && !AUTO ? createInterface({ input, output }) : null;

async function ask(question, dflt = '') {
  if (!rl) return dflt;
  const a = (await rl.question(`${question}${dflt ? C.d(` [${dflt}]`) : ''}: `)).trim();
  return a || dflt;
}

async function askYesNo(question, dflt = true) {
  if (!rl) return dflt;
  const a = (await rl.question(`${question} ${C.d(dflt ? '[Y/n]' : '[y/N]')}: `)).trim().toLowerCase();
  if (!a) return dflt;
  return a === 'y' || a === 'yes';
}

// ───────────────────────────────────────────── 欢迎

say('');
say(C.B('  ┌─────────────────────────────────────────────────────┐'));
say(C.B('  │  zen-claude-relay  冷启动向导                       │'));
say(C.B('  │  让 OpenCode 的 exo-free 只落在 Claude 后端         │'));
say(C.B('  └─────────────────────────────────────────────────────┘'));
say('');
say(C.d('  全程约 1 分钟。随时可以 Ctrl+C 中断，不会留下半成品。'));

// ───────────────────────────────────────────── 1. Node

step(1, '检查运行环境');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  say(C.r(`  ✗ Node 版本过低：v${process.versions.node}`));
  say('    本工具需要 Node 18 以上（用到了内置的 fetch）。');
  say('    去 https://nodejs.org 装一个 LTS 版本再回来。');
  process.exit(1);
}
say(`  ${C.g('✓')} Node v${process.versions.node}`);
say(`  ${C.g('✓')} ${os.platform()} ${os.arch()}`);

// ───────────────────────────────────────────── 2. OpenCode

step(2, '寻找 OpenCode');
let opencodeFound = false;
const which = os.platform() === 'win32' ? 'where' : 'which';
try {
  const out = spawn(which, ['opencode'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  out.stdout?.on('data', (d) => (buf += d));
  await new Promise((r) => {
    out.on('close', r);
    out.on('error', r);
    setTimeout(r, 2000);
  });
  opencodeFound = buf.trim().length > 0;
  if (opencodeFound) say(`  ${C.g('✓')} ${buf.trim().split('\n')[0]}`);
} catch {
  /* 忽略 */
}

if (!opencodeFound) {
  // 沙箱/受限环境里 spawn 可能被拦，退而求其次看配置目录
  const ocDir = path.join(os.homedir(), '.config', 'opencode');
  if (fs.existsSync(ocDir)) {
    opencodeFound = true;
    say(`  ${C.g('✓')} 找到 OpenCode 的配置目录 ${C.d(ocDir)}`);
  }
}
if (!opencodeFound) {
  say(`  ${C.y('!')} 没在 PATH 里找到 opencode 命令`);
  say(C.d('    这不影响代理运行，但你需要先装 OpenCode 才能用它。'));
  say(C.d('    下载：https://opencode.ai'));
} else {
  say(C.d('    注意：请确保 OpenCode 已退出，否则改完配置要重启它才生效。'));
}

// ───────────────────────────────────────────── 3. API key

step(3, 'OpenCode Zen 的 API key');
say(C.d('  这一步不能真正省掉。OpenCode 在没有凭据时，根本不会把 exo-free 列为可选模型'));
say(C.d('  （直接报 "Model unavailable"，请求发都发不出去）。'));
say('');
say(C.d('  两种填法，二选一：'));
say(C.d('    A. 现在就粘贴你的 key —— 代理会用它，与 OpenCode 的登录状态无关（推荐）'));
say(C.d('    B. 留空 —— 前提是你已经用 auth login 配好了 Zen 凭据'));
say('');
say(C.d('  每个人都要用自己的 key，不要共用。获取：https://opencode.ai/auth'));
say('');

let key = KEY_ARG ?? '';
if (!key && rl) key = await ask('  粘贴你的 key（或直接回车留空）');
key = key.trim();

if (key && !key.startsWith('oc_sk_')) {
  say(C.y(`  ! 这个 key 不像 Zen 的格式（一般以 oc_sk_ 开头），继续但可能会失败`));
}
if (key) say(`  ${C.g('✓')} 已记录（${key.slice(0, 12)}…${key.slice(-4)}）`);
else say(`  ${C.d('· 留空：将沿用 OpenCode 自己的凭据（请确认已用 auth login 配好）')}`);

// ───────────────────────────────────────────── 4. 写 config.json

step(4, '生成本地配置 config.json');
let relayCfg = {};
if (fs.existsSync(EXAMPLE_CONFIG)) {
  relayCfg = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
} else {
  relayCfg = {
    listen: { host: '127.0.0.1', port: PORT },
    upstream: 'https://opencode.ai',
    intercept: { models: ['exo-free'], pathSuffix: '/chat/completions' },
    retry: { maxAttempts: 6, peekTimeoutMs: 30000, maxPeekBytes: 262144, regenerateHeaders: ['x-session-affinity', 'x-opencode-session', 'x-opencode-request'], extraHeaders: {} },
    auth: { override: '', applyTo: 'intercepted' },
    classify: { claudePrefixes: ['msg_'], gptPrefixes: ['resp_', 'chatcmpl-'], unknownPolicy: 'forward' },
    logging: { file: 'relay.log', verbose: false },
  };
}

// 去掉模板里的 $comment 说明键，别写进用户的运行配置
const stripComments = (o) => {
  if (Array.isArray(o)) return o.map(stripComments);
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== '$comment').map(([k, v]) => [k, stripComments(v)]));
  }
  return o;
};
relayCfg = stripComments(relayCfg);

relayCfg.listen = { host: '127.0.0.1', port: PORT };
relayCfg.auth = { ...(relayCfg.auth ?? {}), override: key, applyTo: 'intercepted' };

if (fs.existsSync(RELAY_CONFIG)) {
  const keep = await askYesNo(`  config.json 已存在，覆盖它吗？（会丢失你之前的设置）`, false);
  if (!keep) {
    say(`  ${C.y('!')} 保留原文件，只把端口设成 ${PORT}`);
    const old = JSON.parse(fs.readFileSync(RELAY_CONFIG, 'utf8'));
    relayCfg = { ...old, listen: { host: '127.0.0.1', port: PORT } };
    if (key) relayCfg.auth = { ...(relayCfg.auth ?? {}), override: key, applyTo: 'intercepted' };
  }
}

fs.writeFileSync(RELAY_CONFIG, JSON.stringify(relayCfg, null, 2) + '\n');
say(`  ${C.g('✓')} 已写入 ${C.d(RELAY_CONFIG)}`);
say(`  ${C.d(`    监听 127.0.0.1:${PORT}，拦截 ${relayCfg.intercept.models.join(', ')}`)}`);

if (!key) {
  say(`  ${C.d('    提示：也可以把 key 放到 zen-key.txt，或用环境变量 RELAY_ZEN_KEY')}`);
  say(`  ${C.d('    优先级：config.json 的 auth.override → 环境变量 → zen-key.txt')}`);
}

// ───────────────────────────────────────────── 5. 验证 key

step(5, '联网验证 key');
if (!key) {
  say(`  ${C.d('· 没有 key 可验，跳过')}`);
} else {
  const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': 'opencode/latest/2.0.24/cli',
      'x-opencode-client': 'cli',
      'accept-encoding': 'identity',
    },
    body: JSON.stringify({ model: 'exo-free', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ status: 0, _err: e.message, text: async () => '' }));

  const body = await res.text().catch(() => '');

  if (res.status === 403 && /FreeTierError/.test(body)) {
    say(`  ${C.g('✓')} key 有效`);
    say(C.d('    403 FreeTierError 是正常的 —— 免费层要求"必须在 OpenCode 内使用"，'));
    say(C.d('    走本代理就能过这道门禁。'));
  } else if (res.status === 401) {
    say(`  ${C.r('✗')} key 无效（Zen 返回 401 Invalid API key）`);
    say(C.d(`    ${body.slice(0, 160)}`));
    say(C.y('    请检查是否复制完整，或去 https://opencode.ai/auth 重新生成。'));
  } else if (res.status === 0) {
    say(`  ${C.y('!')} 网络不通，没法验证：${res._err}`);
  } else {
    say(`  ${C.y('!')} 未预期响应 HTTP ${res.status}`);
    say(C.d(`    ${body.slice(0, 160)}`));
  }
}

// ───────────────────────────────────────────── 6. 改 OpenCode 配置

step(6, '让 OpenCode 走本代理');
const BASE_URL = `http://127.0.0.1:${PORT}/zen/v1`;
const snippet = {
  $schema: 'https://opencode.ai/config.json',
  provider: { opencode: { options: { baseURL: BASE_URL } } },
};

if (SKIP_OPENCODE) {
  say(C.d('  --no-opencode 已指定，只打印不修改。'));
  say('');
  say(`  请手动把下面内容写进 ${C.B(OPENCODE_CONFIG)}：`);
  say(C.d(JSON.stringify(snippet, null, 2)));
} else {
  let existing = null;
  if (fs.existsSync(OPENCODE_CONFIG)) {
    try {
      existing = JSON.parse(fs.readFileSync(OPENCODE_CONFIG, 'utf8'));
    } catch (e) {
      say(`  ${C.r('✗')} 现有配置不是合法 JSON，不敢动它：${e.message}`);
      say(`    请手动修改，把 provider.opencode.options.baseURL 设成 ${BASE_URL}`);
      existing = 'ABORT';
    }
  }

  if (existing === 'ABORT') {
    /* 已在上面提示 */
  } else {
    if (existing) {
      const bak = `${OPENCODE_CONFIG}.bak-${Date.now()}`;
      fs.copyFileSync(OPENCODE_CONFIG, bak);
      say(`  ${C.g('✓')} 已备份原配置 → ${C.d(path.basename(bak))}`);
    } else {
      fs.mkdirSync(path.dirname(OPENCODE_CONFIG), { recursive: true });
    }

    const merged = existing ?? { $schema: 'https://opencode.ai/config.json' };
    merged.provider = merged.provider ?? {};
    merged.provider.opencode = merged.provider.opencode ?? {};
    merged.provider.opencode.options = { ...(merged.provider.opencode.options ?? {}), baseURL: BASE_URL };

    fs.writeFileSync(OPENCODE_CONFIG, JSON.stringify(merged, null, 2) + '\n');
    say(`  ${C.g('✓')} 已写入 ${C.d(OPENCODE_CONFIG)}`);
    say(`  ${C.d(`    provider.opencode.options.baseURL = ${BASE_URL}`)}`);
    say(C.d('    原有的其它配置都保留着，只动了 baseURL 这一个键。'));
  }
}

// ───────────────────────────────────────────── 7. 启动

step(7, '启动代理');
let launch = START_NOW;
if (!START_NOW && rl) launch = await askYesNo('  现在就启动代理？', true);

if (launch) {
  say(C.d('  正在启动（新窗口）…'));
  try {
    if (os.platform() === 'win32') {
      spawn('cmd', ['/c', 'start', 'zen-claude-relay', 'cmd', '/k', 'node', path.join(__dirname, 'proxy.mjs')], {
        detached: true,
        stdio: 'ignore',
        cwd: __dirname,
      }).unref();
    } else {
      spawn(process.execPath, [path.join(__dirname, 'proxy.mjs')], { detached: true, stdio: 'ignore', cwd: __dirname }).unref();
    }
    await new Promise((r) => setTimeout(r, 2500));

    let alive = false;
    try {
      const h = await fetch(`http://127.0.0.1:${PORT}/__relay/health`, { signal: AbortSignal.timeout(4000) });
      alive = h.ok;
    } catch {
      /* 还没起来 */
    }
    if (alive) say(`  ${C.g('✓')} 代理已在 http://127.0.0.1:${PORT} 运行`);
    else {
      say(`  ${C.y('!')} 没能确认代理已启动，请手动运行：${C.B('node proxy.mjs')}`);
    }
  } catch (e) {
    say(`  ${C.y('!')} 自动启动失败：${e.message}`);
    say(`    请手动运行：${C.B('node proxy.mjs')}`);
  }
} else {
  say(C.d('  跳过。之后手动运行即可：'));
  say(`    ${C.B('node proxy.mjs')}      ${C.d('（或双击 start-relay.cmd）')}`);
}

// ───────────────────────────────────────────── 收尾

say('');
say(C.B('  ═══════════════════════════════════════════════════════'));
say(C.g('   装好了！'));
say(C.B('  ═══════════════════════════════════════════════════════'));
say('');
say('  接下来：');
say(`    1. ${C.B('重启 OpenCode')}（桌面端 / TUI 都要重启才会重读配置）`);
say(`    2. 选模型 ${C.B('exo-free')}，随便发一句话`);
say(`    3. 出问题就跑 ${C.B('node doctor.mjs')} 体检`);
say('');
say(C.d('  注意：代理是个前台进程，关掉窗口它就停了。'));
say(C.d('  想开机自动启动，跑：'));
say(`    ${C.d('Windows:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1')}`);
say(`    ${C.d('macOS/Linux: 见 README 的「开机自启」一节')}`);
say('');

rl?.close();
