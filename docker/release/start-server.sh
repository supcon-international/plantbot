#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if command -v sha256sum >/dev/null; then sha256sum --check SHA256SUMS; else shasum -a 256 --check SHA256SUMS; fi
docker load --input images.tar
if [[ ! -f .env.server ]]; then
  umask 077
  credentials=$(mktemp .env.server.XXXXXX)
  trap 'rm -f "$credentials"' EXIT
  docker run --rm --network none --entrypoint node plantbot/api:VERSION -e '
    const {randomBytes} = require("node:crypto");
    for (const [name, size] of [["SESSION_SECRET", 32], ["PB_ADMIN_PASSWORD", 12], ["PB_OPERATOR_PASSWORD", 12], ["PB_VIEWER_PASSWORD", 12]])
      console.log(name + "=" + randomBytes(size).toString("hex"));
  ' > "$credentials"
  mv "$credentials" .env.server
  trap - EXIT
fi
docker compose --env-file .env.server -f compose.yaml up -d --wait
printf '\nPlantbot: http://localhost:18080/robots/\nCredentials: .env.server\nCreate a site, then create a site API key for the Adapter.\n'
