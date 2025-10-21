function now() { return Date.now(); }
function ms(d) { return `${d}ms`; }

function corsHeaders(origin) {
  const allowOrigin = process.env.CORS_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID, X-Requested-With, Origin',
    'Access-Control-Expose-Headers': 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID',
  };
}

function writeSseHeaders(res, extra = {}) {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
    ...extra,
  };
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
}

function heartbeat(res) {
  res.write(': heartbeat\n\n');
}

function writeEvent(res, event, data) {
  if (event === 'comment') {
    // 特殊处理注释事件
    if (data && data.data) {
      res.write(`: ${data.data}\n\n`);
    } else {
      res.write(': \n\n');
    }
    return;
  }
  if (event) res.write(`event: ${event}\n`);
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`data: ${str}\n\n`);
  } else {
    res.write('\n');
  }
}

function logStart(req) {
  const start = now();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - start`);
  return start;
}

function logEnd(req, status, start, extra = {}) {
  const dur = now() - start;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - end status=${status} dur=${ms(dur)} ${JSON.stringify(extra)}`);
}

module.exports = {
  ms,
  corsHeaders,
  writeSseHeaders,
  heartbeat,
  writeEvent,
  logStart,
  logEnd,
};
