const { upstreamCfg, buildUpstreamHeaders, readReqBody, postJson, withAbortTimeout, getSessionFromReq } = require('../../src/lib/upstream');
const { logStart, logEnd } = require('../../src/lib/logger');

function handleOptions(req, res) {
  const { corsHeaders } = require('../../src/lib/logger');
  res.statusCode = 204;
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.end();
}

module.exports = async (req, res) => {
  const start = logStart(req);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  const { sessionId } = getSessionFromReq(req);
  const urlObj = new URL(upstreamCfg.sseUrl);
  urlObj.pathname = '/sse/message';
  // 保留下游查询参数（包含 sessionId）
  const incoming = new URL(req.url, 'http://localhost');
  incoming.searchParams.forEach((v, k) => urlObj.searchParams.set(k, v));
  // 若 header 携带 Mcp-Session-Id 但查询未携带，则从 header 透传
  if (sessionId && !urlObj.searchParams.get('sessionId')) urlObj.searchParams.set('sessionId', sessionId);

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
    // 暴露关键信息
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'text/plain');
    res.setHeader('Mcp-Session-Id', upstreamRes.headers.get('mcp-session-id') || (sessionId || ''));
    const { corsHeaders } = require('../../src/lib/logger');
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
