# MimiClaw × LM Studio — 本地 AI 代理 / Local AI Proxy

将 [MimiClaw](https://github.com/nicholasgasior/MimiClaw)（ESP32-S3）的聊天请求从 `api.openai.com` 重定向到**本地 LM Studio**，无需修改固件中硬编码的 API 地址。

Route [MimiClaw](https://github.com/nicholasgasior/MimiClaw) (ESP32-S3) chat requests away from `api.openai.com` to a **local LM Studio** instance, without modifying the firmware's hardcoded API endpoint.

> **测试环境 / Tested with**
> - ESP32-S3（8 MB PSRAM，16 MB Flash）
> - ESP-IDF v5.5.2
> - LM Studio 0.3.x，运行 `qwen/qwen3.5-9b`
> - Node.js 20+

---

## 整体架构 / Architecture

```
飞书消息 / Feishu message
      ↓
ESP32-S3（MimiClaw 固件 / firmware）
      ↓  HTTP CONNECT 隧道 / HTTPS CONNECT tunnel → proxy:7890
本地代理 Node.js（本仓库 / this repo）
      ↓  TLS 终止 + 请求改写 / TLS termination + request rewrite
LM Studio :1234
      ↓
本地模型（如 Qwen3.5-9B）/ Local model (e.g. Qwen3.5-9B)
      ↓
响应 → ESP32 → 飞书 / Response → ESP32 → Feishu
```

**中文说明：**  
固件通过串口配置的 HTTP 代理连接 `api.openai.com:443`。代理执行 TLS 中间人攻击（MITM）：用自签名证书终止 ESP32 的 TLS 连接，读取明文请求，替换 `model` 字段，再以普通 HTTP 转发到 LM Studio。

**English:**  
The firmware always connects to `api.openai.com:443` through the HTTP proxy configured via the serial console. The proxy performs a TLS man-in-the-middle: it terminates the TLS session (presenting a self-signed certificate), reads the plaintext request, replaces the `model` field, and forwards the rewritten request to LM Studio over plain HTTP.

---

## 仓库结构 / Repository Structure

```
├── proxy/
│   ├── mimiclaw-proxy.js          # 代理主文件 / Node.js proxy server
│   ├── gen-cert.sh                # 生成自签名证书（Linux/macOS）/ Generate cert (Linux/macOS)
│   ├── gen-cert.ps1               # 生成自签名证书（Windows）/ Generate cert (Windows)
│   └── start-proxy.bat            # Windows 一键启动 / One-click launch on Windows
│
├── firmware-patch/
│   ├── http_proxy.c               # 修改后的固件文件 / Modified ESP-IDF source (TLS cert skip)
│   ├── http_proxy.h               # 头文件（供参考）/ Header file (reference)
│   └── sdkconfig.defaults.esp32s3 # 必要的 sdkconfig 配置 / Required sdkconfig entries
│
└── README.md
```

---

## 快速开始 / Quick Start

### 1. 前置条件 / Prerequisites

| 工具 / Tool | 版本 / Version |
|-------------|---------------|
| Node.js | 18 或 20+ / 18 or 20+ |
| OpenSSL | 任意版本 / any（用于生成证书 / for cert generation）|
| ESP-IDF | v5.5.2 |
| LM Studio | 0.3+，已加载模型 / with a loaded model |

### 2. 生成 TLS 证书 / Generate TLS Certificate

代理用自签名 RSA 证书冒充 `api.openai.com`，固件侧已禁用证书验证（见[固件修改](#固件修改--firmware-changes)）。

The proxy impersonates `api.openai.com` using a self-signed RSA certificate. Certificate validation is disabled on the firmware side (see [Firmware Changes](#固件修改--firmware-changes)).

**Linux / macOS:**
```bash
cd proxy/
bash gen-cert.sh
```

**Windows（PowerShell）:**
```powershell
cd proxy\
.\gen-cert.ps1
```

会在 `proxy/` 目录生成 `proxy-key.pem` 和 `proxy-cert.pem`。  
This creates `proxy-key.pem` and `proxy-cert.pem` in the `proxy/` directory.

### 3. 配置代理 / Configure the Proxy

编辑 `proxy/mimiclaw-proxy.js` 顶部的常量：  
Edit the constants at the top of `proxy/mimiclaw-proxy.js`:

```js
const PROXY_PORT   = 7890;               // ESP32 连接的端口 / Port ESP32 connects to
const LM_HOST      = '127.0.0.1';       // LM Studio 地址 / LM Studio host
const LM_PORT      = 1234;               // LM Studio 端口 / LM Studio port
const TARGET_MODEL = 'qwen/qwen3.5-9b'; // LM Studio 中的模型名 / Model name in LM Studio
```

### 4. 启动 LM Studio / Start LM Studio

在 LM Studio 中加载模型，并在 1234 端口开启本地服务。  
Load your model in LM Studio and enable the local server at port 1234.

### 5. 启动代理 / Start the Proxy

```bash
node proxy/mimiclaw-proxy.js
```

Windows 用户也可以双击 `proxy/start-proxy.bat`。  
Or on Windows, double-click `proxy/start-proxy.bat`.

启动后控制台输出 / Expected output:
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

### 6. 配置 ESP32 代理 / Configure ESP32 Proxy

连接 ESP32 串口控制台，执行：  
Connect to the ESP32 serial console and run:

```
set_proxy 192.168.x.x 7890 http
```

将 `192.168.x.x` 替换为你的电脑局域网 IP。  
Replace `192.168.x.x` with your PC's LAN IP address.

### 7. 刷入修改后的固件 / Flash the Modified Firmware

应用固件补丁后刷入（见[固件修改](#固件修改--firmware-changes)）：  
Apply the firmware patch (see [Firmware Changes](#固件修改--firmware-changes)) and flash:

```bash
# 在 MimiClaw 项目根目录 / From your MimiClaw project root
idf.py -p COM9 flash   # 替换为你的串口 / replace COM9 with your port
```

---

## 固件修改 / Firmware Changes

MimiClaw 固件中有两处需要修改，修改后的文件位于 `firmware-patch/`。  
Two files in the MimiClaw firmware need to be changed. The patched versions are in `firmware-patch/`.

### `main/proxy/http_proxy.c`

**修改位置 / Location of change：** `proxy_conn_open()` 函数中的 `esp_tls_cfg_t` 结构体初始化。

**修改前 / Before:**
```c
esp_tls_cfg_t cfg = {
    .crt_bundle_attach = esp_crt_bundle_attach,
    .timeout_ms = timeout_ms,
};
```

**修改后 / After:**
```c
esp_tls_cfg_t cfg = {
    /*
     * 跳过自签名证书验证。需要在 sdkconfig 中同时开启：
     * Skip certificate verification for local proxy with self-signed cert.
     * Requires in sdkconfig:
     *   CONFIG_ESP_TLS_INSECURE=y
     *   CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y
     *
     * 注意：esp_tls_cfg_t 中没有 skip_server_cert_verify 字段，
     * 跳过验证完全由 sdkconfig 宏在编译时控制。
     * NOTE: There is NO skip_server_cert_verify field in esp_tls_cfg_t.
     * Skipping is driven purely by sdkconfig macros at compile time.
     */
    .crt_bundle_attach = NULL,
    .timeout_ms        = timeout_ms,
};
```

**原理 / Why：**  
当 `crt_bundle_attach` 为 `NULL` 且没有提供其他证书来源（`cacert_buf`、`use_global_ca_store`）时，ESP-IDF 的 `esp_tls_mbedtls.c` 进入 `else` 分支，调用 `mbedtls_ssl_conf_authmode(..., MBEDTLS_SSL_VERIFY_NONE)` —— **但前提是 `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` 在编译时已定义**。

When `crt_bundle_attach` is `NULL` and no other certificate source is provided (`cacert_buf`, `use_global_ca_store`), ESP-IDF's `esp_tls_mbedtls.c` enters the `else` branch and calls `mbedtls_ssl_conf_authmode(..., MBEDTLS_SSL_VERIFY_NONE)` — **but only if `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` is defined at compile time.**

### `sdkconfig.defaults.esp32s3`

在文件末尾添加以下两行（缺一不可）：  
Add the following two lines (both are required):

```
CONFIG_ESP_TLS_INSECURE=y
CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y
```

`CONFIG_ESP_TLS_INSECURE` 是父选项，没有它，`CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` 不会生效，固件编译时会报错：  
`CONFIG_ESP_TLS_INSECURE` is the parent option; without it, `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` has no effect and the firmware will print:

```
E esp-tls: No server verification option set in esp_tls_cfg_t structure.
```

---

## Windows 防火墙配置 / Windows Firewall

ESP32 必须能访问代理端口。Windows 下执行：  
The proxy must be reachable from the ESP32. On Windows:

```powershell
# 1. 开放 7890 端口入站 / Allow inbound TCP on port 7890
netsh advfirewall firewall add rule `
  name="MimiClaw Proxy 7890" dir=in action=allow protocol=TCP localport=7890

# 2. 将网络类型设为私有（Public 会阻止入站）
#    Set network profile to Private (Public blocks inbound by default)
Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private
# 如果网卡名不同，先用以下命令查询：
# If the adapter name differs, find it with:
# Get-NetConnectionProfile | Format-Table Name,InterfaceAlias,NetworkCategory
```

---

## 为何强制 TLS 1.2 / Why TLS 1.2 Is Forced

ESP32 的 mbedTLS 默认只编译了 TLS 1.2（TLS 1.3 需要额外 RAM 和可选组件）。Node.js 18+ 默认优先协商 TLS 1.3，导致 mbedTLS 报错并中止握手：

ESP32's mbedTLS is compiled with TLS 1.2 support only by default (TLS 1.3 requires extra RAM and optional components). Node.js 18+ negotiates TLS 1.3 by default, causing mbedTLS to abort with:

```
mbedtls_ssl_handshake returned -0x7280  (MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE)
```

代理中设置了以下选项，强制服务端只协商 1.2：  
The proxy sets:

```js
minVersion: 'TLSv1.2',
maxVersion: 'TLSv1.2',
```

---

## TLS 中间人工作原理 / How the TLS MITM Works

```
ESP32                    Proxy (Node.js)              LM Studio
  |                           |                           |
  |── CONNECT api.openai.com:443 ──>|                     |
  |<── 200 Connection Established ──|                     |
  |                           |                           |
  |── TLS ClientHello ───────>|  代理用自签名证书冒充     |
  |<── TLS ServerHello ───────|  proxy presents           |
  |── TLS Finished ──────────>|  self-signed cert         |
  |<── TLS Finished ──────────|                           |
  |   （TLS 隧道建立 / tunnel up）                        |
  |                           |                           |
  |── POST /v1/chat/completions（加密）─────>|            |
  |                    （解密，替换 model 字段）           |
  |                           |── POST /v1/chat/completions ──>|
  |                           |<── 200 { "choices": [...] } ───|
  |<── 200 { "choices": [...] }（重新加密）───────────────|
```

---

## 常见问题排查 / Troubleshooting

| 现象 / Symptom | 原因 / Cause | 解决 / Fix |
|----------------|-------------|-----------|
| `TCP connect to proxy … failed` | 防火墙阻止 7890 端口 / Firewall blocking port 7890 | 添加入站规则，网络设为 Private / Add inbound rule; set network to Private |
| `mbedtls_ssl_handshake -0x7280` | TLS 版本不匹配（1.3 vs 1.2）/ TLS version mismatch | 确认代理设置 `maxVersion: 'TLSv1.2'` / Ensure proxy forces `maxVersion: 'TLSv1.2'` |
| `No server verification option set` | sdkconfig 缺少父选项 / Missing INSECURE parent option | 添加 `CONFIG_ESP_TLS_INSECURE=y` |
| `esp-x509-crt-bundle: Failed to verify` | `crt_bundle_attach` 未设为 NULL / not NULL | 固件中设置 `.crt_bundle_attach = NULL` |
| `HTTP 401 Missing Authentication` | Auth header 未注入 / Auth header not injected | 使用本仓库代理（v4）/ Use this proxy (v4) |
| `LM Studio error: connection refused` | LM Studio 未运行或端口错误 / Not running or wrong port | 在 1234 端口启动 LM Studio 本地服务 / Start LM Studio local server on port 1234 |

---

## 遇到的坑 / Pitfalls We Hit

| 坑 / Pitfall | 现象 / Symptom | 原因 / Cause | 解法 / Fix |
|--------------|---------------|-------------|-----------|
| 代理 v1 | HTTP 401 | CONNECT 隧道内请求未被拦截 / Requests in CONNECT tunnel not intercepted | v2 做 TLS MITM |
| 固件编译失败 | `has no member 'skip_server_cert_verify'` | 该字段根本不存在，是编译宏 / It's a compile-time macro, not a struct field | 删掉字段，靠 sdkconfig |
| TLS 握手 -0x7280 | `FATAL_ALERT_MESSAGE` | Node.js 默认 TLS 1.3，ESP32 不支持 / Node.js defaults to TLS 1.3 | 强制 `maxVersion: 'TLSv1.2'` |
| 连不上代理 | `TCP connect failed` | Windows 防火墙网络类型为 Public / Windows firewall network type is Public | 改为 Private + 开入站规则 |
| 证书验证失败 | `Failed to verify certificate` | `crt_bundle_attach` 非 NULL 或 sdkconfig 缺父选项 | 两个 CONFIG 都开，代码设 NULL |

---

## License

MIT
