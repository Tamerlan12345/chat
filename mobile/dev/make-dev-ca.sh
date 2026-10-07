#!/usr/bin/env bash
# Generates a DEV-ONLY root CA and a leaf TLS certificate for the local HTTPS
# stand (mobile/dev/tls-proxy.mjs).
#
#   mobile/dev/make-dev-ca.sh [out-dir]      (default: mobile/dev/certs)
#   DEV_CERT_DAYS=36500 mobile/dev/make-dev-ca.sh /some/dir
#
# Outputs (out-dir):
#   dev-ca.crt    PUBLIC root CA certificate -> trust in DEBUG builds only
#   dev-ca.key    CA private key (never leaves this machine)
#   dev-leaf.crt  leaf certificate, SAN: localhost, 127.0.0.1, 10.0.2.2
#   dev-leaf.key  leaf private key
#   dev-chain.crt leaf + CA
#
# Idempotent: existing certificates are kept unless FORCE=1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/certs}"
DAYS="${DEV_CERT_DAYS:-825}"

if [[ -f "$OUT/dev-ca.crt" && -f "$OUT/dev-leaf.crt" && "${FORCE:-0}" != "1" ]]; then
  echo "Dev certificates already exist in $OUT (FORCE=1 to regenerate)"
  exit 0
fi

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }
mkdir -p "$OUT"
cd "$OUT"

# Git Bash (MSYS) rewrites arguments starting with "/" such as -subj "/CN=..".
export MSYS_NO_PATHCONV=1

cat > dev-ca.cnf <<EXT
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = CentyChat Dev Root CA (DEV ONLY)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
# Whoever holds dev-ca.key can only mint certificates for the stand's own
# names: a device that trusts the dev CA does not trust it for anything else.
nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:10.0.2.2/255.255.255.255
EXT

cat > dev-leaf.ext <<EXT
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = DNS:localhost, IP:127.0.0.1, IP:10.0.2.2
EXT

openssl genrsa -out dev-ca.key 2048 2>/dev/null
openssl req -x509 -new -key dev-ca.key -sha256 -days "$DAYS" -config dev-ca.cnf -out dev-ca.crt

openssl genrsa -out dev-leaf.key 2048 2>/dev/null
openssl req -new -key dev-leaf.key -subj "/CN=localhost" -out dev-leaf.csr
openssl x509 -req -in dev-leaf.csr -CA dev-ca.crt -CAkey dev-ca.key -CAcreateserial \
  -sha256 -days "$DAYS" -extfile dev-leaf.ext -out dev-leaf.crt 2>/dev/null

cat dev-leaf.crt dev-ca.crt > dev-chain.crt
rm -f dev-leaf.csr dev-ca.srl dev-ca.cnf dev-leaf.ext
chmod 600 dev-ca.key dev-leaf.key 2>/dev/null || true

echo "Dev CA (public, trust in debug builds only): $OUT/dev-ca.crt"
echo "Leaf SAN: localhost, 127.0.0.1, 10.0.2.2"
