#!/usr/bin/env bash
set -euo pipefail
bundle_dir="${PB_DEMO_BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$bundle_dir"
compose_file="${PB_DEMO_COMPOSE_FILE:-compose.yaml}"
env_file="${PB_DEMO_ENV_FILE:-.env.demo}"
project="${PB_DEMO_PROJECT:-plantbot-demo}"
external=0
[[ "${1:-}" != "--external" ]] || external=1
[[ "${1:-}" == "" || "$external" == 1 ]] || { echo 'Usage: ./start.sh [--external]' >&2; exit 1; }
command -v docker >/dev/null
docker compose version >/dev/null
if [[ "${PB_DEMO_SOURCE:-0}" != 1 ]]; then
  if command -v sha256sum >/dev/null; then sha256sum --check SHA256SUMS; else shasum -a 256 --check SHA256SUMS; fi
  docker load --input images.tar
fi
if [[ ! -f "$env_file" ]]; then
  if [[ "$external" == 1 ]]; then
    echo 'Copy .env.demo.example to .env.demo; set the existing Server URL/admin credentials and a Server-reachable RTSP address, then rerun ./start.sh --external.' >&2
    exit 1
  fi
  existing="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")"
  [[ -z "$existing" ]] || { echo 'Demo volumes already exist but credentials are missing; restore .env.demo before restarting.' >&2; exit 1; }
  umask 077
  credentials="$(mktemp "${env_file}.XXXXXX")"
  trap 'rm -f "$credentials"' EXIT
  docker run --rm --pull never --network none --entrypoint node "${PB_DEMO_IMAGE:-plantbot/demo-adapter:VERSION}" -e '
    const {randomBytes}=require("node:crypto");
    for(const [key,n] of [["SESSION_SECRET",32],["PB_ADMIN_PASSWORD",12],["PB_OPERATOR_PASSWORD",12],["PB_VIEWER_PASSWORD",12]]) console.log(key+"="+randomBytes(n).toString("hex"));
  ' > "$credentials"
  printf 'PLANTBOT_BIND=%s\nPLANTBOT_PORT=%s\nPB_DEMO_RTSP_PORT=%s\nPB_DEMO_MODE=complete\n' "${PLANTBOT_BIND:-127.0.0.1}" "${PLANTBOT_PORT:-18080}" "${PB_DEMO_RTSP_PORT:-18554}" >> "$credentials"
  mv "$credentials" "$env_file"
  trap - EXIT
fi
chmod 600 "$env_file"
if [[ "$external" == 1 ]]; then
  grep -Eq '^PB_DEMO_SERVER_URL=https?://[^[:space:]]+$' "$env_file" || { echo 'Set PB_DEMO_SERVER_URL in .env.demo' >&2; exit 1; }
  grep -Eq '^PB_ADMIN_PASSWORD=.+$' "$env_file" || { echo 'Set PB_ADMIN_PASSWORD in .env.demo' >&2; exit 1; }
  grep -Eq '^PB_DEMO_RTSP_BASE=rtsp://[^[:space:]]+$' "$env_file" || { echo 'Set Server-reachable PB_DEMO_RTSP_BASE in .env.demo' >&2; exit 1; }
else
  grep -q '^PB_DEMO_MODE=complete$' "$env_file" || { echo 'This credentials file is for an external Server; use --external.' >&2; exit 1; }
fi
compose=(docker compose -p "$project" --env-file "$env_file" -f "$compose_file")
if [[ "$external" == 0 ]]; then
  "${compose[@]}" up -d --no-build --pull never --wait api relay gateway
fi
"${compose[@]}" run --rm --no-deps --pull never demo-seed
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180 demo-adapter vision
"${compose[@]}" run --rm --no-deps --pull never demo-seed --rules
"${compose[@]}" ps
printf '\nDemo ready. Open /robots/?site=demo-lab on your Server.\nCredentials: %s\nNo random Server alarms. Three real monitoring rules; input loop: 70 → 85.2 → 72 C, absent → person → absent (30 seconds each).\n' "$env_file"
if [[ "$external" == 0 ]]; then
  binding="$("${compose[@]}" port gateway 8080)"
  printf 'Plantbot: http://%s/robots/?site=demo-lab\n' "$binding"
fi
