const { upstreamCfg, buildUpstreamHeaders, readReqBody, postJson, withAbortTimeout, getSessionFromReq, autoInitializeSession, connectUpstreamSSE } = require('../src/lib/upstream');
const { logStart, logEnd, writeSseHeaders, writeEvent } = require('../src/lib/logger');

function handleOptions(req, res) {
  const { corsHeaders } = require('../src/lib/logger');
  res.statusCode = 204;
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.end();
}

module.exports = async (req, res) => {
  const start = logStart(req);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  
  // 处理 GET 请求（SSE 模式）
  if (req.method === 'GET') {
    return handleGet(req, res, start);
  }
  
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  const { sessionId } = getSessionFromReq(req);
  const urlObj = new URL(upstreamCfg.url);
  // 保留下游查询参数
  const incoming = new URL(req.url, 'http://localhost');
  incoming.searchParams.forEach((v, k) => urlObj.searchParams.set(k, v));

  try {
    const bodyStr = await readReqBody(req);
    const headers = buildUpstreamHeaders({}, {
      mcpSessionId: sessionId,
      accept: 'application/json, text/event-stream',
      contentType: 'application/json',
    });
    const { signal, cancel } = withAbortTimeout(upstreamCfg.timeoutMs);
    const upstreamRes = await postJson(urlObj.toString(), bodyStr, headers, { signal });
    cancel();
    const text = await upstreamRes.text();
    res.statusCode = upstreamRes.status;
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');
    res.setHeader('Mcp-Session-Id', upstreamRes.headers.get('mcp-session-id') || (sessionId || ''));
    const { corsHeaders } = require('../src/lib/logger');
    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    res.end(text);
    logEnd(req, upstreamRes.status, start, { upstreamUrl: urlObj.toString() });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'upstream_failed', message: String(err?.message || err) }));
    logEnd(req, 502, start, { error: String(err?.message || err) });
  }
};

// 处理 GET 请求（SSE 模式）
async function handleGet(req, res, start) {
  // SSE 下游响应头
  writeSseHeaders(res);
  res.flushHeaders?.();

  let { sessionId, lastEventId } = getSessionFromReq(req);
  console.log('[MCP GET] Connection attempt - SessionId:', sessionId, 'LastEventId:', lastEventId);
  
  // 如果未携带 sessionId，尝试自动初始化获取
  if (!sessionId) {
    writeEvent(res, 'info', { msg: 'no_session_provided_attempting_initialize' });
    const init = await autoInitializeSession(upstreamCfg.headersJson);
    if (init.ok && init.sessionId) {
      sessionId = String(init.sessionId);
      writeEvent(res, 'info', { msg: 'auto_session_created', sessionId });
      if (init.result?.result?.serverInfo) {
        const info = init.result.result.serverInfo;
        writeEvent(res, 'info', { msg: 'server_info', server: `${info.name || ''} v${info.version || ''}` });
      }
    } else {
      writeEvent(res, 'warn', { msg: 'auto_initialize_failed', status: init.status, error: init.error || init.text });
      writeEvent(res, 'info', { msg: 'if_upstream_requires_credentials_set_env_vars' });
    }
  }
  
  const headers = buildUpstreamHeaders({}, {
    mcpSessionId: sessionId,
    lastEventId,
    accept: 'text/event-stream',
  });

  let attempt = 0;
  let closed = false;
  const hb = setInterval(() => {
    if (!closed) writeEvent(res, 'comment', { data: 'heartbeat' });
  }, 15_000);
  req.on('close', () => {
    closed = true;
    clearInterval(hb);
  });

  async function loop() {
    attempt += 1;
    const backoff = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));
    try {
      console.log('[MCP GET] Connecting to upstream SSE:', upstreamCfg.sseUrl);
      const { signal, cancel } = withAbortTimeout(upstreamCfg.timeoutMs);
      const upstreamRes = await connectUpstreamSSE(upstreamCfg.sseUrl, headers, { signal });
      const ct = upstreamRes.headers.get('content-type');
      console.log('[MCP GET] Upstream response status:', upstreamRes.status, 'Content-Type:', ct);
      writeEvent(res, 'info', { msg: 'upstream_connected', status: upstreamRes.status, contentType: ct });
      cancel();
      
      // 读取并透传上游字节（原样）
      const reader = upstreamRes.body.getReader();
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          res.write(Buffer.from(value));
        }
      }
      if (!closed) {
        writeEvent(res, 'warn', { msg: 'upstream_disconnected', attempt, nextDelayMs: backoff });
        setTimeout(() => { if (!closed) loop(); }, backoff);
      }
    } catch (err) {
      console.error('[MCP GET] Upstream connection error:', err.message || err);
      writeEvent(res, 'error', { msg: 'upstream_error', reason: String(err?.message || err) || 'unknown', attempt, nextDelayMs: backoff });
      if (!closed) setTimeout(() => { if (!closed) loop(); }, backoff);
    }
  }

  // 下游建立后立即提示
  writeEvent(res, 'ready', { upstreamSseUrl: upstreamCfg.sseUrl });
  loop();
  
  logEnd(req, 200, start, { upstreamSseUrl: upstreamCfg.sseUrl, sessionId: sessionId || null });
}
