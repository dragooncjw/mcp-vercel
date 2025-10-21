require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { fetch, Agent } = require('undici');
const { URL } = require('url');
const { Readable } = require('stream');

const app = express();

// ---- Config ----
const PORT = parseInt(process.env.PORT || '3000', 10);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://mcp.deepwiki.com/mcp';
// 优先使用显式 SSE 端点，否则将 /mcp 推断为 /sse
const UPSTREAM_SSE_URL = process.env.UPSTREAM_SSE_URL || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
let UPSTREAM_HEADERS = {};
try {
  if (process.env.UPSTREAM_HEADERS_JSON) {
    UPSTREAM_HEADERS = JSON.parse(process.env.UPSTREAM_HEADERS_JSON);
  }
} catch (e) {
  console.warn('[WARN] Failed to parse UPSTREAM_HEADERS_JSON:', e.message);
}

// Server timeouts & keep-alive (默认不对长时请求施加硬超时)
const SERVER_KEEP_ALIVE_TIMEOUT_MS = parseInt(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || '120000', 10); // 120s
const SERVER_HEADERS_TIMEOUT_MS = parseInt(process.env.SERVER_HEADERS_TIMEOUT_MS || '120000', 10); // 120s
const SERVER_REQUEST_TIMEOUT_MS = parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS || '0', 10); // 0 = no timeout

// Upstream keep-alive & timeout
const UPSTREAM_KEEP_ALIVE_MS = parseInt(process.env.UPSTREAM_KEEP_ALIVE_MS || '15000', 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '0', 10); // 0 = disable undici timeouts
const UPSTREAM_MAX_SOCKETS = parseInt(process.env.UPSTREAM_MAX_SOCKETS || '50', 10);

// undici dispatcher with keep-alive & configurable timeouts
const upstreamDispatcher = new Agent({
  connections: UPSTREAM_MAX_SOCKETS,
  keepAliveTimeout: UPSTREAM_KEEP_ALIVE_MS,
  headersTimeout: UPSTREAM_TIMEOUT_MS > 0 ? UPSTREAM_TIMEOUT_MS : 0,
  bodyTimeout: UPSTREAM_TIMEOUT_MS > 0 ? UPSTREAM_TIMEOUT_MS : 0,
});

// ---- Middlewares ----
app.use(morgan('combined'));
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID', 'X-Requested-With', 'Origin'
  ],
  exposedHeaders: ['Mcp-Session-Id', 'Content-Type'],
  credentials: false,
}));
app.use(express.json({ limit: '1mb' }));

// Expose headers for non-CORS middleware paths
app.use((req, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
  next();
});

// ---- Utilities ----
function buildUpstreamUrl(clientReq) {
  try {
    const upstream = new URL(UPSTREAM_URL);
    for (const [key, value] of Object.entries(clientReq.query || {})) {
      upstream.searchParams.set(key, value);
    }
    return upstream.toString();
  } catch (err) {
    throw new Error('Invalid UPSTREAM_URL: ' + err.message);
  }
}

function buildUpstreamSseUrl(clientReq) {
  try {
    let finalUrlStr = UPSTREAM_SSE_URL && typeof UPSTREAM_SSE_URL === 'string' && UPSTREAM_SSE_URL.trim().length > 0
      ? UPSTREAM_SSE_URL
      : UPSTREAM_URL;

    const base = new URL(finalUrlStr);
    // 推断：如果路径以 /mcp 结尾，改为 /sse
    if (!UPSTREAM_SSE_URL && base.pathname.endsWith('/mcp')) {
      finalUrlStr = base.origin + '/sse' + base.search;
    }

    const sseUrl = new URL(finalUrlStr);
    for (const [key, value] of Object.entries(clientReq.query || {})) {
      sseUrl.searchParams.set(key, value);
    }
    return sseUrl.toString();
  } catch (err) {
    throw new Error('Invalid SSE URL: ' + err.message);
  }
}

function sanitizeHeaders(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function sseWrite(res, payload) {
  res.write(payload);
}

function sseComment(text) {
  return `: ${text}\n\n`;
}

function log(level, msg, meta) {
  try {
    const payload = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
    console.log(JSON.stringify(payload));
  } catch (_) {
    console.log(`[${level}] ${msg}`);
  }
}

function reqId(req) {
  return req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function autoInitializeSession(extraHeaders) {
  const headers = {
    ...(extraHeaders || {}),
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
    const resp = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: upstreamDispatcher,
    });
    const ct = resp.headers.get('content-type') || '';
    const sessionId = resp.headers.get('mcp-session-id') || resp.headers.get('Mcp-Session-Id');
    let resultJson = null;
    if (ct.includes('application/json')) {
      try { resultJson = await resp.json(); } catch (_) {}
    }
    const dur = Date.now() - startedAt;
    log('info', 'autoInitializeSession complete', { status: resp.status, duration_ms: dur, sessionId: sessionId || null });
    return {
      ok: resp.ok,
      status: resp.status,
      sessionId: sessionId || null,
      result: resultJson,
      text: sessionId ? undefined : (!ct.includes('application/json') ? await resp.text().catch(() => undefined) : undefined)
    };
  } catch (err) {
    const dur = Date.now() - startedAt;
    log('error', 'autoInitializeSession failed', { error: err.message, duration_ms: dur });
    return { ok: false, status: 0, sessionId: null, error: err.message };
  }
}

// ---- Health ----
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    port: PORT,
    upstream: UPSTREAM_URL,
    upstreamSse: UPSTREAM_SSE_URL || '(derived)',
    corsOrigin: CORS_ORIGIN,
    server: {
      keepAliveTimeout_ms: SERVER_KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout_ms: SERVER_HEADERS_TIMEOUT_MS,
      requestTimeout_ms: SERVER_REQUEST_TIMEOUT_MS,
    },
    upstreamCfg: {
      keepAlive_ms: UPSTREAM_KEEP_ALIVE_MS,
      timeout_ms: UPSTREAM_TIMEOUT_MS,
      maxSockets: UPSTREAM_MAX_SOCKETS,
    },
    time: new Date().toISOString(),
  });
});

// ---- OPTIONS for CORS Preflight ----
app.options('/mcp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID, X-Requested-With, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
  res.status(204).end();
});
app.options('/sse', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID, X-Requested-With, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
  res.status(204).end();
});
app.options('/sse/:subpath', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, X-Requested-With, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
  res.status(204).end();
});

// ---- SSE Forwarding (GET /sse) ----
app.get('/sse', async (req, res) => {
  const rid = reqId(req);
  const startedAt = Date.now();
  // Prepare downstream SSE response headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
  res.flushHeaders?.();

  const lastEventId = req.header('Last-Event-ID');
  let clientSessionId = req.query.sessionId || req.query.session || req.header('Mcp-Session-Id') || null;
  const heartbeatIntervalMs = 15000;
  let heartbeatTimer = null;
  let abortController = null;
  let reconnectAttempts = 0;

  const extraHeaders = sanitizeHeaders(UPSTREAM_HEADERS);
  const upstreamSseUrl = buildUpstreamSseUrl(req);

  log('info', 'downstream SSE connected', { rid, lastEventId: lastEventId || null, clientSessionId: clientSessionId || null, upstreamSseUrl, route: '/sse' });

  // 如果未携带 sessionId，尝试自动初始化获取
  if (!clientSessionId) {
    sseWrite(res, sseComment('no sessionId provided; attempting initialize'));
    const init = await autoInitializeSession(extraHeaders);
    if (init.ok && init.sessionId) {
      clientSessionId = String(init.sessionId);
      sseWrite(res, sseComment(`auto session created: ${clientSessionId}`));
      if (init.result?.result?.serverInfo) {
        const info = init.result.result.serverInfo;
        sseWrite(res, sseComment(`server: ${info.name || ''} v${info.version || ''}`));
      }
    } else {
      sseWrite(res, `event: warn\ndata: ${JSON.stringify({ message: 'auto initialize failed', status: init.status, text: init.text })}\n\n`);
      sseWrite(res, sseComment('if upstream requires credentials, set UPSTREAM_HEADERS_JSON or use ?sessionId='));
    }
  }

  const makeUpstreamRequest = async () => {
    abortController = new AbortController();
    const headers = {
      ...(extraHeaders || {}),
      'Accept': 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      ...(clientSessionId ? { 'Mcp-Session-Id': String(clientSessionId) } : {}),
      'User-Agent': `mcp-forwarder-node/1.2 (+${req.hostname})`,
    };

    try {
      const upstreamResp = await fetch(upstreamSseUrl, {
        method: 'GET',
        headers,
        signal: abortController.signal,
        dispatcher: upstreamDispatcher,
      });

      log('info', 'upstream SSE response', {
        rid, status: upstreamResp.status,
        headers: {
          'content-type': upstreamResp.headers.get('content-type') || '',
          'cache-control': upstreamResp.headers.get('cache-control') || '',
        }
      });

      if (!upstreamResp.ok) {
        const msg = `Upstream SSE responded ${upstreamResp.status}`;
        sseWrite(res, `event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
        throw new Error(msg);
      }

      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        try { sseWrite(res, sseComment('heartbeat')); } catch (_) {}
      }, heartbeatIntervalMs);

      reconnectAttempts = 0;
      sseWrite(res, sseComment('upstream connected'));

      const reader = upstreamResp.body.getReader();
      const pump = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) {
            res.write(Buffer.from(value));
          }
        }
      };

      await pump();
      sseWrite(res, sseComment('upstream closed; will reconnect'));
      log('warn', 'upstream SSE closed', { rid, route: '/sse' });
      scheduleReconnect();
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 6)));
      reconnectAttempts++;
      sseWrite(res, `event: error\ndata: ${JSON.stringify({ message: err.message, attempt: reconnectAttempts })}\n\n`);
      sseWrite(res, sseComment(`reconnecting in ${delay}ms`));
      log('error', 'upstream SSE error', { rid, error: err.message, reconnect_in_ms: delay, route: '/sse' });
      setTimeout(() => {
        makeUpstreamRequest().catch(() => {});
      }, delay);
    }
  };

  const scheduleReconnect = () => {
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 6)));
    reconnectAttempts++;
    setTimeout(() => {
      makeUpstreamRequest().catch(() => {});
    }, delay);
  };

  makeUpstreamRequest().catch(() => {});

  req.on('close', () => {
    clearInterval(heartbeatTimer);
    try { abortController?.abort(); } catch (_) {}
    const dur = Date.now() - startedAt;
    log('info', 'downstream SSE closed', { rid, duration_ms: dur, route: '/sse' });
  });
});

// ---- SSE Forwarding (GET /mcp) ----
app.get('/mcp', async (req, res) => {
  const rid = reqId(req);
  const startedAt = Date.now();
  // Prepare downstream SSE response headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
  res.flushHeaders?.();

  const lastEventId = req.header('Last-Event-ID');
  let clientSessionId = req.query.sessionId || req.query.session || req.header('Mcp-Session-Id') || null;
  const heartbeatIntervalMs = 15000;
  let heartbeatTimer = null;
  let abortController = null;
  let reconnectAttempts = 0;

  const extraHeaders = sanitizeHeaders(UPSTREAM_HEADERS);
  const upstreamSseUrl = buildUpstreamSseUrl(req);

  log('info', 'downstream SSE connected', { rid, lastEventId: lastEventId || null, clientSessionId: clientSessionId || null, upstreamSseUrl });

  // 如果未携带 sessionId，尝试自动初始化获取
  if (!clientSessionId) {
    sseWrite(res, sseComment('no sessionId provided; attempting initialize'));
    const init = await autoInitializeSession(extraHeaders);
    if (init.ok && init.sessionId) {
      clientSessionId = String(init.sessionId);
      sseWrite(res, sseComment(`auto session created: ${clientSessionId}`));
      if (init.result?.result?.serverInfo) {
        const info = init.result.result.serverInfo;
        sseWrite(res, sseComment(`server: ${info.name || ''} v${info.version || ''}`));
      }
    } else {
      sseWrite(res, `event: warn\ndata: ${JSON.stringify({ message: 'auto initialize failed', status: init.status, text: init.text })}\n\n`);
      sseWrite(res, sseComment('if upstream requires credentials, set UPSTREAM_HEADERS_JSON or use ?sessionId='));
    }
  }

  const makeUpstreamRequest = async () => {
    abortController = new AbortController();
    const headers = {
      ...(extraHeaders || {}),
      'Accept': 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      ...(clientSessionId ? { 'Mcp-Session-Id': String(clientSessionId) } : {}),
      'User-Agent': `mcp-forwarder-node/1.2 (+${req.hostname})`,
    };

    try {
      const upstreamResp = await fetch(upstreamSseUrl, {
        method: 'GET',
        headers,
        signal: abortController.signal,
        dispatcher: upstreamDispatcher,
      });

      log('info', 'upstream SSE response', {
        rid, status: upstreamResp.status,
        headers: {
          'content-type': upstreamResp.headers.get('content-type') || '',
          'cache-control': upstreamResp.headers.get('cache-control') || '',
        }
      });

      if (!upstreamResp.ok) {
        const msg = `Upstream SSE responded ${upstreamResp.status}`;
        sseWrite(res, `event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
        throw new Error(msg);
      }

      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        try { sseWrite(res, sseComment('heartbeat')); } catch (_) {}
      }, heartbeatIntervalMs);

      reconnectAttempts = 0;
      sseWrite(res, sseComment('upstream connected'));

      const reader = upstreamResp.body.getReader();
      const pump = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) {
            res.write(Buffer.from(value));
          }
        }
      };

      await pump();
      sseWrite(res, sseComment('upstream closed; will reconnect'));
      log('warn', 'upstream SSE closed', { rid });
      scheduleReconnect();
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 6)));
      reconnectAttempts++;
      sseWrite(res, `event: error\ndata: ${JSON.stringify({ message: err.message, attempt: reconnectAttempts })}\n\n`);
      sseWrite(res, sseComment(`reconnecting in ${delay}ms`));
      log('error', 'upstream SSE error', { rid, error: err.message, reconnect_in_ms: delay });
      setTimeout(() => {
        makeUpstreamRequest().catch(() => {});
      }, delay);
    }
  };

  const scheduleReconnect = () => {
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 6)));
    reconnectAttempts++;
    setTimeout(() => {
      makeUpstreamRequest().catch(() => {});
    }, delay);
  };

  makeUpstreamRequest().catch(() => {});

  req.on('close', () => {
    clearInterval(heartbeatTimer);
    try { abortController?.abort(); } catch (_) {}
    const dur = Date.now() - startedAt;
    log('info', 'downstream SSE closed', { rid, duration_ms: dur });
  });
});

// ---- POST Forwarding (POST /mcp) ----
app.post('/mcp', async (req, res) => {
  const rid = reqId(req);
  const startedAt = Date.now();
  const upstreamUrl = buildUpstreamUrl(req);
  const extraHeaders = sanitizeHeaders(UPSTREAM_HEADERS);

  const incomingSessionId = req.header('Mcp-Session-Id') || req.query.sessionId || null;
  const headers = {
    ...(extraHeaders || {}),
    ...(incomingSessionId ? { 'Mcp-Session-Id': String(incomingSessionId) } : {}),
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': `mcp-forwarder-node/1.2 (+${req.hostname})`,
    'Connection': 'keep-alive',
  };

  let bodyString;
  try {
    bodyString = JSON.stringify(req.body ?? {});
  } catch (err) {
    log('error', 'invalid JSON body', { rid, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON body', message: err.message });
  }

  log('info', 'forward POST start', { rid, upstreamUrl, sessionId: incomingSessionId || null });

  try {
    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: bodyString,
      dispatcher: upstreamDispatcher,
    });

    const contentType = upstreamResp.headers.get('content-type') || '';
    const status = upstreamResp.status;
    const sessHdr = upstreamResp.headers.get('mcp-session-id') || upstreamResp.headers.get('Mcp-Session-Id') || '';
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
    if (sessHdr) res.setHeader('Mcp-Session-Id', sessHdr);

    log('info', 'forward POST response', { rid, status, contentType, upstream_session_header: sessHdr });

    if (contentType.includes('application/json')) {
      // 避免默认 bodyTimeout，依赖上游配置的无限超时；直接读取 JSON
      const data = await upstreamResp.json();
      res.status(status).json(data);
    } else if (upstreamResp.body) {
      // 非 JSON 情况透传文本或二进制（避免缓冲导致内存压力）
      res.status(status);
      if (contentType) res.set('Content-Type', contentType);
      const nodeStream = Readable.fromWeb(upstreamResp.body);
      nodeStream.pipe(res);
    } else {
      const text = await upstreamResp.text();
      res.status(status).type('text/plain').send(text);
    }
  } catch (err) {
    const dur = Date.now() - startedAt;
    log('error', 'forward POST failed', { rid, error: err.message, duration_ms: dur });
    res.status(502).json({ error: 'Upstream request failed', code: -32001, message: err.message });
  }
});

// ---- POST Forwarding for SSE message paths (POST /sse/...) ----
app.post('/sse/:subpath', async (req, res) => {
  const rid = reqId(req);
  const startedAt = Date.now();
  // 兼容 Inspector 根据 SSE endpoint 事件发送到本地 /sse/message?sessionId=...
  const sseBase = buildUpstreamSseUrl(req);
  const base = new URL(sseBase);
  const upstreamSseBase = base.origin + '/sse';
  const upstreamUrl = new URL(upstreamSseBase + req.path.replace('/sse', ''));
  // 合并查询参数
  for (const [key, value] of Object.entries(req.query || {})) {
    upstreamUrl.searchParams.set(key, value);
  }

  const extraHeaders = sanitizeHeaders(UPSTREAM_HEADERS);
  const incomingSessionId = req.header('Mcp-Session-Id') || req.query.sessionId || null;
  const headers = {
    ...(extraHeaders || {}),
    ...(incomingSessionId ? { 'Mcp-Session-Id': String(incomingSessionId) } : {}),
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': `mcp-forwarder-node/1.2 (+${req.hostname})`,
    'Connection': 'keep-alive',
  };

  let bodyString;
  try {
    bodyString = JSON.stringify(req.body ?? {});
  } catch (err) {
    log('error', 'invalid JSON body (sse)', { rid, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON body', message: err.message });
  }

  log('info', 'forward SSE POST start', { rid, upstreamUrl: upstreamUrl.toString(), sessionId: incomingSessionId || null });

  try {
    const upstreamResp = await fetch(upstreamUrl.toString(), {
      method: 'POST',
      headers,
      body: bodyString,
      dispatcher: upstreamDispatcher,
    });
    const contentType = upstreamResp.headers.get('content-type') || '';
    const status = upstreamResp.status;
    const sessHdr = upstreamResp.headers.get('mcp-session-id') || upstreamResp.headers.get('Mcp-Session-Id') || '';
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type');
    if (sessHdr) res.setHeader('Mcp-Session-Id', sessHdr);

    log('info', 'forward SSE POST response', { rid, status, contentType, upstream_session_header: sessHdr });

    if (contentType.includes('application/json')) {
      const data = await upstreamResp.json();
      res.status(status).json(data);
    } else if (upstreamResp.body) {
      res.status(status);
      if (contentType) res.set('Content-Type', contentType);
      const nodeStream = Readable.fromWeb(upstreamResp.body);
      nodeStream.pipe(res);
    } else {
      const text = await upstreamResp.text();
      res.status(status).type('text/plain').send(text);
    }
  } catch (err) {
    const dur = Date.now() - startedAt;
    log('error', 'forward SSE POST failed', { rid, error: err.message, duration_ms: dur });
    res.status(502).json({ error: 'Upstream request failed', code: -32001, message: err.message });
  }
});

// ---- 慢请求验证端点（本地模拟） ----
app.get('/test/slow', async (req, res) => {
  const rid = reqId(req);
  const delay = parseInt(req.query.ms || '40000', 10);
  log('info', 'slow GET begin', { rid, delay_ms: delay });
  res.setHeader('Content-Type', 'application/json');
  setTimeout(() => {
    log('info', 'slow GET finish', { rid });
    res.status(200).json({ ok: true, delay_ms: delay });
  }, delay);
});
app.post('/test/slow', async (req, res) => {
  const rid = reqId(req);
  const delay = parseInt((req.query.ms || req.body?.ms || '40000'), 10);
  log('info', 'slow POST begin', { rid, delay_ms: delay });
  setTimeout(() => {
    log('info', 'slow POST finish', { rid });
    res.status(200).json({ ok: true, delay_ms: delay, echo: req.body || {} });
  }, delay);
});

// ---- Fallback 404 ----
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ---- Error Handler ----
app.use((err, req, res, next) => {
  log('error', 'unhandled error', { error: err?.message || String(err) });
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---- Start ----
const server = app.listen(PORT, () => {
  console.log(`MCP forwarder listening on http://127.0.0.1:${PORT}`);
  console.log(`Upstream: ${UPSTREAM_URL}`);
  console.log(`Upstream SSE: ${UPSTREAM_SSE_URL || '(derived from /mcp -> /sse)'}`);
});

try {
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  // 0 表示不启用请求超时（允许 ask_question 等长时调用）
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  console.log('[server] timeouts', {
    keepAliveTimeout_ms: server.keepAliveTimeout,
    headersTimeout_ms: server.headersTimeout,
    requestTimeout_ms: server.requestTimeout,
  });
} catch (e) {
  console.warn('[WARN] set server timeouts failed:', e.message);
}