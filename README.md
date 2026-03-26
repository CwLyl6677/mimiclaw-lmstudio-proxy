# MimiClaw × LM Studio — Local AI Proxy

Route [MimiClaw](https://github.com/nicholasgasior/MimiClaw) (ESP32-S3) chat requests away from `api.openai.com` to a **local LM Studio** instance, without modifying the firmware's hardcoded API endpoint.

> **Tested with**
> - ESP32-S3 (8 MB PSRAM, 16 MB Flash)
> - ESP-IDF v5.5.2
> - LM Studio 0.3.x running `qwen/qwen3.5-9b`
> - Node.js 20+

---

## Architecture

```
Feishu message
      ↓
ESP32-S3 (MimiClaw firmware)
      ↓  HTTPS CONNECT tunnel → proxy:7890
Local proxy (Node.js, this repo)
      ↓  TLS termination + request rewrite
LM Studio :1234
      ↓
Local model (e.g. Qwen3.5-9B)
      ↓
Response → ESP32 → Feishu
```

The firmware always connects to `api.openai.com:443` through the HTTP proxy configured via the serial console. The proxy performs a TLS man-in-the-middle: it terminates the TLS session (presenting a self-signed certificate), reads the plaintext request, replaces the `model` field, and forwards the rewritten request to LM Studio over plain HTTP.

---

## Files in This Repository

```
├── proxy/
│   ├── mimiclaw-proxy.js       # Node.js proxy server (main file)
│   ├── gen-cert.sh             # Generate self-signed cert (Linux/macOS)
│   ├── gen-cert.ps1            # Generate self-signed cert (Windows)
│   └── start-proxy.bat         # One-click launch on Windows
│
├── firmware-patch/
│   ├── http_proxy.c            # Modified ESP-IDF source (TLS cert skip)
│   ├── http_proxy.h            # Unchanged header (included for reference)
│   └── sdkconfig.defaults.esp32s3  # Required sdkconfig entries
│
└── README.md
```

---

## Quick Start

### 1. Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 or 20+ |
| OpenSSL | any (for cert generation) |
| ESP-IDF | v5.5.2 |
| LM Studio | 0.3+ with a loaded model |

### 2. Generate TLS Certificate

The proxy impersonates `api.openai.com` using a self-signed RSA certificate. Certificate validation is disabled on the firmware side (see [Firmware Changes](#firmware-changes)).

**Linux / macOS:**
```bash
cd proxy/
bash gen-cert.sh
```

**Windows (PowerShell):**
```powershell
cd proxy\
.\gen-cert.ps1
```

This creates `proxy-key.pem` and `proxy-cert.pem` in the `proxy/` directory.

### 3. Configure the Proxy

Edit the constants at the top of `proxy/mimiclaw-proxy.js`:

```js
const PROXY_PORT   = 7890;             // Port ESP32 connects to
const LM_HOST      = '127.0.0.1';     // LM Studio host
const LM_PORT      = 1234;             // LM Studio port
const TARGET_MODEL = 'qwen/qwen3.5-9b'; // Model name as shown in LM Studio
```

### 4. Start LM Studio

Load your model in LM Studio and enable the local server at port 1234.

### 5. Start the Proxy

```bash
node proxy/mimiclaw-proxy.js
```

Or on Windows, double-click `proxy/start-proxy.bat`.

Expected output:
```
╔════════════════════════════════════════════════════════╗
║   MimiClaw → LM Studio Proxy v4  (TLS 1.2 forced)     ║
╠════════════════════════════════════════════════════════╣
║  Listen port : 7890                                    ║
║  LM Studio   : 127.0.0.1:1234                         ║
║  Target model: qwen/qwen3.5-9b                         ║
╠════════════════════════════════════════════════════════╣
║  Set proxy on ESP32 (serial console):                  ║
║    set_proxy <YOUR_PC_IP> 7890 http                    ║
╚════════════════════════════════════════════════════════╝
```

### 6. Configure ESP32 Proxy

Connect to the ESP32 serial console and run:

```
set_proxy 192.168.x.x 7890 http
```

Replace `192.168.x.x` with your PC's LAN IP address.

### 7. Flash the Modified Firmware

Apply the firmware patch (see [Firmware Changes](#firmware-changes)) and flash:

```bash
# From your MimiClaw project root
idf.py -p COM9 flash   # replace COM9 with your port
```

---

## Firmware Changes

Two files in the MimiClaw firmware need to be changed. The patched versions are in `firmware-patch/`.

### `main/proxy/http_proxy.c`

**Location of change:** `proxy_conn_open()` function, the `esp_tls_cfg_t` struct initializer.

**Before:**
```c
esp_tls_cfg_t cfg = {
    .crt_bundle_attach = esp_crt_bundle_attach,
    .timeout_ms = timeout_ms,
};
```

**After:**
```c
esp_tls_cfg_t cfg = {
    /*
     * Skip certificate verification for local proxy with self-signed cert.
     * Requires CONFIG_ESP_TLS_INSECURE=y and
     *         CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y in sdkconfig.
     *
     * NOTE: There is NO skip_server_cert_verify field in esp_tls_cfg_t.
     * Skipping is driven purely by sdkconfig macros at compile time.
     */
    .crt_bundle_attach = NULL,
    .timeout_ms        = timeout_ms,
};
```

**Why:** When `crt_bundle_attach` is `NULL` and no other certificate source is provided (`cacert_buf`, `use_global_ca_store`), ESP-IDF's `esp_tls_mbedtls.c` enters the `else` branch and calls `mbedtls_ssl_conf_authmode(..., MBEDTLS_SSL_VERIFY_NONE)` — **but only if `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` is defined at compile time.**

### `sdkconfig.defaults.esp32s3`

Add the following two lines (both are required):

```
CONFIG_ESP_TLS_INSECURE=y
CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y
```

`CONFIG_ESP_TLS_INSECURE` is the parent option; without it, `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` has no effect and the firmware will refuse to compile the `VERIFY_NONE` path, printing:

```
E esp-tls: No server verification option set in esp_tls_cfg_t structure.
```

---

## Windows Firewall

The proxy must be reachable from the ESP32. On Windows:

```powershell
# 1. Allow inbound TCP on port 7890
netsh advfirewall firewall add rule `
  name="MimiClaw Proxy 7890" dir=in action=allow protocol=TCP localport=7890

# 2. Ensure network profile is Private (Public blocks inbound by default)
Set-NetConnectionProfile -InterfaceAlias "Ethernet" -NetworkCategory Private
```

---

## Why TLS 1.2 Is Forced

ESP32's mbedTLS is compiled with TLS 1.2 support only by default (TLS 1.3 requires extra RAM and optional components). Node.js 18+ negotiates TLS 1.3 by default, causing mbedTLS to abort with:

```
mbedtls_ssl_handshake returned -0x7280  (MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE)
```

The proxy sets:

```js
minVersion: 'TLSv1.2',
maxVersion: 'TLSv1.2',
```

This forces the TLS server to negotiate 1.2, which mbedTLS accepts.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `TCP connect to proxy … failed` | Firewall blocking port 7890 | Add inbound rule; set network to Private |
| `mbedtls_ssl_handshake -0x7280` | TLS version mismatch (1.3 vs 1.2) | Ensure proxy forces `maxVersion: 'TLSv1.2'` |
| `No server verification option set` | sdkconfig missing INSECURE parent option | Add `CONFIG_ESP_TLS_INSECURE=y` |
| `esp-x509-crt-bundle: Failed to verify` | `crt_bundle_attach` not set to NULL | Set `.crt_bundle_attach = NULL` in firmware |
| `HTTP 401 Missing Authentication` | Auth header not injected | Use this proxy (v4); older versions missed this |
| `LM Studio error: connection refused` | LM Studio not running or wrong port | Start LM Studio local server on port 1234 |

---

## How the TLS MITM Works

```
ESP32                    Proxy (Node.js)              LM Studio
  |                           |                           |
  |── CONNECT api.openai.com:443 ──>|                    |
  |<── 200 Connection Established ──|                    |
  |                           |                           |
  |──── TLS ClientHello ─────>|  (proxy presents         |
  |<─── TLS ServerHello ──────|   self-signed cert)       |
  |──── TLS Finished ────────>|                           |
  |<─── TLS Finished ─────────|                           |
  |    (TLS tunnel up)        |                           |
  |                           |                           |
  |── POST /v1/chat/completions (encrypted) ──>|          |
  |                    (decrypted, patch model)|           |
  |                           |── POST /v1/chat/completions ──>|
  |                           |<── 200 { "choices": [...] } ───|
  |<── 200 { "choices": [...] } (re-encrypted) ──────────|
```

---

## License

MIT
