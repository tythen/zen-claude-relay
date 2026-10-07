# zen-claude-relay

让 OpenCode 的 `exo-free` 免费模型**只落在 Claude 后端**的本地中转代理。

[OpenCode Zen](https://opencode.ai/docs/zen) 上的 `exo-free` 是免费的，但它背后是两台机器：
一台 Claude、一台 GPT，网关每次随机把你分到其中一台。
这个代理坐在中间，是 GPT 就掐断重来，直到拿到 Claude 为止。

```
OpenCode ──POST/SSE──► 本代理 (127.0.0.1:8788) ──► opencode.ai/zen/v1
                            │
                    偷看第一帧带 id 的数据块
                            │
          id 以 msg_ 开头 ──► 是 Claude，字节原样透传给你 ✅
          id 以 resp_ 开头 ─► 是 GPT，掐断上游 + 换新会话键重发 🔁
          认不出 ───────────► 默认放行（fail-open，不搞坏本来能用的请求）
```

**零依赖**，只用 Node 内置模块。不需要 `npm install`。

---

## 快速开始

### 前提

| 需要什么 | 说明 |
| --- | --- |
| **Node.js 18+** | <https://nodejs.org> —— 用到了内置的 `fetch` |
| **OpenCode** | <https://opencode.ai> —— 桌面端或 CLI 都行 |
| **OpenCode Zen API key** | <https://opencode.ai/auth> 登录后复制，形如 `oc_sk_...` |
| `exo-free` 可用 | 免费期内有效，随时可能下线 |

> ⚠️ 免费层要求「必须在 OpenCode 内使用」，所以**必须搭配真实的 OpenCode** 用，
> 不能拿 curl 直接调这个代理。

### 三步

```bash
# 1. 克隆
git clone https://github.com/<你的用户名>/zen-claude-relay.git
cd zen-claude-relay

# 2. 跑向导（会引导你填 key，并自动改好 OpenCode 的配置）
node setup.mjs

# 3. 重启 OpenCode，选 exo-free 模型，随便发一句话
```

装好了。向导会自动：

- 检查 Node 版本和 OpenCode 是否就位
- 引导你填 Zen API key
- 生成 `config.json`
- **联网验证**这个 key 是不是真的有效
- 修改 `~/.config/opencode/opencode.json`，把 `opencode` 提供方指向本代理
  （会先备份原文件，只动 `baseURL` 这一个键）
- 问你要不要立刻启动

如果不想让它动 OpenCode 的配置：

```bash
node setup.mjs --no-opencode    # 只打印该写什么，你自己改
```

---

## 日常使用

### 启动

```bash
node proxy.mjs          # 或者双击 start-relay.cmd（Windows）
```

macOS / Linux 也可以用 `./start-relay.sh`。

启动后会有个窗口一直开着。**关了它代理就停了。**

### 开机自启（推荐）

装完之后就再也不用管了。

**Windows**（普通权限即可）：

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
```

会注册一个计划任务，每次登录自动拉起代理（隐藏窗口、崩了自动重启）。
卸载：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1
```

**macOS**：用 `launchd`。建 `~/Library/LaunchAgents/ai.relay.zen.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.relay.zen</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/绝对路径/zen-claude-relay/proxy.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/绝对路径/zen-claude-relay</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

然后 `launchctl load ~/Library/LaunchAgents/ai.relay.zen.plist`。

**Linux**：systemd user service 或 crontab `@reboot`，同理。

### 体检

任何时候出问题，先跑这个：

```bash
node doctor.mjs
```

它会逐环检查**代理进程 → 运行统计 → OpenCode 配置 → exo-free 是否还在 → 凭据/门禁/路由 → 日志异常**，
然后直接告诉你是哪一环坏了、怎么修。

---

## 配置

把 `config.example.json` 复制成 `config.json` 再改（`config.json` 已在 `.gitignore` 里，不会进版本库）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `listen.port` | `8788` | 监听端口 |
| `upstream` | `https://opencode.ai` | 上游地址 |
| `intercept.models` | `["exo-free"]` | 要拦截的模型名，可以加多个 |
| `intercept.pathSuffix` | `/chat/completions` | 只有这个路径结尾的才拦 |
| `retry.maxAttempts` | `6` | 最多重掷几次 |
| `retry.peekTimeoutMs` | `30000` | 偷看多久还没见到 id 就放行 |
| `retry.regenerateHeaders` | `x-session-affinity` 等 | 重掷时替换哪些请求头 |
| `auth.override` | 空 | 代理自己带的 key。**留空则沿用 OpenCode 自己的凭据** |
| `auth.applyTo` | `intercepted` | 只在被拦截的请求上覆盖鉴权 |
| `classify.gptPrefixes` | `["resp_","chatcmpl-"]` | 认定 GPT 的前缀 |
| `classify.unknownPolicy` | `forward` | 认不出时 `forward`（放行）或 `retry`（也重掷） |

### 关于 `auth.override`

大部分情况下**留空就行**，代理会用 OpenCode 自己的凭据。

什么时候需要填？如果你的 OpenCode 里同时登录过 **OpenCode Console** 账号，
那条 OAuth 凭据会抢占 `opencode` 提供方的凭据位，而它的 token 对 Zen 的 API 无效，
表现就是一直报 `Invalid API key`。这时候让代理自己带 key 就能绕开。

也可以用环境变量或文件，省得把 key 写进配置：

```bash
export RELAY_ZEN_KEY=oc_sk_...          # 环境变量
echo "oc_sk_..." > zen-key.txt          # 或者放个文件
```

优先级：`config.json` 的 `auth.override` → `RELAY_ZEN_KEY` → `zen-key.txt`。

---

## 诊断接口

代理跑起来后自带两个端点：

```bash
# 运行状态与计数
curl http://127.0.0.1:8788/__relay/health

# 路由探测：复用最近一次真实 OpenCode 请求，测 4 次看落在哪个后端
curl "http://127.0.0.1:8788/__relay/probe?n=4&mode=fresh"
```

`probe` 的 `mode`：

| 值 | 含义 |
| --- | --- |
| `same` | 完全不动请求头（基线） |
| `fresh` | 每次换一个新亲和键（默认，用来测「重掷是否有效」） |
| `fixed` | 所有探测共用一个新亲和键（用来测粘性） |
| `none` | 删掉全部会话头 |

> `probe` 需要先让 OpenCode 发过一次消息，代理捕获到请求模板后才能用。
> 它是检查「重掷路径是否还健康」的唯一办法 —— 平时不撞 GPT 是看不出来的。

### 日志

每次判定都记在 `relay.log` 里，带会话短标签方便按对话归组：

```
[exo a1b2c3d4] attempt 1: ✗ GPT (id=resp_0ff6...) — 断开上游，重新请求
[exo a1b2c3d4] attempt 2: ✓ 放行 (claude, id=msg_vrtx_011CfnVSA7C44...) — 用时 4569ms
```

---

## 自测

不需要 key，会起一个「假 Zen 网关」来验证核心逻辑：

```bash
node test-relay.mjs
```

覆盖 25 项断言：GPT 丢弃与重掷、亲和键确实变了且形状正确、
全是 GPT 时报错而不是把 GPT 内容给你、非 exo-free 请求逐字节原样转发、非流式也能识别。

---

## 常见问题

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `ConnectionRefused` | 代理没在跑 | `node proxy.mjs`，或装了自启就重启一下 |
| `Invalid API key` | key 失效，或被 Console 登录凭据抢占 | 见上面 `auth.override`；或重新 `opencode auth login` |
| 平时正常，一撞 GPT 就报 403 | 会话 id 形状变了，重掷被门禁挡 | 跑 `node doctor.mjs`，按 [docs/FINDINGS.md](docs/FINDINGS.md) 重新摸 |
| 余额不足 | 用了付费模型 | 只能用 `exo-free` |
| 模型列表里没有 exo-free | 免费期结束了 | 换别的免费模型，改 `intercept.models` |
| 启动报端口被占 | 8788 被别的程序占了 | `node proxy.mjs --port 8789`，同时改 OpenCode 配置 |

---

## 已知限制与风险

**请务必读这一节。**

- **这是逆向出来的，不是稳定接口。** Zen 那边随时可以改判据，改了就失效。
  把它当**应急备用**，别当主力依赖。
- **免费层的隐私条款**：Zen 文档明确写了 `exo-free` 在免费期内
  「收集的数据可能用于改进模型」。**别拿它喂敏感代码。**
- **免费期随时结束。** `exo-free` 是限时免费模型。
- **重掷有成本**：每次重掷都是一次完整的上游请求（被丢弃的那个只读到第一帧就断开）。
  别把 `maxAttempts` 调得太大。
- **只监听 `127.0.0.1`**，不要改成 `0.0.0.0` —— 它转发明文 API key。
- **代理必须搭配真实 OpenCode。** 免费层门禁会检查请求头**和请求体**，
  合成的请求即使头全对也会被 403 挡掉。
- **模型名与 id 前缀是硬编码的。** 上游若改了后端或 id 规则，
  需要相应调整 `classify` 配置或代码。

---

## 目录结构

```
.
├── proxy.mjs                  代理本体（核心，零依赖）
├── setup.mjs                  冷启动向导
├── doctor.mjs                 一键体检
├── config.example.json        配置模板
├── start-relay.cmd / .sh      一键启动
├── install-autostart.ps1      开机自启安装（Windows）
├── uninstall-autostart.ps1    开机自启卸载
├── autostart-run.ps1          计划任务调用的包装脚本
├── test-relay.mjs             端到端自测（不需要 key）
├── docs/
│   └── FINDINGS.md            逆向发现记录 + 失效后怎么重新摸
└── tools/                     研究与诊断脚本
    ├── probe.mjs              直连路由探测
    ├── auth-test.mjs          判断某个 token 在 Zen 眼里是否有效
    ├── debug-zen.mjs          打印 Zen 的原始响应
    ├── scan-binary.mjs        扫描 OpenCode 二进制里的字符串
    ├── inspect-opencode-db.mjs  查看本地存了哪些凭据
    ├── gate-test.mjs          门禁判据实验
    ├── replay.mjs             门禁二分实验
    └── test-override.mjs      验证鉴权覆盖
```

---

## 它是怎么被搞明白的

见 [docs/FINDINGS.md](docs/FINDINGS.md)。里面有：

- OpenCode 2.0.24 实际发出的完整请求头
- 免费层门禁的真实判据（**会话 id 的形状**，不是某个请求头）
- 为什么裸脚本会被 403 而真 OpenCode 不会
- 凭据存储位置与优先级，以及 Console 登录是怎么把 key 挤掉的
- 上游改了之后，怎么一步步重新摸出来

---

## License

[MIT](LICENSE)

本项目仅供个人学习与自用。使用时请遵守 OpenCode / OpenCode Zen 的服务条款。
