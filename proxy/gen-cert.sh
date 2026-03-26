#!/bin/bash
# Generate a self-signed RSA 2048 certificate for the TLS MITM proxy.
# The certificate Common Name must match the hostname the ESP32 connects to,
# but since we disable cert verification on the ESP32 side, any CN works.

set -e

CERT_DIR="$(dirname "$0")"

echo "[+] Generating RSA 2048 private key..."
openssl genrsa -out "$CERT_DIR/proxy-key.pem" 2048

echo "[+] Generating self-signed certificate (valid 10 years)..."
openssl req -new -x509 \
  -key "$CERT_DIR/proxy-key.pem" \
  -out "$CERT_DIR/proxy-cert.pem" \
  -days 3650 \
  -subj "/CN=api.openai.com/O=MimiClaw Proxy/C=CN"

echo "[+] Done:"
echo "    proxy-key.pem  - private key"
echo "    proxy-cert.pem - self-signed certificate"
openssl x509 -in "$CERT_DIR/proxy-cert.pem" -text -noout | grep -E "Subject:|Not After"
