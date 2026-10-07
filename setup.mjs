#!/usr/bin/env node
/**
 * setup.mjs — 冷启动向导（交互式）
 *
 * 把 README 里那一堆步骤变成一路跟着走就行：
 *
 *   阶段一 预检   Node 版本 / OpenCode / 网络 / exo-free 是否在售 / 端口是否空闲
 *   阶段二 配置   索要 Zen 凭据 → 联网验证 → 写 config.json → 改 OpenCode 配置（自动备份）
 *   阶段三 启动   拉起代理 → 等你真发一条消息 → 检查它是否真的落到了 Claude
 *   阶段四 可选   注册开机自启
 *
 * 用法：
 *   node setup.mjs                    交互式
 *   node setup.mjs --key oc_sk_xxx    直接给 key
 *   node setup.mjs --yes              全默认，不问（CI / 脚本用）
 *   node setup.mjs --no-opencode      不碰 OpenCode 配置，只打印该写什么
 *   node setup.mjs --skip-verify      跳过端到端验证
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────── 参数与着色

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};

const AUTO = flag('--yes');
const KEY_ARG = opt('--key');
const PORT = Number(opt('--port', 8788));
const SKIP_OPENCODE = flag('--no-opencode');
const SKIP_VERIFY = flag('--skip-verify');
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
const hr = () => say(C.d('  ' + '─'.repeat(56)));

let stepNo = 0;
const TOTAL = 8;
const step = (t) => say(`\n${C.b(`[${++stepNo}/${TOTAL}]`)} ${C.B(t)}`);
const ok = (m) => say(`  ${C.g('✓')} ${m}`);
const warn = (m) => say(`  ${C.y('!')} ${m}`);
const bad = (m) => say(`  ${C.r('✗')} ${m}`);
const hint = (m) => say(`  ${C.d('  ' + m)}`);

const OPENCODE_CONFIG = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const RELAY_CONFIG = path.join(__dirname, 'config.json');
const EXAMPLE_CONFIG = path.join(__dirname, 'config.example.json');
const BASE_URL = `http://127.0.0.1:${PORT}/zen/v1`;

let rl = input.isTTY && !AUTO ? createInterface({ input, output }) : null;

async function ask(q, dflt = '') {
  if (!rl) return dflt;
  const a = (await rl.question(`${q}${dflt ? C.d(` [${dflt}]`) : ''}: `)).trim();
  return a || dflt;
}
async function askYesNo(q, dflt = true) {
  if (!rl) return dflt;
  const a = (await rl.question(`${q} ${C.d(dflt ? '[Y/n]' : '[y/N]')}: `)).trim().toLowerCase();
  return a === '' ? dflt : a === 'y' || a === 'yes';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fatal = [];
function die(msg, ...hints) {
  say('');
  bad(msg);
  for (const h of hints) hint(h);
  say('');
  rl?.close();
  process.exit(1);
}

// ──────────────────────────────────────────────── 开场

say('');
say(C.B('  ╔═════════════════════════════════════════════════════╗'));
say(C.B('  ║   zen-claude-relay  冷启动向导                      ║'));
say(C.B('  ║   让 OpenCode 的 exo-free 只落在 Claude 后端        ║'));
say(C.B('  ╚═════════════════════════════════════════════════════╝'));
say('');
say(C.d('  全程约 2 分钟，会做 8 项检查。Ctrl+C 随时可中断，不会留下半成品。'));
say(C.d('  预检不通过的地方会直接告诉你缺什么、怎么补。'));

// ════════════════════════════════════════════════ 阶段一：预检

// ── 1. Node
step('检查 Node.js');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  die(
    `Node 版本过低：v${process.versions.node}`,
    '本工具需要 Node 18 以上（用到了内置的 fetch）。',
    '去 https://nodejs.org 装一个 LTS 版本再回来。',
  );
}
ok(`Node v${process.versions.node}`);
hint(`${os.platform()} ${os.arch()}`);

// ── 2. OpenCode
step('检查 OpenCode');
let opencodeVersion = null;
{
  const bin = os.platform() === 'win32' ? 'opencode.cmd' : 'opencode';
  opencodeVersion = await new Promise((resolve) => {
    let done = false;
    try {
      // 传整条命令（而不是 args 数组 + shell）以避免 Node 的 DEP0190 警告
      const p = spawn('opencode --version', { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
      let buf = '';
      p.stdout?.on('data', (d) => (buf += d));
      p.on('error', () => {
        if (!done) { done = true; resolve(null); }
      });
      p.on('close', () => {
        if (!done) { done = true; resolve(buf.trim() || null); }
      });
      setTimeout(() => {
        if (!done) { done = true; try { p.kill(); } catch {} resolve(null); }
      }, 8000);
    } catch {
      resolve(null);
    }
  });
}

const ocConfigDir = path.join(os.homedir(), '.config', 'opencode');
const ocConfigExists = fs.existsSync(ocConfigDir);

let opencodeDetected = false;
if (opencodeVersion) {
  opencodeDetected = true;
  ok(`opencode ${opencodeVersion}`);
  if (!/^v?2\./.test(opencodeVersion.replace(/^opencode\s*/i, ''))) {
    warn('版本看起来不是 2.x —— 本项目是针对 2.0.x 逆向的，旧版本行为可能不同');
  }
} else if (ocConfigExists) {
  opencodeDetected = true;
  warn('没能拿到 opencode 版本号，但发现了它的配置目录');
  hint(ocConfigDir);
  hint('（受限环境下无法执行子进程时会这样，通常不影响使用）');
} else {
  bad('没找到 OpenCode');
  hint('代理本身能跑，但你得先装 OpenCode 才能用它。');
  hint('下载：https://opencode.ai');
  const go = await askYesNo('  仍然继续吗？', false);
  if (!go) { rl?.close(); process.exit(1); }
}

// ── 3. 网络
step('检查网络');
let netOk = false;
try {
  const r = await fetch('https://opencode.ai/zen/v1/models', { signal: AbortSignal.timeout(15000) });
  netOk = r.ok;
  if (netOk) ok('能连上 opencode.ai');
  else { bad(`opencode.ai 返回 HTTP ${r.status}`); }
} catch (e) {
  bad(`连不上 opencode.ai：${e.message}`);
  hint('检查代理/VPN/防火墙设置。');
}
if (!netOk) {
  die('网络不通，后面的检查没法做。', '把网络弄通再重新跑本向导。');
}

// ── 4. exo-free 是否还在售
step('检查 exo-free 是否还在售');
let exoAvailable = false;
try {
  const r = await fetch('https://opencode.ai/zen/v1/models', { signal: AbortSignal.timeout(15000) });
  const ids = (await r.json())?.data?.map((m) => m.id) ?? [];
  exoAvailable = ids.includes('exo-free');
  if (exoAvailable) {
    ok(`exo-free 在售（Zen 当前共 ${ids.length} 个模型）`);
  } else {
    bad('exo-free 已经不在 Zen 的模型列表里了');
    hint('免费期结束了，或者上游改了名字。');
    hint('这个项目就是为 exo-free 写的，它没了就没意义了。');
    hint('你可以改 config.json 里的 intercept.models 换成别的免费模型，但后端判定规则要自己摸。');
    const go = await askYesNo('  仍然继续吗？', false);
    if (!go) { rl?.close(); process.exit(1); }
  }
} catch (e) {
  warn(`查不到模型列表：${e.message}`);
}

// ── 5. 端口
step('检查端口');
function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

let portOk = await portFree(PORT);
if (portOk) {
  ok(`端口 ${PORT} 空闲`);
} else {
  // 占用者是本代理自己吗？
  let mine = false;
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/__relay/health`, { signal: AbortSignal.timeout(3000) });
    mine = h.ok && (await h.json())?.ok === true;
  } catch {}
  if (mine) {
    warn(`端口 ${PORT} 上已经跑着一个本代理`);
    hint('如果那是你手动开的窗口，建议先关掉它再继续。');
    const go = await askYesNo('  继续吗？（稍后我会跳过重复启动）', true);
    if (!go) { rl?.close(); process.exit(1); }
  } else {
    bad(`端口 ${PORT} 被别的程序占用了`);
    hint(`换个端口重跑：node setup.mjs --port ${PORT + 1}`);
    rl?.close();
    process.exit(1);
  }
}

// ════════════════════════════════════════════════ 阶段二：配置

// ── 6. 凭据
step('OpenCode Zen 凭据');
say(C.d('  这一步不能省，也没有默认值。'));
say(C.d('  实测：OpenCode 在没有凭据时根本不会把 exo-free 列为可选模型，'));
say(C.d('  而是直接报 "Model unavailable" —— 请求发都发不出去。'));
say('');
say(C.d('  两种填法，二选一：'));
say(C.d('    A. 现在就粘贴你的 key（推荐）—— 代理会用它，与 OpenCode 的登录状态无关'));
say(C.d('    B. 留空 —— 前提是你已经用 `opencode auth login` 配好了 Zen 凭据'));
say('');
say(C.d('  每人必须用自己的 key，不要共用。获取：https://opencode.ai/auth'));
say('');

let key = (KEY_ARG ?? '').trim();
if (!key && rl) key = (await ask('  粘贴你的 key（或直接回车留空）')).trim();

if (key && !key.startsWith('oc_sk_')) {
  warn('这个 key 不像 Zen 的格式（一般以 oc_sk_ 开头），继续但可能会失败');
}
if (key) ok(`已记录 ${key.slice(0, 12)}…${key.slice(-4)}`);
else hint('留空：将沿用 OpenCode 自己的凭据（请确认已用 auth login 配好）');

// 联网验证
if (key) {
  process.stdout.write(C.d('  正在联网验证… '));
  let verdict;
  try {
    const r = await fetch('https://opencode.ai/zen/v1/chat/completions', {
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
    });
    const body = await r.text();
    if (r.status === 403 && /FreeTierError/.test(body)) verdict = 'ok';
    else if (r.status === 401) verdict = 'invalid';
    else if (r.status === 200) verdict = 'perfect';
    else verdict = `other:${r.status}`;
  } catch (e) {
    verdict = `neterr:${e.message}`;
  }

  say('');
  if (verdict === 'ok') {
    ok('key 有效');
    hint('403 FreeTierError 是正常的 —— 免费层要求「必须在 OpenCode 内使用」，走本代理就能过。');
  } else if (verdict === 'perfect') {
    ok('key 有效，且直接就能用');
  } else if (verdict === 'invalid') {
    bad('key 无效（Zen 返回 401 Invalid API key）');
    hint('检查是否复制完整，或去 https://opencode.ai/auth 重新生成。');
    const go = await askYesNo('  仍然写入这个 key 吗？', false);
    if (!go) { rl?.close(); process.exit(1); }
  } else if (verdict.startsWith('neterr')) {
    warn(`没法验证：${verdict.slice(7)}`);
  } else {
    warn(`未预期响应 HTTP ${verdict.slice(6)}，先继续`);
  }
}

// ── 7. 写配置
step('生成配置');
const stripComments = (o) => {
  if (Array.isArray(o)) return o.map(stripComments);
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== '$comment').map(([k, v]) => [k, stripComments(v)]));
  }
  return o;
};

let relayCfg;
if (fs.existsSync(RELAY_CONFIG)) {
  const overwrite = await askYesNo('  config.json 已存在，用模板覆盖它吗？（会丢失你之前的改动）', false);
  if (overwrite) {
    relayCfg = stripComments(JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8')));
  } else {
    relayCfg = JSON.parse(fs.readFileSync(RELAY_CONFIG, 'utf8'));
    hint('保留原文件，只更新端口与凭据');
  }
} else {
  relayCfg = stripComments(JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8')));
}

relayCfg.listen = { host: '127.0.0.1', port: PORT };
if (key) relayCfg.auth = { ...(relayCfg.auth ?? {}), override: key, applyTo: 'intercepted' };
fs.writeFileSync(RELAY_CONFIG, JSON.stringify(relayCfg, null, 2) + '\n');
ok(`已写入 config.json`);
hint(`监听 127.0.0.1:${PORT}，拦截 ${relayCfg.intercept.models.join(', ')}`);
if (!key) {
  hint('');
  hint('没填 key。想改用环境变量或文件也行：');
  hint('  优先级：config.json 的 auth.override → RELAY_ZEN_KEY → zen-key.txt');
}

// OpenCode 侧
if (SKIP_OPENCODE) {
  warn('--no-opencode 已指定，不修改 OpenCode 配置。');
  say('');
  say(`  请手动把下面内容合并进 ${C.B(OPENCODE_CONFIG)}：`);
  say(C.d(JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { opencode: { options: { baseURL: BASE_URL } } } }, null, 2)));
} else {
  let existing = null;
  let broken = false;
  if (fs.existsSync(OPENCODE_CONFIG)) {
    try {
      existing = JSON.parse(fs.readFileSync(OPENCODE_CONFIG, 'utf8'));
    } catch (e) {
      broken = true;
      bad(`现有配置不是合法 JSON，不敢动它：${e.message}`);
      hint(`请手动把 provider.opencode.options.baseURL 改成 ${BASE_URL}`);
    }
  }

  if (!broken) {
    let writable = true;

    try {
      if (existing) {
        const bak = `${OPENCODE_CONFIG}.bak-${Date.now()}`;
        fs.copyFileSync(OPENCODE_CONFIG, bak);
        ok(`已备份原配置 → ${path.basename(bak)}`);
      } else {
        fs.mkdirSync(path.dirname(OPENCODE_CONFIG), { recursive: true });
      }
    } catch (e) {
      bad(`备份失败，为安全起见不覆盖原配置：${e.message}`);
      hint('多半是没有写入权限（只读目录、杀软拦截、或沙箱限制）。');
      writable = false;
    }

    if (writable) {
      try {
        const merged = existing ?? { $schema: 'https://opencode.ai/config.json' };
        merged.provider = merged.provider ?? {};
        merged.provider.opencode = merged.provider.opencode ?? {};
        merged.provider.opencode.options = { ...(merged.provider.opencode.options ?? {}), baseURL: BASE_URL };
        fs.writeFileSync(OPENCODE_CONFIG, JSON.stringify(merged, null, 2) + '\n');
        ok('已让 OpenCode 走本代理');
        hint(`provider.opencode.options.baseURL = ${BASE_URL}`);
        hint('原有的其它配置都保留着，只动了 baseURL 这一个键。');
      } catch (e) {
        bad(`写入失败：${e.message}`);
        writable = false;
      }
    }

    if (!writable) {
      say('');
      say(`  ${C.y('需要你手动改一下')} ${OPENCODE_CONFIG}`);
      say(C.d('  把 provider.opencode.options.baseURL 设成下面这个值（其它键别动）：'));
      say(C.d(JSON.stringify({ provider: { opencode: { options: { baseURL: BASE_URL } } } }, null, 2)));
    }
  }
}

// ════════════════════════════════════════════════ 阶段三：启动 + 端到端验证

// ── 8. 启动并验证
step('启动并验证');

const proxyAlreadyRunning = await (async () => {
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/__relay/health`, { signal: AbortSignal.timeout(3000) });
    return h.ok && (await h.json())?.ok === true;
  } catch {
    return false;
  }
})();

async function health() {
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/__relay/health`, { signal: AbortSignal.timeout(3000) });
    return h.ok ? await h.json() : null;
  } catch {
    return null;
  }
}

let before = null;
if (proxyAlreadyRunning) {
  ok(`代理已在 ${PORT} 端口运行，跳过启动`);
  before = await health();
} else {
  let launch = START_NOW;
  if (!START_NOW && rl) launch = await askYesNo('  现在启动代理？', true);

  if (launch) {
    try {
      if (os.platform() === 'win32') {
        spawn('cmd', ['/c', 'start', 'zen-claude-relay', 'cmd', '/k', 'node', path.join(__dirname, 'proxy.mjs'), '--port', String(PORT)], {
          detached: true, stdio: 'ignore', cwd: __dirname,
        }).unref();
      } else {
        spawn(process.execPath, [path.join(__dirname, 'proxy.mjs'), '--port', String(PORT)], { detached: true, stdio: 'ignore', cwd: __dirname }).unref();
      }
      for (let i = 0; i < 15; i++) {
        await sleep(700);
        before = await health();
        if (before) break;
      }
      if (before) ok(`代理已启动，监听 127.0.0.1:${PORT}`);
      else warn('没能确认代理已启动，请手动运行 node proxy.mjs');
    } catch (e) {
      warn(`自动启动失败：${e.message}`);
      hint('请手动运行：node proxy.mjs');
    }
  } else {
    hint('跳过启动。之后手动运行 node proxy.mjs 即可。');
  }
}

// 端到端验证：等用户真发一条消息
if (before && !SKIP_VERIFY && opencodeDetected) {
  say('');
  hr();
  say(`  ${C.B('最后一步：让它真的跑一次。')}`);
  say('');
  say('  请现在：');
  say(`    1. ${C.B('重启 OpenCode')}（桌面端 / TUI 都要重启才会重读配置）`);
  say(`    2. 选模型 ${C.B('exo-free')}，随便发一句话（比如「你好」）`);
  say('');
  say(C.d('  我在这儿等着，检测到请求会自动继续（最多等 3 分钟）…'));
  say('');
  hr();

  const baseline = before.stats.intercepted;
  let seen = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(2500);
    const h = await health();
    if (!h) continue;
    if (h.stats.intercepted > baseline) { seen = h; break; }
    const el = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${C.d(`等待中… ${el}s`)}   `);
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  say('');
  if (seen) {
    const got = seen.stats.intercepted - baseline;
    const claude = seen.stats.claude;
    const gpt = seen.stats.gpt;
    ok(`检测到 ${got} 次 exo-free 请求经过代理`);
    if (claude > 0) {
      ok(`其中 ${claude} 次判定为 Claude 并成功放行`);
    }
    if (gpt > 0) {
      ok(`另有 ${gpt} 次判定为 GPT，已被丢弃重掷 —— 重试逻辑正在工作`);
    }
    say('');
    say(`  ${C.g('★ 成了。')} 你现在用的就是 Claude 后端了。`);
  } else {
    warn('3 分钟内没检测到任何请求');
    hint('可能的原因：');
    hint('  · OpenCode 没重启，还在用旧配置');
    hint('  · 没选 exo-free 模型');
    hint('  · 或者你压根没发消息 :)');
    hint('');
    hint('稍后可以随时跑 node doctor.mjs 来确认。');
  }
} else if (SKIP_VERIFY) {
  hint('（已用 --skip-verify 跳过端到端验证）');
}

// ════════════════════════════════════════════════ 阶段四：收尾

say('');
hr();
say(C.B('  装好了'));
hr();
say('');
say('  常用命令：');
say(`    ${C.B('node relay.mjs')}      ${C.d('交互式管理菜单（启动/停止/体检/自启）')}`);
say(`    ${C.B('node doctor.mjs')}     ${C.d('出问题时的一键体检')}`);
say(`    ${C.B('node proxy.mjs')}      ${C.d('直接前台启动代理')}`);
say('');
say(C.d('  注意：代理是个前台进程，关掉窗口它就停了。'));
say('');

if (rl && os.platform() === 'win32' && fs.existsSync(path.join(__dirname, 'install-autostart.ps1'))) {
  const wantAuto = await askYesNo('  要不要顺手注册开机自启？以后就不用管那个窗口了', true);
  if (wantAuto) {
    say(C.d('  正在注册计划任务…'));
    const r = await new Promise((resolve) => {
      try {
        const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'install-autostart.ps1')], { stdio: 'inherit' });
        p.on('close', (code) => resolve(code));
        p.on('error', (e) => resolve(`err:${e.message}`));
      } catch (e) {
        resolve(`err:${e.message}`);
      }
    });
    if (r === 0) ok('开机自启已注册');
    else warn(`自启注册没成功（${r}），可以稍后手动跑 install-autostart.ps1`);
  } else {
    hint('跳过。想装的时候跑 install-autostart.ps1 即可。');
  }
} else if (os.platform() !== 'win32') {
  hint('开机自启：macOS/Linux 见 README 的「开机自启」一节。');
}

say('');
say(C.d('  风险提示：本工具依赖对上游行为的逆向观察，上游随时可能改。'));
say(C.d('  把它当应急备用。另外 exo-free 免费期内数据可能被用于训练，别喂敏感代码。'));
say('');

rl?.close();
