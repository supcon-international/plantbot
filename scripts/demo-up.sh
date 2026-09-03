#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/compose.demo.yaml"
env_file="${PB_DEMO_ENV_FILE:-$repo_root/.env.demo}"
sim_dir="${PLANTBOT_SIM_DIR:-$repo_root/../plantbotsimulator}"
sim_url="${PLANTBOT_SIM_URL:-https://github.com/supcon-international/plantbotsimulator.git}"
sim_ref="${PLANTBOT_SIM_REF:-dc32eea659b846c250d981b4146002733e6763f2}"
project="${PB_DEMO_PROJECT:-plantbot-demo}"

fail() {
  echo "[demo] $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not available"
compose_version="$(docker compose version --short | sed 's/^v//')"
compose_major="${compose_version%%.*}"
compose_rest="${compose_version#*.}"
compose_minor="${compose_rest%%.*}"
if [[ ! "$compose_major" =~ ^[0-9]+$ || ! "$compose_minor" =~ ^[0-9]+$ ]] || \
  ((compose_major < 2 || (compose_major == 2 && compose_minor < 17))); then
  fail "Docker Compose 2.17+ is required (found ${compose_version})"
fi

if [[ ! -f "$sim_dir/package.json" ]]; then
  command -v git >/dev/null 2>&1 || fail "git is required to fetch plantbotsimulator"
  [[ ! -e "$sim_dir" ]] || fail "$sim_dir exists but is not a valid plantbotsimulator checkout"
  sim_parent="$(dirname "$sim_dir")"
  mkdir -p "$sim_parent"
  sim_tmp="$(mktemp -d "$sim_parent/.plantbotsimulator.clone.XXXXXX")"
  cleanup_sim_tmp() {
    if [[ -n "${sim_tmp:-}" && -d "$sim_tmp" ]]; then rm -rf -- "$sim_tmp"; fi
  }
  trap cleanup_sim_tmp EXIT
  echo "[demo] plantbotsimulator not found; cloning the tested revision"
  if ! GIT_TERMINAL_PROMPT=0 git clone --no-checkout "$sim_url" "$sim_tmp"; then
    fail "cannot clone plantbotsimulator; grant this server repository access, pre-clone it at $sim_dir, or set PLANTBOT_SIM_URL"
  fi
  if ! git -C "$sim_tmp" checkout --detach "$sim_ref"; then
    fail "plantbotsimulator ref $sim_ref is unavailable; set PLANTBOT_SIM_REF to a compatible commit or tag"
  fi
  mv "$sim_tmp" "$sim_dir"
  sim_tmp=""
  trap - EXIT
fi

required_sim_paths=(
  package.json
  package-lock.json
  tsconfig.json
  spot
  deeprobotics
  gosuncn
  shared
)
for path in "${required_sim_paths[@]}"; do
  [[ -e "$sim_dir/$path" ]] || fail "$sim_dir is missing required simulator path: $path"
done

git -C "$sim_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  fail "$sim_dir must be a git checkout so its tested revision can be verified"
actual_sim_ref="$(git -C "$sim_dir" rev-parse HEAD)"
expected_sim_ref="$(git -C "$sim_dir" rev-parse "${sim_ref}^{commit}" 2>/dev/null || true)"
[[ -n "$expected_sim_ref" ]] || fail "plantbotsimulator ref $sim_ref is not present in $sim_dir"
[[ "$actual_sim_ref" == "$expected_sim_ref" ]] || \
  fail "plantbotsimulator is at $actual_sim_ref, expected $expected_sim_ref; check it out or set PLANTBOT_SIM_REF explicitly"
[[ -z "$(git -C "$sim_dir" status --porcelain)" ]] || \
  fail "$sim_dir has local changes; use a clean checkout for a reproducible demo"

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [[ ! -f "$env_file" ]]; then
  existing_data_volume="$(docker volume ls --quiet \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.volume=plantbot-data' | head -n 1)"
  [[ -z "$existing_data_volume" ]] || \
    fail "$env_file is missing but demo data volume $existing_data_volume still exists; restore the credentials file, or stop the demo and manually delete that exact volume only if you intend to erase it"
  umask 077
  admin_password="$(random_hex 12)"
  operator_password="$(random_hex 12)"
  viewer_password="$(random_hex 12)"
  session_secret="$(random_hex 32)"
  plant07_key="pbk_$(random_hex 24)"
  plant12_key="pbk_$(random_hex 24)"
  campuseast_key="pbk_$(random_hex 24)"

  {
    echo "PLANTBOT_BIND=${PLANTBOT_BIND:-127.0.0.1}"
    echo "PLANTBOT_PORT=${PLANTBOT_PORT:-18080}"
    echo "TZ=${TZ:-Asia/Shanghai}"
    echo "SESSION_SECRET=$session_secret"
    echo "PB_ADMIN_PASSWORD=$admin_password"
    echo "PB_OPERATOR_PASSWORD=$operator_password"
    echo "PB_VIEWER_PASSWORD=$viewer_password"
    echo "PLANT07_KEY=$plant07_key"
    echo "PLANT12_KEY=$plant12_key"
    echo "CAMPUSEAST_KEY=$campuseast_key"
  } >"$env_file"
  echo "[demo] generated credentials in $env_file (mode 600)"
fi

chmod 600 "$env_file"
export PLANTBOT_SIM_DIR="$sim_dir"

compose=(docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file")

echo "[demo] building and starting the complete simulated stack"
if ! "${compose[@]}" up --detach --build --remove-orphans --wait --wait-timeout 600; then
  "${compose[@]}" ps || true
  "${compose[@]}" logs --tail=120 api bench relay gateway || true
  fail "startup failed; see logs above"
fi

if ! "${compose[@]}" exec -T bench node /app/robots/docker/bench-health.mjs --deep || \
  ! "${compose[@]}" exec -T api node /app/robots/docker/demo-smoke.mjs; then
  "${compose[@]}" logs --tail=120 api bench relay gateway || true
  fail "post-start SPA and media smoke test failed; see logs above"
fi

"${compose[@]}" ps

bind="$(sed -n 's/^PLANTBOT_BIND=//p' "$env_file" | tail -n 1)"
port="$(sed -n 's/^PLANTBOT_PORT=//p' "$env_file" | tail -n 1)"
operator_password="$(sed -n 's/^PB_OPERATOR_PASSWORD=//p' "$env_file" | tail -n 1)"
viewer_password="$(sed -n 's/^PB_VIEWER_PASSWORD=//p' "$env_file" | tail -n 1)"
echo
echo "[demo] ready: http://${bind:-127.0.0.1}:${port:-18080}/robots/"
echo "[demo] credentials: $env_file"
echo "[demo] presenter login: operator / $operator_password"
echo "[demo] customer login:  viewer   / $viewer_password"
