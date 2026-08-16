// 把 Cline 返回的 delta.reasoning 重写为 delta.reasoning_content，
// 使 sub2api（只识别 reasoning_content）能把思考转成 Anthropic thinking block。

const DEFAULT_UPSTREAM = "https://api.cline.bot/api/v1/chat/completions";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request, env) {
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