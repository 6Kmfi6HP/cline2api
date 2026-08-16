// 把 Cline 返回的 delta.reasoning 重写为 delta.reasoning_content，
// 使 sub2api（只识别 reasoning_content）能把思考转成 Anthropic thinking block。

const DEFAULT_UPSTREAM = "https://api.cline.bot/api/v1/chat/completions";
const MODELS_UPSTREAM = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 免费模型列表成功缓存时长
const MODELS_ERROR_CACHE_MS = 30_000;      // 上游失败后的负缓存时长（吸收突发请求）
const MODELS_FETCH_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 免费模型列表内存缓存：{ upstream, timestamp, list | error }，成功与失败都缓存；
// modelsInflight 按 upstream 记录 in-flight promise，同一 upstream 并发只发一次上游请求（同 isolate 内）
let modelsCache = null;
const modelsInflight = new Map();

export default {
  async fetch(request, env) {
    // 模型列表：GET /v1/models（兼容 OpenAI 客户端），只返回免费模型
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && ["/v1/models", "/v1/models/", "/models", "/models/"].includes(pathname)) {
      return handleModelsRequest(env);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const upstream = env.UPSTREAM_URL || DEFAULT_UPSTREAM;

    // 读取请求体（顺带判断是否流式）
    const rawBody = await request.text();
    let stream = true;
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed.stream === false) stream = false;
    } catch (_) {}

    // 鉴权：优先用环境变量里的 Cline key；否则透传请求自带的 Authorization
    let auth = env.CLINE_API_KEY || request.headers.get("authorization") || "";
    if (auth && !/^Bearer /i.test(auth)) auth = "Bearer " + auth;

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    if (auth) headers.set("Authorization", auth);
    // Cline 需要的客户端标识（CC Switch 里的 Header 覆盖）
    headers.set("x-client-type", "cline-cli");

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstream, {
        method: "POST",
        headers,
        body: rawBody,   // 原样转发（model / messages 均原样）
      });
    } catch (e) {
      return new Response(JSON.stringify({
        error: { message: "upstream request failed: " + e.message, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    // 非流式：改写 message.reasoning -> message.reasoning_content
    if (!stream) {
      const upstreamBody = await upstreamResp.text();
      try {
        const json = JSON.parse(upstreamBody);
        rewriteNonStream(json);
        return new Response(JSON.stringify(json), {
          status: upstreamResp.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (_) {
        // 上游返回非 JSON（如错误页），原样透传
        return new Response(upstreamBody, { status: upstreamResp.status });
      }
    }

    // 流式：逐帧改写 SSE
    if (!upstreamResp.body) return upstreamResp;
    const transformed = upstreamResp.body.pipeThrough(createSSETransformer());
    return new Response(transformed, {
      status: upstreamResp.status,
      headers: { "Content-Type": "text/event-stream" },
    });
  },
};

// 以 "\n\n" 为帧边界处理 SSE，避免分块把单条事件拆散
function createSSETransformer() {
  let buf = "";
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const out = processFrame(frame);
        if (out) controller.enqueue(encoder.encode(out));
      }
    },
    flush(controller) {
      if (buf.trim()) {
        const out = processFrame(buf);
        if (out) controller.enqueue(encoder.encode(out));
      }
    },
  });
}

// 处理一帧 SSE：把 data 行中的 delta.reasoning 复制到 delta.reasoning_content
function processFrame(frame) {
  const rawLines = frame.split("\n");
  const dataLines = [];
  const otherLines = [];

  for (const line of rawLines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else otherLines.push(line);
  }

  const parts = otherLines.filter(Boolean);
  for (const d of dataLines) {
    if (d === "[DONE]") { parts.push("data: [DONE]"); continue; }
    try {
      const obj = JSON.parse(d);
      rewriteDelta(obj);
      parts.push("data: " + JSON.stringify(obj));
    } catch (_) {
      parts.push("data: " + d); // 不可解析则原样输出
    }
  }

  if (parts.length === 0) return null;
  return parts.join("\n") + "\n\n";
}

// 流式 chunk：delta.reasoning -> delta.reasoning_content
function rewriteDelta(obj) {
  if (!obj || typeof obj !== "object") return;
  if (!Array.isArray(obj.choices)) return;
  for (const c of obj.choices) {
    const d = c && c.delta;
    if (d && typeof d === "object" && d.reasoning != null) {
      if (!d.reasoning_content) d.reasoning_content = d.reasoning;
      // 保留 reasoning 原字段不影响（sub2api 只读 reasoning_content）
    }
  }
}

// 非流式：message.reasoning -> message.reasoning_content
function rewriteNonStream(json) {
  if (!json || typeof json !== "object") return;
  if (!Array.isArray(json.choices)) return;
  for (const c of json.choices) {
    const m = c && c.message;
    if (m && typeof m === "object" && m.reasoning != null) {
      if (!m.reasoning_content) m.reasoning_content = m.reasoning;
    }
  }
}

// 处理 GET /v1/models：拉取 Cline 推荐模型，只保留 free（免费）模型，转成 OpenAI 兼容格式
async function handleModelsRequest(env) {
  const upstream = env.MODELS_UPSTREAM || MODELS_UPSTREAM;
  try {
    const list = await fetchFreeModels(upstream);
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: { message: "models fetch failed: " + e.message, type: "upstream_error" },
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

// 拉取免费模型列表：成功/失败都按 upstream 缓存（TTL / 负缓存），并发去重避免重复打上游
async function fetchFreeModels(upstream) {
  if (modelsCache && modelsCache.upstream === upstream) {
    const age = Date.now() - modelsCache.timestamp;
    if (modelsCache.error) {
      if (age < MODELS_ERROR_CACHE_MS) throw modelsCache.error; // 负缓存：短时间内直接复用上次失败
    } else if (age < MODELS_CACHE_TTL_MS) {
      return modelsCache.list;
    }
  }
  if (modelsInflight.has(upstream)) return modelsInflight.get(upstream);

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
    try {
      // Cline 推荐模型端点无需鉴权；带 UA 与官方客户端一致
      const resp = await fetch(upstream, {
        headers: { "User-Agent": "Cline/3.0.38" },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error("recommended-models returned " + resp.status);
      const json = await resp.json();
      const free = Array.isArray(json.free) ? json.free : [];

      const list = {
        object: "list",
        data: free
          .filter((m) => m && typeof m === "object" && m.id && typeof m.id === "string") // 防御脏数据
          .map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: m.id.split("/")[0] || "cline",
            ...(m.name ? { name: m.name } : {}), // 附加字段，客户端可显示友好名
            ...(m.description ? { description: m.description } : {}),
          })),
      };

      modelsCache = { upstream, timestamp: Date.now(), list, error: null };
      return list;
    } catch (e) {
      modelsCache = { upstream, timestamp: Date.now(), list: null, error: e };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  })();
  modelsInflight.set(upstream, promise);

  try {
    return await promise;
  } finally {
    if (modelsInflight.get(upstream) === promise) modelsInflight.delete(upstream);
  }
}