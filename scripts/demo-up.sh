#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sim_dir="${PLANTBOT_SIM_DIR:-$repo_root/../plantbotsimulator}"
sim_ref=49ba9419ca245f5e060a597bb75bb9d12be9d919
command -v docker >/dev/null
docker compose version >/dev/null
if [[ ! -e "$sim_dir" ]]; then
  git clone --no-checkout https://github.com/supcon-international/plantbotsimulator.git "$sim_dir"
  git -C "$sim_dir" checkout --detach "$sim_ref"
fi
[[ "$(git -C "$sim_dir" rev-parse HEAD)" == "$sim_ref" ]] || { echo "Use simulator revision $sim_ref (current checkout left unchanged)" >&2; exit 1; }
[[ -z "$(git -C "$sim_dir" status --porcelain)" ]] || { echo 'Simulator has local changes; use a clean pinned checkout.' >&2; exit 1; }
export PLANTBOT_SIM_DIR="$sim_dir"
build_profiles=(--profile server)
if [[ "${1:-}" == --external ]]; then build_profiles=(); fi
PB_ADMIN_PASSWORD=build-only docker compose -f "$repo_root/compose.demo.yaml" "${build_profiles[@]}" build
export PB_DEMO_SOURCE=1 PB_DEMO_BUNDLE_DIR="$repo_root" PB_DEMO_COMPOSE_FILE="$repo_root/compose.demo.yaml"
export PB_DEMO_IMAGE=plantbot/demo-adapter:development
exec bash "$repo_root/docker/release/start-adapter-demo.sh" "$@"
