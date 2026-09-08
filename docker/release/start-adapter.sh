#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if command -v sha256sum >/dev/null; then sha256sum --check SHA256SUMS; else shasum -a 256 --check SHA256SUMS; fi
if [[ ! -f adapter.json ]]; then cp adapter.example.json adapter.json; chmod 600 adapter.json; fi
if [[ ! -f .env.adapter ]]; then (umask 077; printf 'PB_SITE_KEY=\n' > .env.adapter); fi
if ! [[ -s adapter.json ]] || ! grep -Eq '^PB_SITE_KEY=.+$' .env.adapter; then
  printf 'Configure serverUrl, devices and sources in adapter.json, and PB_SITE_KEY in .env.adapter; then run start.sh again.\n'
  exit 1
fi
docker load --input images.tar
docker compose --env-file .env.adapter -f compose.yaml up -d --wait
