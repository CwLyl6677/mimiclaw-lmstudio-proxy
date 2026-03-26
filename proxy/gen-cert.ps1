# Generate a self-signed RSA 2048 certificate for the TLS MITM proxy (Windows).
# Requires OpenSSL to be installed (e.g. from Git for Windows or winget install OpenSSL.Light)

$CertDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "[+] Generating RSA 2048 private key..." -ForegroundColor Cyan
openssl genrsa -out "$CertDir\proxy-key.pem" 2048

Write-Host "[+] Generating self-signed certificate (valid 10 years)..." -ForegroundColor Cyan
openssl req -new -x509 `
  -key "$CertDir\proxy-key.pem" `
  -out "$CertDir\proxy-cert.pem" `
  -days 3650 `
  -subj "/CN=api.openai.com/O=MimiClaw Proxy/C=CN"

Write-Host "[+] Done:" -ForegroundColor Green
Write-Host "    proxy-key.pem  - private key"
Write-Host "    proxy-cert.pem - self-signed certificate"
