const { upstreamCfg, buildUpstreamHeaders, connectUpstreamSSE, withAbortTimeout, getSessionFromReq } = require('../src/lib/upstream');
const { writeSseHeaders, heartbeat, writeEvent, logStart, logEnd } = require('../src/lib/logger');

function handleOptions(req, res) {
  // CORS 预检
  res.statusCode = 204;
  const { corsHeaders } = require('../src/lib/logger');
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.end();
}

module.exports = async (req, res) => {
  const start = logStart(req);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  // SSE 下游响应头
  writeSseHeaders(res);
  // 立即“开闸”
  res.flushHeaders?.();

  const { sessionId, lastEventId } = getSessionFromReq(req);
  const headers = buildUpstreamHeaders({}, {
    mcpSessionId: sessionId,
    lastEventId,
    accept: 'text/event-stream',
  });

  let attempt = 0;
  let closed = false;
  const hb = setInterval(() => heartbeat(res), 15_000);
  req.on('close', () => {
    closed = true;
    clearInterval(hb);
  });

  async function loop() {
    attempt += 1;
    const backoff = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));
    try {
      const { signal, cancel } = withAbortTimeout(upstreamCfg.timeoutMs);
      const upstreamRes = await connectUpstreamSSE(upstreamCfg.sseUrl, headers, { signal });
      const ct = upstreamRes.headers.get('content-type');
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
      writeEvent(res, 'error', { msg: 'upstream_error', reason: String(err?.message || err) || 'unknown', attempt, nextDelayMs: backoff });
      if (!closed) setTimeout(() => { if (!closed) loop(); }, backoff);
    }
  }

  // 下游建立后立即提示
  writeEvent(res, 'ready', { upstreamSseUrl: upstreamCfg.sseUrl });
  loop();
  // 注意：在 Vercel Serverless 上，函数存在最大执行时长限制，可能影响长连。详见 README。

  // 不要结束 res；保持长连
  // 在关闭事件中我们只清理心跳
  logEnd(req, 200, start, { upstreamSseUrl: upstreamCfg.sseUrl });
};
