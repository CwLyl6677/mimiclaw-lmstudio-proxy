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
 *   - Auto-generates self-signed cert on first run (no OpenSSL needed)
 *     自动在首次运行时生成自签名证书，无需安装 OpenSSL
 *
 * Usage: node mimiclaw-proxy.js
 */

const http   = require('http');
const tls    = require('tls');
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── Configuration ─────────────────────────────────────────────────────────────
const PROXY_PORT   = 7890;               // Port ESP32 connects to
const LM_HOST      = '127.0.0.1';       // LM Studio host
const LM_PORT      = 1234;              // LM Studio port
const TARGET_MODEL = 'qwen/qwen3.5-9b'; // Local model name (change as needed)
const CERT_DIR     = __dirname;          // Directory for proxy-key.pem / proxy-cert.pem




// ── Auto-generate self-signed certificate if not present ─────────────────────
// 首次运行时自动生成证书，无需手动执行 gen-cert / OpenSSL
// Cert is generated using Node.js built-in crypto — no OpenSSL required.
const KEY_FILE  = path.join(CERT_DIR, 'proxy-key.pem');
const CERT_FILE = path.join(CERT_DIR, 'proxy-cert.pem');

function generateSelfSignedCert() {
  console.log('[cert] 首次运行，正在自动生成自签名证书... / First run, generating self-signed cert...');

  // Generate RSA-2048 key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Build a minimal self-signed X.509 v3 certificate using ASN.1 DER
  function encLen(n) {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  }
  function tlv(tag, val) {
    const v = Buffer.isBuffer(val) ? val : Buffer.from(val);
    return Buffer.concat([Buffer.from([tag]), encLen(v.length), v]);
  }
  const seq  = v => tlv(0x30, v);
  const set_ = v => tlv(0x31, v);
  const ctx0 = v => tlv(0xa0, v);
  const ctx3 = v => tlv(0xa3, v);

  function oidBuf(dotted) {
    const p = dotted.split('.').map(Number);
    const out = [40 * p[0] + p[1]];
    for (let i = 2; i < p.length; i++) {
      let v = p[i]; const b = [];
      b.unshift(v & 0x7f); v >>= 7;
      while (v) { b.unshift((v & 0x7f) | 0x80); v >>= 7; }
      out.push(...b);
    }
    return tlv(0x06, Buffer.from(out));
  }

  function pStr(s) { return tlv(0x13, Buffer.from(s, 'ascii')); }
  function utcTime(d) {
    const p = n => String(n).padStart(2, '0');
    const s = String(d.getUTCFullYear()).slice(-2)
      + p(d.getUTCMonth()+1) + p(d.getUTCDate())
      + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
    return tlv(0x17, Buffer.from(s, 'ascii'));
  }
  function rdnSeq(oidS, val) {
    return set_(seq(Buffer.concat([oidBuf(oidS), pStr(val)])));
  }
  function name(cn, o, c) {
    return seq(Buffer.concat([rdnSeq('2.5.4.6', c), rdnSeq('2.5.4.10', o), rdnSeq('2.5.4.3', cn)]));
  }

  // Serial number (random 16 bytes, ensure positive)
  let serial = crypto.randomBytes(16);
  if (serial[0] & 0x80) serial = Buffer.concat([Buffer.from([0x00]), serial]);
  const serialTlv = tlv(0x02, serial);

  // Validity
  const notBefore = new Date();
  const notAfter  = new Date(notBefore); notAfter.setFullYear(notAfter.getFullYear() + 10);

  // SHA-256 with RSA OID
  const sigAlg = seq(Buffer.concat([oidBuf('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0))]));

  // Subject / Issuer
  const subject = name('api.openai.com', 'MimiClaw Proxy', 'CN');

  // SubjectPublicKeyInfo from publicKey PEM (SPKI format)
  const spkiDer = crypto.createPublicKey({ key: publicKey, format: 'pem' }).export({ type: 'spki', format: 'der' });

  // Extensions: subjectAltName dNSName=api.openai.com
  const sanOid  = oidBuf('2.5.29.17');
  const sanVal  = tlv(0x04, seq(tlv(0x82, Buffer.from('api.openai.com', 'ascii'))));
  const extSeq  = ctx3(seq(seq(Buffer.concat([sanOid, sanVal]))));

  // TBSCertificate
  const tbs = seq(Buffer.concat([
    ctx0(tlv(0x02, Buffer.from([0x02]))),           // version v3
    serialTlv,                                       // serial
    sigAlg,                                          // signatureAlgorithm
    subject,                                         // issuer (self-signed)
    seq(Buffer.concat([utcTime(notBefore), utcTime(notAfter)])), // validity
    subject,                                         // subject
    Buffer.from(spkiDer),                            // subjectPublicKeyInfo
    extSeq,                                          // extensions
  ]));

  // Sign TBS
  const sig = crypto.createSign('sha256').update(tbs).sign(
    crypto.createPrivateKey({ key: privateKey, format: 'pem' })
  );
  // BIT STRING: 0x00 + signature bytes
  const bitStr = tlv(0x03, Buffer.concat([Buffer.from([0x00]), sig]));

  // Final certificate DER
  const certDer = seq(Buffer.concat([tbs, sigAlg, bitStr]));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;

  fs.writeFileSync(KEY_FILE,  privateKey);
  fs.writeFileSync(CERT_FILE, certPem);
  console.log('[cert] ✓ proxy-key.pem + proxy-cert.pem 已生成 / generated');
}

// Load or generate certificate
if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CERT_FILE)) {
  generateSelfSignedCert();
}

// ── TLS options: force TLS 1.2 for ESP32 mbedTLS compatibility ───────────────
// ESP32 mbedTLS defaults to TLS 1.2 only. Node.js 18+ defaults to TLS 1.3,
// which causes mbedtls_ssl_handshake to return -0x7280 (FATAL_ALERT_MESSAGE).
const tlsOptions = {
  key:  fs.readFileSync(KEY_FILE),
  cert: fs.readFileSync(CERT_FILE),
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
  ].join(':'),
  sessionTimeout: 0,
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
          'Connection: close',
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
