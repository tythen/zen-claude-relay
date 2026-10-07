# 逆向发现记录

这些结论全部是**实测**得出的（针对 OpenCode 2.0.24），不是从文档抄的。
网上的说法和实际有出入，特别是 `x-opencode-request` 那条。

上游随时可能改。如果哪天失效了，看本文末尾的「失效了怎么重新摸」。

---

## 1. OpenCode 到底发了什么请求头

真实抓包（走代理后从 `relay.log` 里 dump 出来的）：

```
authorization: Bearer <你的 key>
content-type: application/json
user-agent: opencode/latest/2.0.24/cli
b3: <128位trace>-<64位span>-1-<64位>
traceparent: 00-<128位trace>-<64位span>-01
x-opencode-client: cli
x-opencode-project: 0123456789abcdef0123456789abcdef01234567
x-opencode-session: ses_a1b2c3d4e5f6G7h8I9j0K1l2M3
x-opencode-session-id: ses_a1b2c3d4e5f6G7h8I9j0K1l2M3
x-session-affinity: ses_a1b2c3d4e5f6G7h8I9j0K1l2M3
x-session-id: ses_a1b2c3d4e5f6G7h8I9j0K1l2M3
accept: */*
accept-encoding: gzip, deflate, br, zstd
```

### 关键点

- **`x-opencode-request` 这个头根本不存在。** 二进制字符串扫描和真机抓包双重确认。
  网上流传的「换一个新的 `x-opencode-request` 就能重新掷骰子」是错的。

- **真正的路由/亲和键是 `x-session-affinity`**（以及同值的 `x-opencode-session` 等）。
  二进制的模型请求层里写得很清楚：

  ```js
  headers: ({ request: r }) => r.promptCacheKey ? { 'x-session-affinity': r.promptCacheKey } : {}
  ```

- 四个会话头的值是**同一个**东西：当前会话的 id。
- `x-opencode-project` 是项目目录的 40 位 sha1，同一目录下恒定。
- `b3` / `traceparent` 是 OpenTelemetry 链路追踪，每次请求都不同。

---

## 2. 免费层门禁：判据是会话 id 的「形状」

裸请求（非 OpenCode 发出）打 `chat/completions` 会得到：

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode"}}
```

### 试过但**没用**的办法

我们把 OpenCode 的请求头**逐字节复刻**（包括 `user-agent`、`x-opencode-client`、
`x-opencode-project`、`b3`、`traceparent`、四个会话头），依然 403。
所以门禁**不是**靠某个特定的头名。

### 真正起作用的

**会话 id 的格式**：

```
ses_ + 12 位小写十六进制 + 14 位 base62  =  共 26 字符
例： ses_a1b2c3d4e5f6G7h8I9j0K1l2M3
      └────12hex───┘└────14base62────┘
```

- 生成 22 位随机串 → **403**
- 生成正确形状的 26 位 → **放行**（实测 20/20 成功）

这一条极其重要：**如果重掷时随便造 id，重掷会被 403 挡回来**，
本来该丢弃 GPT 重试的动作，反而变成给用户报错 —— 比不修还糟。

> 推断：前 12 位可能编码了时间戳（同一批会话都以 `eeab…`/`eeac…` 开头），
> 所以网关可能是「校验 id 是否像 OpenCode 近期生成的」。
> 未证实，但形状对就能过是实测过的。

### 门禁还看请求体

即便会话 id 形状正确，**合成的小请求体依然 403**。
只有真实 OpenCode 发出的、带完整 system prompt 和工具定义的请求（约 21 KB）才过。

所以：**这个代理必须搭配真实的 OpenCode 使用**，不能拿 curl 直接玩。

---

## 3. 鉴权发生在门禁**之前**

这一点很容易被误导。

| 请求 | 结果 |
| --- | --- |
| 假 key | `401 Invalid API key` |
| 真 key、裸请求 | `403 FreeTierError` |
| 真 key、真 OpenCode 形状 | `200` + Claude |

所以看到 401 **不代表**门禁通过了 —— 它只是还没走到门禁那一步。

**推论**：想判断一个凭据是否有效，看裸请求的 401 vs 403 就够了，不需要构造完整请求。

---

## 4. 响应 id 前缀可以判后端

| 前缀 | 后端 | 说明 |
| --- | --- | --- |
| `msg_vrtx_...` | Anthropic / Claude | Vertex AI 风格的消息 id |
| `resp_...` | OpenAI Responses API | GPT |
| `chatcmpl-...` | OpenAI Chat Completions | 兼容层，也算 GPT |

实测抓到的真样本：

```
GPT   : resp_0ff685c6f89f6aa8016ac5f6234ee887d1bc72f6ea7962e509
Claude: msg_vrtx_011CfnVSA7C44gQuDiF8dWHc
```

这些 id 是上游原样透传的，所以可以直接用来判后端。

---

## 5. 凭据存储与优先级（踩过的坑）

OpenCode 2.x 把凭据存在 `~/.local/share/opencode/opencode.db` 的 `credential` 表
（注意：**不是** `auth.json`）。

```json
{"integration_id": "opencode",     "value": {"type":"oauth","access":"st_…",
   "metadata":{"server":"https://opencode.ai/console"}}}
{"integration_id": "opencode-go",  "value": {"type":"key","key":"oc_sk_…"}}
```

### 坑 1：Console 登录会抢占 `opencode` 这个 id

在桌面端登录 **OpenCode Console** 后，会写入一条 `integration_id` 为 `opencode`
的 OAuth 凭据 —— 而 `opencode` 正是 Zen 提供方的 id。

它的 access token 是 `st_...`，`metadata.server` 指向 `https://opencode.ai/console`，
**只对 Console API 有效**。发给 `opencode.ai/zen/v1` 一律：

```
401 AuthError: Invalid API key.
```

### 坑 2：存储的凭据**压过** `opencode.json` 里的 `apiKey`

一旦上面那条 OAuth 凭据存在，`provider.opencode.options.apiKey` 就不再生效。
表现就是「配置里明明写了 key，却一直报 Invalid API key」。

### 解法

让代理**自己带凭据**（`auth.override`），彻底绕开 OpenCode 的凭据解析。
实测：让真 OpenCode 带着垃圾凭据跑，依然能拿到 Claude。

---

## 6. 有用的环境变量（排查时很有用）

从二进制里挖出来的，官方文档没写全：

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_CONFIG` | 指定配置文件路径 |
| `OPENCODE_CONFIG_CONTENT` | **内联 JSON 配置**，优先级高于全局配置 |
| `OPENCODE_CONFIG_DIR` | 额外配置目录 |
| `XDG_DATA_HOME` | 数据目录（默认 `~/.local/share`）—— 想在不污染真实环境的前提下跑测试就靠它 |
| `XDG_CONFIG_HOME` | 配置目录（默认 `~/.config`） |
| `OPENCODE_MODELS_URL` / `OPENCODE_MODELS_PATH` | 自定义模型目录 |
| `OPENCODE_DISABLE_MODELS_FETCH` | 禁止联网拉模型列表 |
| `OPENCODE_PASSWORD` | 内置服务器的密码（`opencode serve` 需要） |

**沙箱/CI 里跑 OpenCode 的技巧**：把 `XDG_DATA_HOME` 指到一个可写目录，
否则它会因为写不了日志而崩在启动阶段（`EPERM ... opencode.log`）。

---

## 7. 其它零碎但有用的

- Zen 的模型列表 `https://opencode.ai/zen/v1/models` **不需要鉴权**，
  可以直接拿来监控 exo-free 是否还在售。
- 内置 `opencode` 提供方的定义（从本地模型目录缓存里读出来的）：

  ```json
  { "id": "opencode", "env": ["OPENCODE_API_KEY"],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://opencode.ai/zen/v1",
    "name": "OpenCode Zen" }
  ```

  因为是 `@ai-sdk/openai-compatible`，所以它请求的是 `{baseURL}/chat/completions`
  —— 这就是为什么把 baseURL 设成 `http://127.0.0.1:8788/zen/v1` 能生效。

- 桌面端和 CLI **共用同一份** `~/.config/opencode/opencode.json`。

---

## 失效了怎么重新摸

上游改了的话，按这个顺序重来一遍：

### 1. 确认是哪一环坏了

```powershell
node doctor.mjs
```

### 2. 如果报 403 FreeTierError（会话 id 形状变了）

先看 OpenCode 现在发的 id 长什么样：

```powershell
# 把 verbose 打开
node proxy.mjs --verbose
# 然后在 OpenCode 里发一条消息，看日志里的「收到请求头」
# 找 x-session-affinity 的值
```

然后改 `proxy.mjs` 里的 `freshSessionId()` 去匹配新形状。

### 3. 如果想知道 OpenCode 还发了什么头

用 `tools/scan-binary.mjs` 直接扫二进制里的字符串：

```powershell
node tools/scan-binary.mjs "C:\path\to\opencode.exe" "x-opencode" "session-affinity"
```

### 4. 如果是凭据问题

```powershell
# 看本地到底存了哪几条凭据
node tools/inspect-opencode-db.mjs "$env:USERPROFILE\.local\share\opencode\opencode.db"

# 判断某个 token 在 Zen 眼里是否有效
$env:CRED_KEYSK="oc_sk_..."; node tools/auth-test.mjs
```

### 5. 看 Zen 的原始响应

```powershell
$env:OPENCODE_API_KEY="oc_sk_..."; node tools/debug-zen.mjs
```
