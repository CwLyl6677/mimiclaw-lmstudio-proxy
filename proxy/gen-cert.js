/**
 * gen-cert.js — 用 Node.js 内置 crypto 生成自签名 RSA 证书
 * Generate self-signed RSA certificate using Node.js built-in crypto
 *
 * 无需安装 OpenSSL，Node.js 15+ 即可运行。
 * No OpenSSL installation needed. Requires Node.js 15+.
 *
 * 用法 / Usage:
 *   node gen-cert.js
 *
 * 输出 / Output:
 *   proxy-key.pem   — RSA 2048 私钥 / private key
 *   proxy-cert.pem  — 自签名证书（10年有效期）/ self-signed cert (10 years)
 */

const { generateKeyPairSync, X509Certificate } = require('crypto');
const fs   = require('fs');
const path = require('path');

// ── Node.js 版本检查 ───────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 15) {
  console.error(`❌ 需要 Node.js 15+，当前版本 ${process.version}`);
  console.error(`   Requires Node.js 15+, current version: ${process.version}`);
  process.exit(1);
}

// Node.js 17+ 才有 X509Certificate 的 self-sign 能力，用 forge 风格的方案兜底
// 检测是否有内置 generateCertificate（Node 22+）或用 tls.createSecureContext 方式
// 实际上最兼容的方式是用 @peculiar/x509 或 selfsigned 包
// 但我们要零依赖，所以用 Node 15+ 的 crypto.generateKeyPairSync + 手写 DER

// ── 方案：调用系统 Node.js 的 tls 自签名能力 ─────────────────────────────────
// Node.js 22+ 有 crypto.X509Certificate，但没有直接 sign 的 API
// 最干净的零依赖方案：用 crypto 生成密钥对，然后手写 ASN.1 DER 结构

const OUT_DIR = __dirname;
const KEY_FILE  = path.join(OUT_DIR, 'proxy-key.pem');
const CERT_FILE = path.join(OUT_DIR, 'proxy-cert.pem');

console.log('╔══════════════════════════════════════════════╗');
console.log('║  MimiClaw Proxy — 证书生成 / Cert Generator  ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');
console.log('[1/2] 生成 RSA 2048 密钥对 / Generating RSA 2048 key pair...');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

fs.writeFileSync(KEY_FILE, privateKey);
console.log(`    ✓ 私钥已保存 / Private key saved: ${KEY_FILE}`);

console.log('[2/2] 生成自签名证书 / Generating self-signed certificate...');

// ── 手写 ASN.1 DER 编码的 X.509 v3 证书 ──────────────────────────────────────
// 参考 RFC 5280

const { createSign, createPrivateKey } = require('crypto');

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function tlv(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(v.length), v]);
}

function seq(value)  { return tlv(0x30, value); }
function set_(value) { return tlv(0x31, value); }
function ctx(n, v)   { return tlv(0xa0 + n, v); }

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const encoded = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const bytes = [];
    bytes.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) { bytes.unshift((v & 0x7f) | 0x80); v >>= 7; }
    encoded.push(...bytes);
  }
  return tlv(0x06, Buffer.from(encoded));
}

function utf8Str(s)    { return tlv(0x0c, Buffer.from(s, 'utf8')); }
function ia5Str(s)     { return tlv(0x16, Buffer.from(s, 'ascii')); }
function printStr(s)   { return tlv(0x13, Buffer.from(s, 'ascii')); }
function bitStr(bytes) { return tlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes])); }
function intBuf(buf)   { return tlv(0x02, buf); }

function encodeInt(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return intBuf(buf);
}

function encodeTime(date) {
  // UTCTime: YYMMDDHHMMSSZ
  const pad = n => String(n).padStart(2, '0');
  const d = date;
  const yy = String(d.getUTCFullYear()).slice(-2);
  const s = yy + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) +
            pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// RDN helper
function rdn(oidDotted, value) {
  return set_(seq(Buffer.concat([oid(oidDotted), printStr(value)])));
}

function buildName(cn, o, c) {
  return seq(Buffer.concat([
    rdn('2.5.4.6',  c),   // countryName
    rdn('2.5.4.10', o),   // organizationName
    rdn('2.5.4.3',  cn),  // commonName
  ]));
}

// ── 从 PEM 中提取公钥的 SubjectPublicKeyInfo DER ──
// publicKey PEM (pkcs1) → 需要包装成 SPKI
const pubKeyObj = require('crypto').createPublicKey({ key: publicKey, format: 'pem' });
const spkiDer   = pubKeyObj.export({ type: 'spki', format: 'der' });

// ── 构造 TBSCertificate ────────────────────────────────────────────────────────
const notBefore = new Date();
const notAfter  = new Date(notBefore);
notAfter.setFullYear(notAfter.getFullYear() + 10);

const serialHex = require('crypto').randomBytes(16).toString('hex');
let serialBuf = Buffer.from(serialHex, 'hex');
if (serialBuf[0] & 0x80) serialBuf = Buffer.concat([Buffer.from([0x00]), serialBuf]);

const subject = buildName('api.openai.com', 'MimiClaw Proxy', 'CN');

// sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
const sigAlgDer = seq(Buffer.concat([
  oid('1.2.840.113549.1.1.11'),
  tlv(0x05, Buffer.alloc(0)), // NULL
]));

// Extensions: subjectAltName
const sanExt = seq(Buffer.concat([
  oid('2.5.29.17'),           // subjectAltName
  tlv(0x04,                   // OCTET STRING wrapping SEQUENCE
    seq(tlv(0x82, Buffer.from('api.openai.com', 'ascii'))) // dNSName [2]
  ),
]));
const extensions = ctx(3, seq(seq(sanExt)));

const tbsCert = seq(Buffer.concat([
  ctx(0, encodeInt(2)),          // version: v3 (2)
  intBuf(serialBuf),             // serialNumber
  sigAlgDer,                     // signature algorithm
  subject,                       // issuer (self-signed → same as subject)
  seq(Buffer.concat([encodeTime(notBefore), encodeTime(notAfter)])), // validity
  subject,                       // subject
  Buffer.from(spkiDer),          // subjectPublicKeyInfo
  extensions,                    // extensions
]));

// ── 签名 ──────────────────────────────────────────────────────────────────────
const signer = createSign('sha256');
signer.update(tbsCert);
const sigBytes = signer.sign(createPrivateKey({ key: privateKey, format: 'pem' }));

// ── 组合最终证书 ──────────────────────────────────────────────────────────────
const certDer = seq(Buffer.concat([tbsCert, sigAlgDer, bitStr(sigBytes)]));

// ── 转 PEM ────────────────────────────────────────────────────────────────────
const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;

fs.writeFileSync(CERT_FILE, certPem);
console.log(`    ✓ 证书已保存 / Certificate saved: ${CERT_FILE}`);

console.log('');
console.log('✅ 完成！/ Done!');
console.log(`   proxy-key.pem  → ${KEY_FILE}`);
console.log(`   proxy-cert.pem → ${CERT_FILE}`);
console.log('');
console.log('有效期 / Valid for: 10 years');
console.log('CN: api.openai.com');
