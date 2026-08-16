# cline2api

Cloudflare Workers 反向代理：把 Cline 返回的 `delta.reasoning` 重写为 `delta.reasoning_content`，使上游（sub2api）能正确识别出 thinking 内容，转成 Anthropic thinking block。同时提供 `GET /v1/models` 模型列表端点，只返回 Cline 推荐模型中的**免费**模型。

## 工作原理

- **聊天**：原样转发请求到 OpenAI 兼容的 chat/completions 接口（默认 `https://api.cline.bot/api/v1/chat/completions`），`model` / `messages` 均不改动。
  - **流式**（SSE）：逐帧解析，把每个 chunk 的 `choices[].delta.reasoning` 复制到 `choices[].delta.reasoning_content`。
  - **非流式**：把 `choices[].message.reasoning` 复制到 `choices[].message.reasoning_content`。
- **模型列表**：`GET /v1/models`（`GET /models` 为别名）代理 Cline 的 `recommended-models` 端点，**只保留 `free` 数组**里的免费模型，转成 OpenAI 兼容格式（`{object, data:[{id, object, created, owned_by, name, description}]}`）。免费模型 ID 形如 `deepseek/deepseek-v4-flash`，可直接作为 chat/completions 的 `model` 使用。
- 鉴权：优先使用环境变量 `CLINE_API_KEY`，未设置则透传请求自带的 `Authorization`（模型列表端点无需鉴权）。

## 本地开发

```bash
npm install
wrangler dev        # 或 npm run dev
```

本地调试需要 API Key 时，在项目根目录创建 `.dev.vars`：

```env
CLINE_API_KEY=sk-xxx
UPSTREAM_URL=https://api.cline.bot/api/v1/chat/completions
```

## 部署

部署凭据已写入 `.env`（已 gitignore），`npm run deploy` 会通过 `wrangler.sh` 自动加载：

```bash
npm run deploy
```

先验证凭据是否有效：

```bash
npm run whoami
```

设置 Worker 运行时敏感变量（不会明文出现在配置里）：

```bash
bash ./wrangler.sh secret put CLINE_API_KEY
```

> ⚠️ `CLOUDFLARE_API_TOKEN` 不要放进 `.dev.vars` / `wrangler.toml`，否则会混淆 wrangler 的鉴权；它只应存在于 `.env` 或 shell 环境。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_URL` | `https://api.cline.bot/api/v1/chat/completions` | 上游 OpenAI 兼容地址 |
| `MODELS_UPSTREAM` | `https://api.cline.bot/api/v1/ai/cline/recommended-models` | 免费模型列表上游地址（成功结果按 5 分钟内存 TTL 缓存） |
| `CLINE_API_KEY` | 空 | Cline API Key；未设置时透传请求自带的 `Authorization` |

## 调用

把客户端（如 CC Switch / sub2api）的 base URL 指向本 Worker 的地址，直接发标准的 chat/completions 请求即可。Worker 只接受 `POST`（聊天）与 `GET /v1/models`（模型列表）。