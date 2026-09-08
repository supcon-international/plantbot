#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if command -v sha256sum >/dev/null; then sha256sum --check SHA256SUMS; else shasum -a 256 --check SHA256SUMS; fi
if [[ ! -f .env.server ]]; then
  umask 077
  {
    printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'PB_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 12)"
    printf 'PB_OPERATOR_PASSWORD=%s\n' "$(openssl rand -hex 12)"
    printf 'PB_VIEWER_PASSWORD=%s\n' "$(openssl rand -hex 12)"
  } > .env.server
fi
docker load --input images.tar
docker compose --env-file .env.server -f compose.yaml up -d --wait
printf '\nPlantbot: http://localhost:18080/robots/\nCredentials: .env.server\nCreate a site, then create a site API key for the Adapter.\n'
