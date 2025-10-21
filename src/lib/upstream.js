const { Agent, fetch } = require('undici');

function parseJsonSafe(str, fallback = {}) {
  try {
    if (!str) return fallback;
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

function deriveSseUrl(from) {
  try {
    const u = new URL(from);
    if (u.pathname.endsWith('/mcp')) {
      u.pathname = u.pathname.replace(/\/mcp$/, '/sse');
    }
    return u.toString();
  } catch {
    return from;
  }
}

const upstreamCfg = {
  url: process.env.UPSTREAM_URL || 'https://mcp.deepwiki.com/mcp',
  sseUrl: process.env.UPSTREAM_SSE_URL || deriveSseUrl(process.env.UPSTREAM_URL || 'https://mcp.deepwiki.com/sse'),
  headersJson: parseJsonSafe(process.env.UPSTREAM_HEADERS_JSON || '{}'),
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 0),
};

// 调试日志
console.log('[Upstream Config] URL:', upstreamCfg.url);
console.log('[Upstream Config] SSE URL:', upstreamCfg.sseUrl);
console.log('[Upstream Config] Headers:', JSON.stringify(upstreamCfg.headersJson));
console.log('[Upstream Config] Timeout:', upstreamCfg.timeoutMs);

const dispatcher = new Agent({
  keepAliveTimeout: 15_000,
  maxRedirections: 5,
  connections: 50,
});

function buildUpstreamHeaders(base = {}, { mcpSessionId, lastEventId, accept, contentType } = {}) {
  const merged = {
    Accept: accept || 'application/json, text/event-stream',
    ...upstreamCfg.headersJson,
    ...base,
  };
  if (contentType) merged['Content-Type'] = contentType;
  if (mcpSessionId) merged['Mcp-Session-Id'] = mcpSessionId;
  if (lastEventId) merged['Last-Event-ID'] = lastEventId;
  return merged;
}

function readReqBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function getSessionFromReq(req) {
  const urlObj = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(urlObj.searchParams.entries());
  const sessionId = req.headers['mcp-session-id'] || q.sessionId;
  const lastEventId = req.headers['last-event-id'] || q.lastEventId;
  return { sessionId, lastEventId, query: q };
}

async function connectUpstreamSSE(sseUrl, headers, { signal } = {}) {
  const res = await fetch(sseUrl, {
    method: 'GET',
    headers,
    dispatcher,
    signal,
  });
  return res;
}

async function postJson(url, bodyStr, headers, { signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyStr,
    dispatcher,
    signal,
  });
  return res;
}

function withAbortTimeout(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return { signal: undefined, cancel: () => {} };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('upstream-timeout')), timeoutMs);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function autoInitializeSession(extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': `mcp-forwarder-node/1.2`,
  };
  const body = {
    jsonrpc: '2.0',
    id: 'init-' + Date.now(),
    method: 'initialize',
    params: {
      clientInfo: { name: 'mcp-forwarder-node', version: '1.2' },
      capabilities: {}
    }
  };
  const startedAt = Date.now();
  try {
    const resp = await fetch(upstreamCfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher,
    });
    const ct = resp.headers.get('content-type') || '';
    const sessionId = resp.headers.get('mcp-session-id') || resp.headers.get('Mcp-Session-Id');
    let resultJson = null;
    if (ct.includes('application/json')) {
      try { resultJson = await resp.json(); } catch (_) {}
    }
    const dur = Date.now() - startedAt;
    console.log(`[autoInitializeSession] complete - status: ${resp.status}, duration: ${dur}ms, sessionId: ${sessionId || 'null'}`);
    return {
      ok: resp.ok,
      status: resp.status,
      sessionId: sessionId || null,
      result: resultJson,
      text: sessionId ? undefined : (!ct.includes('application/json') ? await resp.text().catch(() => undefined) : undefined)
    };
  } catch (err) {
    const dur = Date.now() - startedAt;
    console.error(`[autoInitializeSession] failed - error: ${err.message}, duration: ${dur}ms`);
    return { ok: false, status: 0, sessionId: null, error: err.message };
  }
}

module.exports = {
  upstreamCfg,
  dispatcher,
  buildUpstreamHeaders,
  readReqBody,
  getSessionFromReq,
  deriveSseUrl,
  connectUpstreamSSE,
  postJson,
  withAbortTimeout,
  autoInitializeSession,
};
