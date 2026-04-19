/**
 * NexusTrade — Capital.com Bridge Server v2
 * Fixed auth flow with proper field handling and debug logging.
 *
 * Run:  node server.js
 * Port: 3001 (or set PORT env var)
 */

const https = require('https');
const http  = require('http');
const url   = require('url');

const PORT         = process.env.PORT || 3001;
const CAPITAL_DEMO = 'demo-api-capital.backend-capital.com';
const CAPITAL_LIVE = 'api-capital.backend-capital.com';

const sessions = {};

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-CAP-API-KEY,X-Bridge-Env,X-Bridge-Email,X-Bridge-Password',
  'Content-Type'                : 'application/json',
};

function reply(res, status, body) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(body));
}

function capitalRequest(options, bodyStr, cb) {
  const req = https.request(options, (res) => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { _raw: raw }; }
      cb(null, res.statusCode, res.headers, parsed);
    });
  });
  req.on('error', err => cb(err));
  if (bodyStr) req.write(bodyStr);
  req.end();
}

function getSession(apiKey, email, password, env, cb) {
  const cached = sessions[apiKey];
  if (cached && cached.cst && Date.now() < cached.expiry) {
    return cb(null, cached);
  }

  const host    = env === 'live' ? CAPITAL_LIVE : CAPITAL_DEMO;
  const bodyStr = JSON.stringify({ identifier: email, password, encryptedPassword: false });

  console.log('[auth] Authenticating — host:', host, '| email:', email, '| apiKey:', apiKey.slice(0,8)+'...');

  const options = {
    hostname: host,
    port    : 443,
    path    : '/api/v1/session',
    method  : 'POST',
    headers : {
      'X-CAP-API-KEY' : apiKey,
      'Content-Type'  : 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };

  capitalRequest(options, bodyStr, (err, status, headers, data) => {
    if (err) return cb(err);

    console.log('[auth] Status:', status, '| Body:', JSON.stringify(data).slice(0, 300));
    console.log('[auth] CST:', headers['cst'] || 'MISSING', '| Token:', (headers['x-security-token'] || 'MISSING').slice(0,20));

    if (status !== 200) {
      return cb(new Error('Capital.com rejected auth (' + status + '): ' + (data.errorCode || data.errorMessage || JSON.stringify(data))));
    }

    const session = {
      cst   : headers['cst']              || headers['CST']              || '',
      token : headers['x-security-token'] || headers['X-SECURITY-TOKEN'] || '',
      expiry: Date.now() + 8 * 60 * 1000,
      host,
    };
    sessions[apiKey] = session;
    console.log('[auth] Session OK');
    cb(null, session);
  });
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const parsed  = url.parse(req.url, true);
  const reqPath = parsed.pathname;

  if (reqPath === '/health') {
    return reply(res, 200, { status: 'ok', version: 'v2', sessions: Object.keys(sessions).length });
  }

  if (!reqPath.startsWith('/bridge/')) {
    return reply(res, 404, { error: 'Unknown route' });
  }

  let rawBody = '';
  req.on('data', c => rawBody += c);
  req.on('end', () => {
    let body = {};
    try { if (rawBody) body = JSON.parse(rawBody); } catch {}

    // Accept credentials from headers OR body
    const apiKey   = req.headers['x-cap-api-key']     || body.apiKey   || '';
    const email    = req.headers['x-bridge-email']    || body.email    || '';
    const password = req.headers['x-bridge-password'] || body.password || '';
    const env      = req.headers['x-bridge-env']      || body.env      || 'demo';

    if (!apiKey)    return reply(res, 400, { error: 'Missing API key' });
    if (!email)     return reply(res, 400, { error: 'Missing email' });
    if (!password)  return reply(res, 400, { error: 'Missing password' });

    // Clean internal fields before forwarding to Capital
    const fwdBody = Object.assign({}, body);
    delete fwdBody.apiKey; delete fwdBody.email;
    delete fwdBody.password; delete fwdBody.env;

    const capitalPath = '/api/v1/' + reqPath.replace('/bridge/', '') + (parsed.search || '');
    console.log('[proxy]', req.method, capitalPath);

    getSession(apiKey, email, password, env, (err, session) => {
      if (err) return reply(res, 401, { error: err.message });

      const hasBody = ['POST','PUT'].includes(req.method) && Object.keys(fwdBody).length > 0;
      const bodyStr = hasBody ? JSON.stringify(fwdBody) : null;

      const options = {
        hostname: session.host,
        port    : 443,
        path    : capitalPath,
        method  : req.method,
        headers : {
          'X-CAP-API-KEY'   : apiKey,
          'X-SECURITY-TOKEN': session.token,
          'CST'             : session.cst,
          'Content-Type'    : 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      capitalRequest(options, bodyStr, (err2, status, _h, data) => {
        if (err2) return reply(res, 502, { error: err2.message });
        if (status === 401) delete sessions[apiKey];
        console.log('[proxy] ←', status);
        reply(res, status, data);
      });
    });
  });
}).listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  NexusTrade Bridge Server v2          ║');
  console.log('║  http://localhost:' + PORT + '/health         ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log('Waiting for dashboard requests...\n');
});
