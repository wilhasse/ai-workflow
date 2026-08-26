#!/usr/bin/env bash
set -euo pipefail

umask 0077

remote_dir="${CODEX_REMOTE_RUNTIME_DIR:-${HOME}/ai-workflow/runtime/codex-remote}"
tls_dir="${remote_dir}/tls"
remote_ip="${CODEX_REMOTE_IP:-10.1.0.10}"
token_file="${remote_dir}/app-server-token"
ca_key="${tls_dir}/ca.key"
ca_cert="${tls_dir}/ca.crt"
server_key="${tls_dir}/server.key"
server_cert="${tls_dir}/server.crt"

mkdir -p "${tls_dir}"

if [[ ! -e "${token_file}" ]]; then
  openssl rand -out "${token_file}" -hex 32
fi
chmod 0600 "${token_file}"

tls_files=("${ca_key}" "${ca_cert}" "${server_key}" "${server_cert}")
present=0
for tls_file in "${tls_files[@]}"; do
  [[ -e "${tls_file}" ]] && present=$((present + 1))
done
if (( present > 0 && present < ${#tls_files[@]} )); then
  printf 'Refusing to overwrite a partial TLS setup under %s\n' "${tls_dir}" >&2
  exit 1
fi

if (( present == 0 )); then
  request_dir="$(mktemp -d)"
  trap 'rm -rf -- "${request_dir}"' EXIT

  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${ca_key}"
  openssl req -x509 -new -sha256 -days 3650 \
    -key "${ca_key}" \
    -subj '/CN=AI Workflow Codex Remote CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -out "${ca_cert}"

  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${server_key}"
  openssl req -new -sha256 \
    -key "${server_key}" \
    -subj "/CN=${remote_ip}" \
    -addext 'basicConstraints=critical,CA:FALSE' \
    -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
    -addext 'extendedKeyUsage=serverAuth' \
    -addext "subjectAltName=IP:${remote_ip},DNS:godev4" \
    -out "${request_dir}/server.csr"
  openssl x509 -req -sha256 -days 825 \
    -in "${request_dir}/server.csr" \
    -CA "${ca_cert}" \
    -CAkey "${ca_key}" \
    -CAcreateserial \
    -copy_extensions copy \
    -out "${server_cert}"
fi

chmod 0600 "${ca_key}" "${server_key}"
chmod 0644 "${ca_cert}" "${server_cert}"
openssl verify -CAfile "${ca_cert}" "${server_cert}"
openssl x509 -in "${server_cert}" -noout -checkend 2592000

printf 'Codex remote token: %s\n' "${token_file}"
printf 'Codex remote CA certificate: %s\n' "${ca_cert}"
openssl x509 -in "${ca_cert}" -noout -fingerprint -sha256
