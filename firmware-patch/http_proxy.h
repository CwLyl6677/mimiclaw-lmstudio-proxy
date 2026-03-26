#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdbool.h>

/**
 * Initialize proxy module (reads NVS config, falls back to build-time defaults).
 */
esp_err_t http_proxy_init(void);

/**
 * Returns true if a proxy host:port is configured.
 */
bool http_proxy_is_enabled(void);

/**
 * Save proxy host, port, and type ("http" or "socks5") to NVS.
 * Settings persist across reboots.
 */
esp_err_t http_proxy_set(const char *host, uint16_t port, const char *type);

/**
 * Remove proxy config from NVS (reverts to build-time defaults or no proxy).
 */
esp_err_t http_proxy_clear(void);

/* ── Proxied HTTPS connection ─────────────────────────────────── */

typedef struct proxy_conn proxy_conn_t;

/**
 * Open an HTTPS connection through the configured proxy.
 *   1) TCP connect to proxy host:port
 *   2) Send HTTP CONNECT (or SOCKS5 handshake) to target host:port
 *   3) TLS handshake over the established tunnel
 *
 * Certificate verification is skipped when CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY
 * is set in sdkconfig (required for self-signed proxy certificates).
 *
 * Returns NULL on failure.
 */
proxy_conn_t *proxy_conn_open(const char *host, int port, int timeout_ms);

/** Write raw bytes through the TLS tunnel. Returns bytes written or -1. */
int proxy_conn_write(proxy_conn_t *conn, const char *data, int len);

/** Read raw bytes from the TLS tunnel. Returns bytes read, 0 if none yet, or -1 on error. */
int proxy_conn_read(proxy_conn_t *conn, char *buf, int len, int timeout_ms);

/** Close and free the connection. */
void proxy_conn_close(proxy_conn_t *conn);
