const { upstreamCfg } = require('../src/lib/upstream');
const { logStart, logEnd } = require('../src/lib/logger');

function handleOptions(req, res) {
  const { corsHeaders } = require('../src/lib/logger');
  res.statusCode = 204;
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.end();
}

module.exports = (req, res) => {
  const start = logStart(req);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  const data = {
    status: 'ok',
    upstream: upstreamCfg.url,
    upstreamSse: upstreamCfg.sseUrl,
    corsOrigin: process.env.CORS_ORIGIN || '*',
    upstreamCfg: {
      timeout_ms: upstreamCfg.timeoutMs || 0,
      headers: upstreamCfg.headersJson,
    },
    time: new Date().toISOString(),
  };
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  const { corsHeaders } = require('../src/lib/logger');
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(data));
  logEnd(req, 200, start, {});
};
