# Add a new built-in vendor to the Plantbot repo

Goal: a new robot brand becomes a first-class citizen — a protocol-faithful **simulator ⇄ adapter** pair under `integrations/`, listed in the onboarding catalog, and startable from the UI as a **managed connector** (the platform runs the adapter as a supervised child process). Work happens inside the Plantbot repo. Read `docs/adapter-sim-architecture.md` first — it explains the three-layer design and how the three existing vendors map to it.

## Non-negotiable rules

- **Fidelity to the official protocol.** The adapter speaks the vendor's real wire protocol (so a real robot is plug-in); the simulator implements the official *server* face of that same protocol, quirks included. No invented messages. Before writing either, produce a field-level protocol reference in `docs/vendors/<vendor>.md` from official SDK/docs (see `docs/vendors/spot-sdk.md`, `deeprobotics-robotserver.md`, `gosuncn-api.md` for the expected depth). Sanitize real-world data (hosts, serials, coordinates) before it enters the repo.
- **The adapter is zero-aware of sim vs real robot.** Same code, different address.
- **Capability honesty.** The `switch (order.kind)` in the adapter is the vendor's true capability matrix. Protocol has no pause? Settle `failed: unsupported…` or bridge it explicitly (e.g. X30 bridges pause as cancel + re-send remaining points) — and document the bridge in the vendor mapping table.
- **No vendor protocol inside the platform process.** Managed connectors are supervised child processes; a crashing driver costs a respawn, never the platform.

## File-by-file checklist

Follow an existing vendor as the template — `integrations/deeprobotics/` is the smallest (bare TCP), `integrations/gosuncn/` shows a cloud API + multi-unit adapter, `integrations/spot/` shows gRPC + vendored protos.

1. **`docs/vendors/<vendor>.md`** — field-level protocol reference (message formats, session rules, error codes, quirks). This is written *before* code and reviewed against it after.
2. **`integrations/<vendor>/sim/main.ts`** — official server face + a simple behavior model (pose integration toward targets, battery drain/charge, event generation if the vendor cloud pushes alarms). Configurable port + home/dock via env (`<V>_SIM_PORT`, `<V>_SIM_HOME_X/Y`…) so multiple instances can run.
3. **`integrations/<vendor>/adapter/main.ts`** — vendor-protocol client + northbound translation. Import northbound etiquette from `../shared/bridge.ts` (re-exports of `@plantbot/adapter-sdk`: `waitForSite`, `pumpOrders`, `runWaypointMission`, `reportFault`) and the adapter glue. `pumpOrders` dedupes by `order.id`, serializes `goto`/`mission` motion orders per serial (optional `preempt(inflight, incoming)` hook), and runs `pause`/`resume`/`abort`/`announce`/`ptz` immediately — so your `switch (order.kind)` needs no queue of its own:
   - `customProfileFromEnv()` — **required**: when the platform supervises this adapter it injects identity via env (`PB_SERIAL` is the switch). Pattern: `const PROFILE = customProfileFromEnv() ?? pickProfile(PROFILES, process.env.<V>_PROFILE, 'default')`.
   - `worldTransformFromEnv()` — required if the vendor navigates in its own SLAM frame: apply `.fwd` to every uplinked pose, `.inv` to every downlinked goto/mission target (mind the axis flip, typically `z = -y`).
   - `streamsToFactsheet(PROFILE.streams, STREAM_BASE)` — publishes channels; absolute URLs (`rtsp://…`) pass through untouched.
4. **`integrations/package.json`** — add `"sim:<vendor>": "tsx <vendor>/sim/main.ts"` and `"adapter:<vendor>": "tsx <vendor>/adapter/main.ts"` scripts.
5. **`integrations/scripts/dev-all.mjs`** — add the pair to the demo stack if a demo site should show it (pick a free port; note the process count changes — see docs sync below).
6. **`server/src/config.ts`** — extend the `ConnectorVendor` union type.
7. **`server/src/connectors.ts`** — add a `VENDORS` entry: `title`, `model` (must equal the `ROBOT_CATALOG` model string), `entry` (adapter path relative to `integrations/`), `fields` (connection form: address/credentials/vendor-specific numbers; append `...TF_FIELDS` if the vendor needs the CALIB transform), and `env(cfg)` mapping form fields → the adapter's env vars. This catalog **drives the UI form** — no web code changes needed for the form itself.
8. **`server/src/fleet.ts`** — add a `ROBOT_CATALOG` entry (model/vendor/family/specs/protocol/blurb en+zh). `urdf: ''` renders a silhouette twin; a real URDF needs assets in `scripts/setup.mjs` + wiring in `web/src/three/UrdfRobot.tsx` (optional, do later).
9. **`integrations/test/<vendor>.e2e.ts`** — full-behavior e2e using `test/harness.ts`:
   - `standUpVendor(...)` boots a throwaway platform (`PB_DATA_DIR` temp dir, `PB_DEV_KEYS=1`, `PB_DEMO=1`), spawns real sim + real adapter, silences schedules pinned to the robot (`disablePinnedSchedules` — demo schedules will otherwise dispatch mid-test), waits for registration.
   - Assert the ladder: registration (FLEET contains serial, `EXTERNAL`) → state flows (coords change, online) → `goto` dispatch → mission (step progress, result) → abort → announce/ptz/dock (or honest `unsupported`) → events (type mapping, snapshot url) → readings → offline detection (kill sim → OFFLINE ≤ 20 s → respawn → recovers) → vendor-specific wire quirks (spawn a raw socket/client against the sim where needed).
   - Run: `cd integrations && pnpm test` (all suites; they use disjoint port ranges and run concurrently).

## Managed-connector env contract (platform → adapter)

The supervisor (`server/src/connectors.ts` `buildEnv`) injects; the adapter consumes via `customProfileFromEnv()` + its own vendor envs:

| Env | Meaning |
| --- | --- |
| `PLANTBOT_BASE` / `PLANTBOT_KEY` | Loopback platform URL + per-site internal key (re-issued each boot, plaintext memory-only) |
| `STREAM_BASE` | Prefix for relative demo stream files (`/media`) |
| `PB_SERIAL` | **The switch**: presence means "managed identity" — override the built-in demo profile |
| `PB_CALLSIGN` | Display name (defaults to serial) |
| `PB_DOCK_X` / `PB_DOCK_Z` | Charge-pile pose in world frame (vendors whose dock is integrator-calibrated config) |
| `PB_STREAMS` | JSON array `[{id?, name, kind?, url}]` — the robot's native camera URLs, `rtsp://` passes through to the factsheet |
| `PB_TF_SCALE/THETA/TX/TZ` | CALIB similarity transform (identity when unset) |
| *(vendor-specific)* | Whatever your `VENDORS[v].env(cfg)` maps from the connection form (`SPOT_HOST`, `DR_PORT`, `GOSUNCN_BASE`…) |

Supervisor behavior you get for free: spawn via workspace `tsx` with **only a whitelisted env** (`PATH`/`HOME`/`TMPDIR`/`LANG`/`TZ`/`NODE_OPTIONS` + proxy/cert vars) plus the injected identity/vendor vars above — the platform's full env is **not** passed through; crash respawn with 2 s → 30 s backoff (reset after 60 s healthy), 200-line log ring (INTEG → LOGS dialog), auto-resume of enabled connectors on platform boot, `SIGTERM` on shutdown with a 2 s `SIGKILL` fallback, site-deletion teardown.

## Docs sync list (do all that apply)

- `docs/adapter-sim-architecture.md` — §2 topology (process count!), §3 vendor mapping table, §5 test list.
- `docs/integration.md` + `README.md` — vendor/adapter counts and the built-in model list ("三种型号" wording).
- `CLAUDE.md` **and** `AGENTS.md` (kept mirrored) — the integration-layer bullets name the vendors, profile envs, and the "5 对 10 进程" count.
- `docs/guide.zh.md` / `docs/guide.en.md` — mention the new built-in model in the managed-connection section.
- `docs/openapi.yaml` — only if you changed the integration API itself (then also re-validate and keep the served spec in sync).

## Verification ladder

1. `cd server && node_modules/.bin/tsc --noEmit` and `cd integrations && node_modules/.bin/tsc --noEmit`.
2. `cd integrations && pnpm test` — your new suite plus all existing ones stay green (`E2E_VERBOSE=1` to see child logs).
3. `pnpm dev`, then in the UI: INTEG → NEW CONNECTOR shows the vendor card with your form fields → create against your sim's address → status RUNNING with pid → FLEET card (`EXTERNAL`, right model, twin/silhouette) → LIVE channel if streams configured → MAP marker → dispatch goto + mission → LOGS dialog shows the southbound session → STOP/START/RESTART/delete behave.
4. Kill the sim process → connector logs show reconnect attempts, robot goes OFFLINE, comes back when the sim returns.
5. Definition-of-done checklist in [SKILL.md](../SKILL.md).
