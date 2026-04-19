/**
 * NexusTrade — Capital.com Bridge Server
 * Proxies requests from your HTML dashboard to Capital.com's API,
 * handling CORS and session management server-side.
 *
 * Deploy free on Render.com or run locally: node server.js
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3001;

// ─── Capital.com base URLs ───────────────────────────────────────────
const CAPITAL_DEMO = 'demo-api-capital.backend-capital.com';
const CAPITAL_LIVE = 'api-capital.backend-capital.com';

// ─── In-memory session store (per API key) ───────────────────────────
// { [apiKey]: { cst, token, expiry, env } }
const sessions = {};

// ─── CORS headers sent on every response ─────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-CAP-API-KEY,X-BRIDGE-ENV',
  'Content-Type'                : 'application/json',
};

function send(res, status, body) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(body));
}

// ─── Forward a request to Capital.com ────────────────────────────────
function forward(options, body, callback) {
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
      callback(null, res.statusCode, res.headers, parsed);
    });
  });
  req.on('error', err => callback(err));
  if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
}

// ─── Ensure a valid Capital.com session ──────────────────────────────
function ensureSession(apiKey, email, password, env, callback) {
  const existing = sessions[apiKey];
  if (existing && existing.cst && Date.now() < existing.expiry) {
    return callback(null, existing);
  }

  const host = env === 'live' ? CAPITAL_LIVE : CAPITAL_DEMO;
  const body = JSON.stringify({ identifier: email, password, encryptedPassword: false });

  const options = {
    host,
    path: '/api/v1/session',
    method: 'POST',
    headers: {
      'X-CAP-API-KEY': apiKey,
      'Content-Type' : 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  forward(options, body, (err, status, headers, data) => {
    if (err) return callback(err);
    if (status !== 200) {
      return callback(new Error('Auth failed: ' + (data.errorCode || data.status || status)));
    }
    const session = {
      cst   : headers['cst']               || headers['CST']               || '',
      token : headers['x-security-token']  || headers['X-SECURITY-TOKEN']  || '',
      expiry: Date.now() + 8 * 60 * 1000, // 8 min buffer
      env,
      host,
    };
    sessions[apiKey] = session;
    callback(null, session);
  });
}

// ─── Main request handler ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // Health check
  if (path === '/health') {
    return send(res, 200, { status: 'ok', sessions: Object.keys(sessions).length });
  }

  // ── Read request body ──
  let rawBody = '';
  req.on('data', chunk => rawBody += chunk);
  req.on('end', () => {
    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}

    const apiKey  = req.headers['x-cap-api-key']  || body.apiKey  || '';
    const email   = body.email    || '';
    const password= body.password || '';
    const env     = req.headers['x-bridge-env'] || body.env || 'demo';

    if (!apiKey) return send(res, 400, { error: 'X-CAP-API-KEY header required' });

    // ── POST /bridge/session — create/refresh session ──
    if (path === '/bridge/session' && req.method === 'POST') {
      if (!email || !password) return send(res, 400, { error: 'email and password required' });
      ensureSession(apiKey, email, password, env, (err, session) => {
        if (err) return send(res, 401, { error: err.message });
        send(res, 200, { ok: true, env: session.env });
      });
      return;
    }

    // ── All other /bridge/* routes — proxy to Capital.com ──
    if (!path.startsWith('/bridge/')) {
      return send(res, 404, { error: 'Unknown route. Use /bridge/...' });
    }

    const capitalPath = '/api/v1/' + path.replace('/bridge/', '');
    const qs = parsed.search || '';

    ensureSession(apiKey, email, password, env, (err, session) => {
      if (err) return send(res, 401, { error: err.message });

      const proxyHeaders = {
        'X-CAP-API-KEY'   : apiKey,
        'X-SECURITY-TOKEN': session.token,
        'CST'             : session.cst,
        'Content-Type'    : 'application/json',
      };

      const forwardBody  = ['POST','PUT'].includes(req.method) ? body : null;
      if (forwardBody) {
        // Remove bridge-only fields
        delete forwardBody.email;
        delete forwardBody.password;
        delete forwardBody.apiKey;
        delete forwardBody.env;
        proxyHeaders['Content-Length'] = Buffer.byteLength(JSON.stringify(forwardBody));
      }

      const options = {
        host  : session.host,
        path  : capitalPath + qs,
        method: req.method,
        headers: proxyHeaders,
      };

      forward(options, forwardBody, (err2, status, _headers, data) => {
        if (err2) return send(res, 502, { error: err2.message });

        // If session expired, clear it so next call re-auths
        if (status === 401) delete sessions[apiKey];

        send(res, status, data);
      });
    });
  });
});

server.listen(PORT, () => {
  console.log(`NexusTrade Bridge running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
