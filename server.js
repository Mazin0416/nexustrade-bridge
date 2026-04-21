/**
 * NexusTrade — Capital.com Bridge Server v3
 *
 * Run locally:  node server.js
 * Deploy free:  Render.com / Railway.app
 *
 * KEY FIX: error.null.accountId means the wrong base URL is being used.
 * Demo accounts MUST use demo-api-capital.backend-capital.com
 * Live accounts MUST use api-capital.backend-capital.com
 */

const https = require('https');
const http  = require('http');
const url   = require('url');

const PORT = process.env.PORT || 3001;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type'                : 'application/json',
};

// Session cache keyed by apiKey
const sessions = {};

function reply(res, status, body) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(body));
}

// Make an HTTPS request to Capital.com
function capitalReq(hostname, path, method, headers, bodyStr, cb) {
  const opts = { hostname, port: 443, path, method, headers };
  const req  = https.request(opts, (res) => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { _raw: raw }; }
      cb(null, res.statusCode, res.headers, parsed);
    });
  });
  req.on('error', cb);
  if (bodyStr) req.write(bodyStr);
  req.end();
}

// Create or reuse a Capital.com session
function getSession(apiKey, email, password, env, cb) {
  const cached = sessions[apiKey];
  if (cached && cached.cst && Date.now() < cached.expiry) {
    return cb(null, cached);
  }

  // CRITICAL: demo keys require demo host, live keys require live host
  const hostname = (env === 'live')
    ? 'api-capital.backend-capital.com'
    : 'demo-api-capital.backend-capital.com';

  const body = JSON.stringify({
    identifier       : email,    // your Capital.com login email
    password         : password, // the CUSTOM PASSWORD you set for the API key (not your account password)
    encryptedPassword: false,
  });

  console.log(`\n[auth] Starting session`);
  console.log(`[auth] Host     : ${hostname}`);
  console.log(`[auth] Env      : ${env}`);
  console.log(`[auth] Email    : ${email}`);
  console.log(`[auth] API key  : ${apiKey.slice(0,6)}...`);
  console.log(`[auth] Pwd len  : ${password ? password.length : 0} chars`);

  const headers = {
    'X-CAP-API-KEY' : apiKey,
    'Content-Type'  : 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };

  capitalReq(hostname, '/api/v1/session', 'POST', headers, body, (err, status, resHeaders, data) => {
    if (err) {
      console.error('[auth] Network error:', err.message);
      return cb(new Error('Network error: ' + err.message));
    }

    console.log(`[auth] Status  : ${status}`);
    console.log(`[auth] Response: ${JSON.stringify(data).slice(0, 400)}`);

    if (status !== 200) {
      const msg = data.errorCode || data.errorMessage || JSON.stringify(data);

      // Give a specific helpful message for the most common errors
      if (msg.includes('null.accountId') || msg.includes('accountId')) {
        return cb(new Error(
          `Auth failed: error.null.accountId — This means your API key is for a ${env === 'demo' ? 'LIVE' : 'DEMO'} account but you selected "${env}" mode. ` +
          `Switch Account Type to "${env === 'demo' ? 'Live' : 'Demo'}" in Settings and try again.`
        ));
      }
      if (msg.includes('invalid.api.key') || msg.includes('apiKey')) {
        return cb(new Error('Auth failed: Invalid API key. Regenerate your key in Capital.com → Settings → API Integrations.'));
      }
      if (msg.includes('invalid.password') || msg.includes('password')) {
        return cb(new Error('Auth failed: Wrong password. Use the CUSTOM PASSWORD you set when generating the API key — not your account login password.'));
      }
      if (msg.includes('invalid.identifier') || msg.includes('identifier')) {
        return cb(new Error('Auth failed: Wrong email. Use your Capital.com login email address.'));
      }

      return cb(new Error(`Auth failed (${status}): ${msg}`));
    }

    const cst   = resHeaders['cst']               || resHeaders['CST']               || '';
    const token = resHeaders['x-security-token']  || resHeaders['X-SECURITY-TOKEN']  || '';

    if (!cst) {
      console.warn('[auth] WARNING: CST missing from response headers');
      console.log('[auth] All headers:', JSON.stringify(resHeaders));
    }

    sessions[apiKey] = { cst, token, hostname, env, expiry: Date.now() + 8 * 60 * 1000 };
    console.log('[auth] Session created OK\n');
    cb(null, sessions[apiKey]);
  });
}

// Main HTTP server
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const parsed  = url.parse(req.url, true);
  const reqPath = parsed.pathname;

  // Health check
  if (reqPath === '/health') {
    return reply(res, 200, {
      status  : 'ok',
      version : 'v3',
      sessions: Object.keys(sessions).length,
      time    : new Date().toISOString(),
    });
  }

  if (!reqPath.startsWith('/bridge/') && !reqPath.startsWith('/alpaca/')) {
    return reply(res, 404, { error: 'Use /bridge/<path> or /alpaca/<path>. Health: /health' });
  }

  let rawBody = '';
  req.on('data', c => rawBody += c);
  req.on('end', () => {
    let body = {};
    try { if (rawBody) body = JSON.parse(rawBody); } catch {}

    // ── ALPACA routes (/alpaca/*) ─────────────────────────────────────
    if (reqPath.startsWith('/alpaca/')) {
      const alpacaKeyId  = req.headers['x-alpaca-key-id']     || body._alpacaKeyId     || '';
      const alpacaSecret = req.headers['x-alpaca-secret-key'] || body._alpacaSecretKey || '';
      const alpacaPaper  = req.headers['x-alpaca-paper']      || body._alpacaPaper     || 'true';

      if (!alpacaKeyId || !alpacaSecret) {
        return reply(res, 400, { error: 'Missing X-Alpaca-Key-Id or X-Alpaca-Secret-Key headers' });
      }

      const alpacaHost = alpacaPaper === 'false'
        ? 'api.alpaca.markets'
        : 'paper-api.alpaca.markets';

      // Data API uses separate host
      const dataPath = reqPath.replace('/alpaca/data/', '');
      const alpacaDataHost = 'data.alpaca.markets';

      const isDataRoute = reqPath.startsWith('/alpaca/data/');
      const hostname    = isDataRoute ? alpacaDataHost : alpacaHost;
      const alpacaPath  = isDataRoute
        ? '/v2/' + dataPath
        : '/v2/' + reqPath.replace('/alpaca/', '');

      const fwdBody = Object.assign({}, body);
      ['_alpacaKeyId','_alpacaSecretKey','_alpacaPaper'].forEach(k => delete fwdBody[k]);
      const hasBody = ['POST','PUT','PATCH'].includes(req.method) && Object.keys(fwdBody).length > 0;
      const bodyStr = hasBody ? JSON.stringify(fwdBody) : null;

      const headers = {
        'APCA-API-KEY-ID'     : alpacaKeyId,
        'APCA-API-SECRET-KEY' : alpacaSecret,
        'Content-Type'        : 'application/json',
      };
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

      const qs = parsed.search || '';
      console.log(`[alpaca] ${req.method} ${hostname}${alpacaPath + qs}`);

      capitalReq(hostname, alpacaPath + qs, req.method, headers, bodyStr, (err, status, _h, data) => {
        if (err) return reply(res, 502, { error: err.message });
        console.log(`[alpaca] <- ${status}`);
        reply(res, status, data);
      });
      return;
    }

    // ── Capital.com /bridge/* routes ──────────────────────────────────
    const apiKey   = req.headers['x-cap-api-key']     || body.apiKey   || '';
    const email    = req.headers['x-bridge-email']    || body.email    || '';
    const password = req.headers['x-bridge-password'] || body.password || '';
    const env      = req.headers['x-bridge-env']      || body.env      || 'demo';

    if (!apiKey)   return reply(res, 400, { error: 'Missing X-CAP-API-KEY header' });
    if (!email)    return reply(res, 400, { error: 'Missing X-Bridge-Email header' });
    if (!password) return reply(res, 400, { error: 'Missing X-Bridge-Password header' });

    // Strip internal bridge fields before forwarding
    const fwdBody = Object.assign({}, body);
    ['apiKey','email','password','env'].forEach(k => delete fwdBody[k]);

    const capitalPath = '/api/v1/' + reqPath.replace('/bridge/', '') + (parsed.search || '');
    const hasBody     = ['POST','PUT'].includes(req.method) && Object.keys(fwdBody).length > 0;
    const bodyStr     = hasBody ? JSON.stringify(fwdBody) : null;

    console.log(`[proxy] ${req.method} ${capitalPath}`);

    getSession(apiKey, email, password, env, (err, session) => {
      if (err) return reply(res, 401, { error: err.message });

      const headers = {
        'X-CAP-API-KEY'   : apiKey,
        'X-SECURITY-TOKEN': session.token,
        'CST'             : session.cst,
        'Content-Type'    : 'application/json',
      };
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

      capitalReq(session.hostname, capitalPath, req.method, headers, bodyStr, (err2, status, _h, data) => {
        if (err2) return reply(res, 502, { error: err2.message });
        if (status === 401) {
          console.log('[proxy] Session expired, clearing cache');
          delete sessions[apiKey];
        }
        console.log(`[proxy] <- ${status}`);
        reply(res, status, data);
      });
    });
  });

}).listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║  NexusTrade Bridge Server v4                   ║
║  http://localhost:${PORT}/health                   ║
║                                                ║
║  Routes:                                       ║
║  /bridge/*  → Capital.com (forex CFDs)         ║
║  /alpaca/*  → Alpaca (US options & stocks)     ║
╚════════════════════════════════════════════════╝

Waiting for requests...
`);
});
