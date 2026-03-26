/**
 * MimiClaw → LM Studio Forwarding Proxy v4
 *
 * Intercepts HTTPS traffic from ESP32 (MimiClaw firmware) destined for
 * api.openai.com, performs TLS MITM termination, rewrites the request
 * to target a local LM Studio instance instead.
 *
 * Key design decisions:
 *   - Forces TLS 1.2 (ESP32 mbedTLS does not support TLS 1.3)
 *   - Uses mbedTLS-compatible cipher suites
 *   - Replaces model name in request body with local model
 *   - Forwards to LM Studio via plain HTTP (127.0.0.1:1234)
 *
 * Usage: node mimiclaw-proxy.js
 */

const http  = require('http');
const https = require('https');
const tls   = require('tls');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Configuration ─────────────────────────────────────────────────────────────
const PROXY_PORT   = 7890;           // Port ESP32 connects to
const LM_HOST      = '127.0.0.1';   // LM Studio host
const LM_PORT      = 1234;           // LM Studio port
const TARGET_MODEL = 'qwen/qwen3.5-9b'; // Local model name (change as needed)
const CERT_DIR     = __dirname;      // Directory containing proxy-key.pem / proxy-cert.pem

// ── TLS options: force TLS 1.2 for ESP32 mbedTLS compatibility ───────────────
// ESP32 mbedTLS defaults to TLS 1.2 only. Node.js 18+ defaults to TLS 1.3,
// which causes mbedtls_ssl_handshake to return -0x7280 (FATAL_ALERT_MESSAGE).
const tlsOptions = {
  key:  fs.readFileSync(path.join(CERT_DIR, 'proxy-key.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'proxy-cert.pem')),
  rejectUnauthorized: false,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  // Cipher suites supported by ESP-IDF mbedTLS default configuration
  ciphers: [
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-SHA256',
    'ECDHE-RSA-AES256-SHA384',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'AES128-SHA256',
    'AES256-SHA256',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-RSA-AES256-SHA',
    'AES128-SHA',
    'AES256-SHA',
    'RSA-PSK-AES128-CBC-SHA256',
    'RSA-PSK-AES256-CBC-SHA384',
  ].join(':'),
  sessionTimeout: 0, // Disable session tickets for mbedTLS compatibility
};

// Hostnames to intercept (add more as needed)
function shouldForward(hostname) {
  return hostname === 'api.openai.com' || hostname === 'api.anthropic.com';
}

// Rewrite request body: replace model name, strip Anthropic-specific fields
function patchBody(bodyStr, isAnthropic) {
  try {
    const body = JSON.parse(bodyStr);
    body.model = TARGET_MODEL;
    if (isAnthropic) {
      // Convert Anthropic format to OpenAI-compatible format
      if (body.system && !body.messages.find(m => m.role === 'system')) {
        body.messages.unshift({ role: 'system', content: body.system });
        delete body.system;
      }
      delete body.anthropic_version;
    }
    return JSON.stringify(body);
  } catch (e) { return bodyStr; }
}

// Forward patched request to LM Studio
function forwardToLM(bodyBuf, isAnthropic, onResponse) {
  const patched = Buffer.from(patchBody(bodyBuf.toString('utf8'), isAnthropic), 'utf8');
  const req = http.request({
    hostname: LM_HOST,
    port: LM_PORT,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': patched.length,
      'Authorization': 'Bearer lm-studio',
    },
  }, onResponse);
  req.on('error', err => {
    console.error('[LM Studio error]', err.message);
    onResponse(null, err);
  });
  req.write(patched);
  req.end();
}

// Handle decrypted HTTP stream from TLS-terminated socket
function handleDecryptedSocket(socket, hostname, isAnthropic, headData) {
  let buffer = headData && headData.length > 0 ? Buffer.from(headData) : Buffer.alloc(0);

  function tryParse() {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headerStr = buffer.slice(0, headerEnd).toString('utf8');
    let contentLength = 0;
    for (const line of headerStr.split('\r\n').slice(1)) {
      if (line.toLowerCase().startsWith('content-length:')) {
        contentLength = parseInt(line.split(':')[1].trim()) || 0;
      }
    }

    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) return;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    const firstLine = headerStr.split('\r\n')[0];
    console.log(`[intercept] ${firstLine}`);
    console.log(`[forward]   ${hostname} → LM Studio :${LM_PORT} (${body.length} bytes)`);

    forwardToLM(body, isAnthropic, (proxyRes, err) => {
      if (err) {
        const errBody = JSON.stringify({ error: { message: err.message, code: 502 } });
        const resp = `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errBody)}\r\n\r\n${errBody}`;
        try { socket.write(resp); } catch (_) {}
        return;
      }

      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const respBody = Buffer.concat(chunks);
        const respHeader = [
          `HTTP/1.1 ${proxyRes.statusCode} OK`,
          'Content-Type: application/json',
          `Content-Length: ${respBody.length}`,
          'Connection: keep-alive',
          '', '',
        ].join('\r\n');
        try {
          socket.write(respHeader);
          socket.write(respBody);
          console.log(`[response]  ${proxyRes.statusCode} → ESP32 (${respBody.length} bytes)`);
        } catch (_) {}

        if (buffer.length > 0) tryParse();
      });
    });
  }

  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    tryParse();
  });
  socket.on('error', err => {
    if (err.code !== 'ECONNRESET') console.error('[socket error]', err.message);
  });

  if (buffer.length > 0) tryParse();
}

// ── Plain HTTP proxy (fallback for non-CONNECT requests) ─────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const hostname = (req.headers.host || parsed.hostname || '').split(':')[0];

  if (shouldForward(hostname)) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const isAnthropic = hostname === 'api.anthropic.com';
      forwardToLM(Buffer.concat(chunks), isAnthropic, (proxyRes, err) => {
        if (err) { res.writeHead(502); res.end(JSON.stringify({ error: { message: err.message } })); return; }
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        proxyRes.pipe(res, { end: true });
      });
    });
  } else {
    const opts = { hostname: parsed.hostname, port: parsed.port || 80, path: parsed.path, method: req.method, headers: req.headers };
    const pr = http.request(opts, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res, { end: true }); });
    pr.on('error', e => { res.writeHead(502); res.end(e.message); });
    req.pipe(pr, { end: true });
  }
});

// ── HTTPS CONNECT handler: TLS MITM termination ──────────────────────────────
server.on('connect', (req, clientSocket, head) => {
  const [hostname, portStr] = req.url.split(':');

  if (!shouldForward(hostname)) {
    // Pass through for non-target hosts
    const port = parseInt(portStr) || 443;
    console.log(`[passthrough] CONNECT ${hostname}:${port}`);
    const remote = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      remote.write(head);
      remote.pipe(clientSocket);
      clientSocket.pipe(remote);
    });
    remote.on('error', () => clientSocket.end());
    return;
  }

  const isAnthropic = hostname === 'api.anthropic.com';
  console.log(`[CONNECT] target: ${hostname} → starting TLS termination`);

  // Acknowledge the CONNECT tunnel
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Wait one tick to ensure the 200 response has been flushed before TLS handshake
  setImmediate(() => {
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      ...tlsOptions,
      isServer: true,
    });

    tlsSocket.on('secure', () => {
      const cipher = tlsSocket.getCipher();
      console.log(`[TLS ✓] handshake OK: ${hostname} | ${cipher.name} | TLSv${cipher.version}`);
      handleDecryptedSocket(tlsSocket, hostname, isAnthropic, head);
    });

    tlsSocket.on('error', err => {
      console.error(`[TLS ✗] handshake failed: ${hostname}: ${err.message}`);
      console.error('        Check: CONFIG_ESP_TLS_INSECURE=y and CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y in sdkconfig');
      if (head && head.length > 0) {
        handleDecryptedSocket(clientSocket, hostname, isAnthropic, head);
      } else {
        clientSocket.destroy();
      }
    });

    clientSocket.on('close', () => tlsSocket.destroy());
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   MimiClaw → LM Studio Proxy v4  (TLS 1.2 forced)     ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Listen port : ${PROXY_PORT}                                      ║`);
  console.log(`║  LM Studio   : ${LM_HOST}:${LM_PORT}                             ║`);
  console.log(`║  Target model: ${TARGET_MODEL.padEnd(42)}║`);
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Set proxy on ESP32 (serial console):                  ║');
  console.log('║    set_proxy <YOUR_PC_IP> 7890 http                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PROXY_PORT} already in use. Kill existing node process first.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
