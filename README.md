# MimiClaw × LM Studio — 本地 AI 代理

---

<details open>
<summary><strong>🇨🇳 中文文档</strong></summary>

## 简介

将 [MimiClaw](https://github.com/nicholasgasior/MimiClaw)（ESP32-S3）的聊天请求从 `api.openai.com` 重定向到**本地 LM Studio**，无需修改固件中硬编码的 API 地址。

> **测试环境**
> - ESP32-S3（8 MB PSRAM，16 MB Flash）
> - ESP-IDF v5.5.2
> - LM Studio 0.3.x，运行 `qwen/qwen3.5-9b`
> - Node.js 18+

---

## 整体架构

```
飞书消息
      ↓
ESP32-S3（MimiClaw 固件）
      ↓  HTTP CONNECT 隧道 → 代理:7890
本地代理（Node.js，本仓库）
      ↓  TLS 终止 + 请求改写
LM Studio :1234
      ↓
本地模型（如 Qwen3.5-9B）
      ↓
响应 → ESP32 → 飞书
```

固件通过串口配置的 HTTP 代理连接 `api.openai.com:443`。代理执行 TLS 中间人（MITM）：用自签名证书终止 ESP32 的 TLS 连接，读取明文请求，替换 `model` 字段，再以普通 HTTP 转发给本地 LM Studio。

---

## 仓库结构

```
├── proxy/
│   ├── mimiclaw-proxy.js           # 代理主文件（含自动证书生成）
│   ├── gen-cert.js                 # 独立证书生成工具（备用）
│   ├── gen-cert.sh                 # 若有 OpenSSL，Linux/macOS 备用
│   ├── gen-cert.ps1                # 若有 OpenSSL，Windows 备用
│   └── start-proxy.bat             # Windows 一键启动
│
├── firmware-patch/
│   ├── http_proxy.c                # 修改后的固件文件（跳过 TLS 证书验证）
│   ├── http_proxy.h                # 头文件（供参考）
│   └── sdkconfig.defaults.esp32s3 # 必要的 sdkconfig 配置项
│
└── README.md
```

---

## 前置条件

| 工具 | 版本要求 |
|------|---------|
| Node.js | 18+ |
| ESP-IDF | v5.5.2 |
| LM Studio | 0.3+，已加载模型并开启本地服务器 |

> **无需安装 OpenSSL。** 代理首次启动时会自动用 Node.js 内置模块生成自签名证书。

---

## 使用步骤

### 第一步：修改并编译固件

> 此步骤需要修改 MimiClaw 固件源码，让 ESP32 跳过对代理自签名证书的验证，并重新编译刷入。

**1.1 修改 `main/proxy/http_proxy.c`**

找到 `proxy_conn_open()` 函数中的 `esp_tls_cfg_t` 初始化，将：

```c
esp_tls_cfg_t cfg = {
    .crt_bundle_attach = esp_crt_bundle_attach,
    .timeout_ms = timeout_ms,
};
```

改为：

```c
esp_tls_cfg_t cfg = {
    .crt_bundle_attach = NULL,   // 跳过证书验证，见下方说明
    .timeout_ms        = timeout_ms,
};
```

> **说明：** `esp_tls_cfg_t` 中没有 `skip_server_cert_verify` 字段（这是常见误区）。跳过验证是通过编译时宏控制的，只要 `crt_bundle_attach = NULL` 且 sdkconfig 中开启了对应选项，ESP-IDF 会自动使用 `MBEDTLS_SSL_VERIFY_NONE`。

**1.2 修改 `sdkconfig.defaults.esp32s3`**

在文件末尾添加以下两行（两行都必须有，缺一不可）：

```
CONFIG_ESP_TLS_INSECURE=y
CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y
```

> `CONFIG_ESP_TLS_INSECURE` 是父选项，没有它，`CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` 不会生效。缺少时编译后固件会报错：
> ```
> E esp-tls: No server verification option set in esp_tls_cfg_t structure.
> ```

**1.3 编译固件**

```bash
# 在 MimiClaw 项目根目录
idf.py set-target esp32s3
idf.py build
```

**1.4 刷入固件**

```bash
idf.py -p COM9 flash   # 将 COM9 替换为实际串口号
```

---

### 第二步：配置 Windows 防火墙

ESP32 需要通过局域网连接到代理。Windows 默认会阻止入站连接，需要手动开放。

以**管理员身份**打开 PowerShell，依次执行：

```powershell
# 1. 开放 7890 端口入站
netsh advfirewall firewall add rule name="MimiClaw Proxy 7890" dir=in action=allow protocol=TCP localport=7890

# 2. 将网络连接类型改为私有（Public 模式会阻止所有入站）
Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private
```

> 如果网卡名称不是"以太网"，先用以下命令查询正确名称：
> ```powershell
> Get-NetConnectionProfile | Format-Table InterfaceAlias, NetworkCategory
> ```

---

### 第三步：配置代理参数

编辑 `proxy/mimiclaw-proxy.js` 顶部的配置项：

```js
const PROXY_PORT   = 7890;               // ESP32 连接的端口（与第四步对应）
const LM_HOST      = '127.0.0.1';       // LM Studio 所在地址
const LM_PORT      = 1234;              // LM Studio 本地服务端口
const TARGET_MODEL = 'qwen/qwen3.5-9b'; // 模型名称（与 LM Studio 中一致）
```

---

### 第四步：启动 LM Studio

1. 打开 LM Studio
2. 加载目标模型（如 Qwen3.5-9B）
3. 点击左侧「Local Server」，启动本地服务器，端口保持默认 1234

---

### 第五步：启动代理

```bash
node proxy/mimiclaw-proxy.js
```

或者 Windows 直接双击 `proxy/start-proxy.bat`。

**首次运行**会自动生成证书，无需任何额外操作：

```
[cert] 首次运行，正在自动生成自签名证书...
[cert] ✓ proxy-key.pem + proxy-cert.pem 已生成

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

---

### 第六步：配置 ESP32 连接代理

通过串口工具（如 idf.py monitor 或 PuTTY）连接 ESP32，在命令行中输入：

```
set_proxy 192.168.x.x 7890 http
```

将 `192.168.x.x` 替换为**你的电脑在局域网中的 IP 地址**。

> 查看本机 IP：在 PowerShell 中执行 `ipconfig`，找到局域网适配器的 IPv4 地址。

---

### 验证是否成功

通过飞书向 MimiClaw 发一条消息，代理控制台应依次出现：

```
[CONNECT] target: api.openai.com → starting TLS termination
[TLS ✓] handshake OK: api.openai.com | ECDHE-RSA-AES128-GCM-SHA256 | TLSv1.2
[intercept] POST /v1/chat/completions HTTP/1.1
[forward]   api.openai.com → LM Studio :1234 (xxx bytes)
[response]  200 → ESP32 (xxx bytes)
```

---

## 技术原理

### TLS 中间人（MITM）流程

```
ESP32                    代理（Node.js）               LM Studio
  │                           │                           │
  │── CONNECT api.openai.com:443 ──>│                     │
  │<── 200 Connection Established ──│                     │
  │                           │                           │
  │── TLS ClientHello ───────>│  代理用自签名证书应答     │
  │<── TLS ServerHello ───────│                           │
  │── TLS Finished ──────────>│                           │
  │<── TLS Finished ──────────│  TLS 隧道建立完成         │
  │                           │                           │
  │── POST /v1/chat/completions（TLS 加密）──────>│       │
  │                    │ 解密，替换 model 字段             │
  │                    │── POST /v1/chat/completions ────>│
  │                    │<── 200 { "choices": [...] } ─────│
  │<── 200（重新 TLS 加密）──────────────────────────────│
```

### 为什么强制 TLS 1.2？

ESP32 的 mbedTLS 默认只编译了 TLS 1.2（启用 TLS 1.3 需要额外配置且消耗更多内存）。而 Node.js 18+ 默认优先协商 TLS 1.3，两端版本不匹配会导致握手失败：

```
mbedtls_ssl_handshake returned -0x7280  (MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE)
```

代理中通过以下设置强制只使用 TLS 1.2：

```js
minVersion: 'TLSv1.2',
maxVersion: 'TLSv1.2',
```

---

## 常见问题

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| `TCP connect to proxy … failed` | 防火墙阻止了 7890 端口 | 执行第二步的防火墙配置 |
| `mbedtls_ssl_handshake -0x7280` | TLS 版本不匹配（1.3 vs 1.2）| 确认代理中设置了 `maxVersion: 'TLSv1.2'` |
| `No server verification option set` | sdkconfig 缺少 `CONFIG_ESP_TLS_INSECURE=y` | 两行配置都添加，重新编译固件 |
| `esp-x509-crt-bundle: Failed to verify` | 固件 `crt_bundle_attach` 未设为 NULL | 按第一步修改固件并重新编译 |
| `HTTP 401 Missing Authentication` | 使用了旧版代理 | 使用本仓库最新版代理 |
| `connection refused`（连 LM Studio）| LM Studio 未启动或端口不对 | 确认 LM Studio 本地服务器已在 1234 端口运行 |

---

## 踩过的坑

| 问题 | 现象 | 根本原因 | 解法 |
|------|------|---------|------|
| 代理 v1 未拦截隧道内请求 | HTTP 401 | HTTP CONNECT 建立隧道后，隧道内的请求未被拦截，Auth header 没有注入 | 改为 TLS MITM，在解密后拦截并注入 header |
| 固件编译报字段不存在 | `has no member 'skip_server_cert_verify'` | `esp_tls_cfg_t` 根本没有这个字段，跳过验证是编译时宏控制的 | 删掉该字段，靠 sdkconfig 宏实现 |
| TLS 握手失败 -0x7280 | `FATAL_ALERT_MESSAGE` | Node.js 默认使用 TLS 1.3，ESP32 mbedTLS 不支持 | 代理强制 `maxVersion: 'TLSv1.2'` |
| ESP32 无法连接代理 | `TCP connect failed` | Windows 网络类型为 Public，阻止所有入站 | 改为 Private 并添加防火墙规则 |
| 证书验证失败 | `Failed to verify certificate` | sdkconfig 缺少父选项或 `crt_bundle_attach` 非 NULL | 两个 CONFIG 都要开，代码设 NULL |
| 飞书回复极慢（模型已出结果仍等待） | 发消息后数十秒才回复，LMStudio 日志显示生成已完成 | 代理返回 `Connection: keep-alive`，ESP32 读取循环无 Content-Length 解析，只能等 TCP 超时（最长 120 s）才退出 | 代理改为 `Connection: close`；固件 `llm_http_via_proxy` 改为两阶段读取：先读完 HTTP 头，解析 Content-Length，精确读取 body 后立即退出 |
| 询问时间返回"HTTP连接错误" | MimicLaw 调用 `get_time` 工具报错，LMStudio 直接测试正常 | `tool_get_time` 向 `api.telegram.org` 发 HEAD 请求获取时间，但代理对非 OpenAI/Anthropic 域名直连，而国内直连 Telegram 被墙 | 代理新增上游代理转发：`PROXY_REQUIRED_HOSTS` 中的域名（含 api.telegram.org）通过本机科学上网（`UPSTREAM_PROXY=http://127.0.0.1:7897`）转发 |

---

## License

MIT

</details>

---

<details>
<summary><strong>🇬🇧 English Documentation</strong></summary>

## Introduction

Route [MimiClaw](https://github.com/nicholasgasior/MimiClaw) (ESP32-S3) chat requests away from `api.openai.com` to a **local LM Studio** instance, without modifying the firmware's hardcoded API endpoint.

> **Tested with**
> - ESP32-S3 (8 MB PSRAM, 16 MB Flash)
> - ESP-IDF v5.5.2
> - LM Studio 0.3.x running `qwen/qwen3.5-9b`
> - Node.js 18+

---

## Architecture

```
Feishu message
      ↓
ESP32-S3 (MimiClaw firmware)
      ↓  HTTP CONNECT tunnel → proxy:7890
Local proxy (Node.js, this repo)
      ↓  TLS termination + request rewrite
LM Studio :1234
      ↓
Local model (e.g. Qwen3.5-9B)
      ↓
Response → ESP32 → Feishu
```

The firmware always connects to `api.openai.com:443` through the HTTP proxy configured via the serial console. The proxy performs TLS MITM: it terminates the ESP32's TLS session (presenting a self-signed certificate), reads the plaintext request, replaces the `model` field, and forwards the rewritten request to LM Studio over plain HTTP.

---

## Repository Structure

```
├── proxy/
│   ├── mimiclaw-proxy.js           # Main proxy server (with auto cert generation)
│   ├── gen-cert.js                 # Standalone cert generator (backup)
│   ├── gen-cert.sh                 # OpenSSL-based cert script for Linux/macOS (backup)
│   ├── gen-cert.ps1                # OpenSSL-based cert script for Windows (backup)
│   └── start-proxy.bat             # One-click launch on Windows
│
├── firmware-patch/
│   ├── http_proxy.c                # Modified firmware source (TLS cert skip)
│   ├── http_proxy.h                # Header file (reference only)
│   └── sdkconfig.defaults.esp32s3 # Required sdkconfig entries
│
└── README.md
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18+ |
| ESP-IDF | v5.5.2 |
| LM Studio | 0.3+ with a model loaded and local server enabled |

> **No OpenSSL required.** The proxy automatically generates a self-signed certificate on first launch using Node.js built-in `crypto` module.

---

## Setup Guide

### Step 1: Patch and Flash the Firmware

> This step modifies the MimiClaw firmware source code to skip TLS certificate verification for the local proxy, then recompiles and flashes.

**1.1 Modify `main/proxy/http_proxy.c`**

In the `proxy_conn_open()` function, change the `esp_tls_cfg_t` initializer from:

```c
esp_tls_cfg_t cfg = {
    .crt_bundle_attach = esp_crt_bundle_attach,
    .timeout_ms = timeout_ms,
};
```

to:

```c
esp_tls_cfg_t cfg = {
    .crt_bundle_attach = NULL,   // Skip cert verification; see note below
    .timeout_ms        = timeout_ms,
};
```

> **Note:** There is **no** `skip_server_cert_verify` field in `esp_tls_cfg_t` (a common misconception). Skipping verification is controlled by compile-time macros in sdkconfig. When `crt_bundle_attach = NULL` and the sdkconfig options below are set, ESP-IDF automatically applies `MBEDTLS_SSL_VERIFY_NONE`.

**1.2 Modify `sdkconfig.defaults.esp32s3`**

Append both lines to the end of the file (both are required):

```
CONFIG_ESP_TLS_INSECURE=y
CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y
```

> `CONFIG_ESP_TLS_INSECURE` is the parent option. Without it, `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` has no effect, and the firmware will print:
> ```
> E esp-tls: No server verification option set in esp_tls_cfg_t structure.
> ```

**1.3 Build the firmware**

```bash
# From the MimiClaw project root
idf.py set-target esp32s3
idf.py build
```

**1.4 Flash the firmware**

```bash
idf.py -p COM9 flash   # Replace COM9 with your actual serial port
```

---

### Step 2: Configure Windows Firewall

The ESP32 connects to the proxy over LAN. Windows blocks inbound connections by default and must be configured to allow them.

Open PowerShell **as Administrator** and run:

```powershell
# 1. Allow inbound TCP on port 7890
netsh advfirewall firewall add rule name="MimiClaw Proxy 7890" dir=in action=allow protocol=TCP localport=7890

# 2. Set the network profile to Private (Public mode blocks all inbound connections)
Set-NetConnectionProfile -InterfaceAlias "Ethernet" -NetworkCategory Private
```

> If your adapter name differs, find it first:
> ```powershell
> Get-NetConnectionProfile | Format-Table InterfaceAlias, NetworkCategory
> ```

---

### Step 3: Configure the Proxy

Edit the constants at the top of `proxy/mimiclaw-proxy.js`:

```js
const PROXY_PORT   = 7890;               // Port ESP32 connects to
const LM_HOST      = '127.0.0.1';       // LM Studio host address
const LM_PORT      = 1234;              // LM Studio local server port
const TARGET_MODEL = 'qwen/qwen3.5-9b'; // Model name (must match LM Studio)
```

---

### Step 4: Start LM Studio

1. Open LM Studio
2. Load your target model (e.g. Qwen3.5-9B)
3. Navigate to **Local Server** in the left sidebar and start the server on port 1234

---

### Step 5: Start the Proxy

```bash
node proxy/mimiclaw-proxy.js
```

Or on Windows, double-click `proxy/start-proxy.bat`.

**On first launch**, the proxy automatically generates the TLS certificate:

```
[cert] First run, generating self-signed cert...
[cert] ✓ proxy-key.pem + proxy-cert.pem generated

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

---

### Step 6: Point ESP32 at the Proxy

Connect to the ESP32 via serial terminal (e.g. `idf.py monitor` or PuTTY) and run:

```
set_proxy 192.168.x.x 7890 http
```

Replace `192.168.x.x` with your PC's LAN IP address.

> To find your PC's IP: run `ipconfig` in PowerShell and look for the IPv4 address of your LAN adapter.

---

### Verification

Send a message to MimiClaw via Feishu. The proxy console should show:

```
[CONNECT] target: api.openai.com → starting TLS termination
[TLS ✓] handshake OK: api.openai.com | ECDHE-RSA-AES128-GCM-SHA256 | TLSv1.2
[intercept] POST /v1/chat/completions HTTP/1.1
[forward]   api.openai.com → LM Studio :1234 (xxx bytes)
[response]  200 → ESP32 (xxx bytes)
```

---

## How It Works

### TLS MITM Flow

```
ESP32                    Proxy (Node.js)              LM Studio
  │                           │                           │
  │── CONNECT api.openai.com:443 ──>│                     │
  │<── 200 Connection Established ──│                     │
  │                           │                           │
  │── TLS ClientHello ───────>│  proxy presents           │
  │<── TLS ServerHello ───────│  self-signed cert         │
  │── TLS Finished ──────────>│                           │
  │<── TLS Finished ──────────│  TLS tunnel established   │
  │                           │                           │
  │── POST /v1/chat/completions (TLS encrypted) ─────>│   │
  │                    │ decrypt, patch model field        │
  │                    │── POST /v1/chat/completions ────>│
  │                    │<── 200 { "choices": [...] } ─────│
  │<── 200 (re-encrypted) ────────────────────────────────│
```

### Why TLS 1.2 Is Forced

ESP32's mbedTLS is compiled with TLS 1.2 only by default (TLS 1.3 requires additional configuration and more RAM). Node.js 18+ defaults to TLS 1.3, causing a version mismatch that aborts the handshake:

```
mbedtls_ssl_handshake returned -0x7280  (MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE)
```

The proxy forces TLS 1.2 with:

```js
minVersion: 'TLSv1.2',
maxVersion: 'TLSv1.2',
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `TCP connect to proxy … failed` | Firewall blocking port 7890 | Complete Step 2 (firewall config) |
| `mbedtls_ssl_handshake -0x7280` | TLS version mismatch (1.3 vs 1.2) | Ensure proxy has `maxVersion: 'TLSv1.2'` |
| `No server verification option set` | Missing `CONFIG_ESP_TLS_INSECURE=y` in sdkconfig | Add both lines and rebuild firmware |
| `esp-x509-crt-bundle: Failed to verify` | `crt_bundle_attach` not set to NULL | Apply Step 1 firmware patch and rebuild |
| `HTTP 401 Missing Authentication` | Using an old proxy version | Use this repo's latest proxy |
| `connection refused` (LM Studio) | LM Studio server not running | Start LM Studio local server on port 1234 |

---

## Pitfalls We Hit

| Issue | Symptom | Root Cause | Fix |
|-------|---------|-----------|-----|
| Proxy v1 missed tunnel requests | HTTP 401 | Requests inside the CONNECT tunnel were not intercepted; Auth header was never injected | Switched to TLS MITM to intercept and inject headers after decryption |
| Firmware compile error | `has no member 'skip_server_cert_verify'` | That field does not exist in `esp_tls_cfg_t`; it is a compile-time macro | Removed the field; rely on sdkconfig macros instead |
| TLS handshake failure -0x7280 | `FATAL_ALERT_MESSAGE` | Node.js defaults to TLS 1.3; ESP32 mbedTLS does not support it | Force `maxVersion: 'TLSv1.2'` in proxy |
| ESP32 cannot reach proxy | `TCP connect failed` | Windows network profile set to Public, blocking inbound connections | Change to Private and add firewall rule |
| Certificate verification failure | `Failed to verify certificate` | sdkconfig missing parent option or `crt_bundle_attach` was not NULL | Enable both CONFIG options; set field to NULL |
| Feishu reply extremely slow (model already done) | Reply arrives tens of seconds after sending; LMStudio log shows generation complete | Proxy returned `Connection: keep-alive`; ESP32 read loop had no Content-Length parsing and waited for TCP timeout (up to 120 s) to exit | Proxy changed to `Connection: close`; firmware `llm_http_via_proxy` rewritten to two-phase read: parse headers first, extract Content-Length, read exact body bytes and exit immediately |
| `get_time` tool returns HTTP connection error | MimicLaw reports error when asked about current time; works fine from LMStudio directly | `tool_get_time` sends a HEAD request to `api.telegram.org` to read the Date header, but proxy passed it through as a direct connection — Telegram is blocked in mainland China | Added upstream proxy routing: hosts in `PROXY_REQUIRED_HOSTS` (including api.telegram.org) are tunnelled through the local VPN proxy (`UPSTREAM_PROXY=http://127.0.0.1:7897`) |

---

## License

MIT

</details>
