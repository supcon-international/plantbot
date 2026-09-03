---
name: robot-adapter
description: Connect a robot of any brand to the Plantbot inspection platform by building or configuring a vendor adapter. Use when asked to integrate or onboard a robot/fleet into Plantbot, write an external adapter (TypeScript SDK, Node-RED, or raw HTTP in any language), publish a robot's native RTSP cameras, calibrate vendor SLAM coordinates to site coordinates, or add a new built-in vendor (simulator + adapter + managed connector) to the Plantbot repo.
---

# Connect a robot to Plantbot

Plantbot is a **pure integration layer**: no built-in robot drivers, no motion simulation, no path planner. Every robot arrives through an **adapter** — a small process that speaks the vendor's own protocol southbound (gRPC / TCP / vendor cloud / ROS / anything) and Plantbot's open integration API northbound (`/api/integration/v1`, HTTP + Bearer site key). Sites own the routes, maps, and detectors; robots execute orders and report state/events/readings. Path planning stays on the robot's Nav stack — the platform only sends target coordinates.

This skill folder is self-contained. It lives in the Plantbot repo at `.claude/skills/robot-adapter/`, and you can copy the whole folder into any other project (or point any code agent at this file) to integrate against a deployed platform.

## Pick the path

| Situation | Path |
| --- | --- |
| Robot is one of the built-in models (Boston Dynamics Spot / DeepRobotics Jueying X30 / Gosuncn GS Patrol F2) **and** the platform host can reach the robot's network | **Managed connector — configuration only, no code.** See [Managed connector config](#managed-connector-config-no-code) below. |
| Any other brand, cross-network deployment (platform in cloud, robot on-prem), or you want your own runtime | **External adapter — write one.** Read [references/external-adapter.md](references/external-adapter.md). ~50 lines with the TypeScript SDK; Node-RED and raw-HTTP flavors included. |
| The vendor should become a built-in: shipped in the Plantbot repo with a protocol-faithful simulator and one-click managed connectors | **New built-in vendor.** Read [references/managed-connector.md](references/managed-connector.md) (requires working inside the Plantbot repo). |

In every path the API contract summary is [references/northbound-api.md](references/northbound-api.md). A running platform serves the machine-readable spec at `GET <base>/api/integration/v1/openapi.json` (no auth) — but that is simply the repo's `docs/openapi.yaml` parsed at boot: **the yaml is the source of truth and must be kept in sync with the code** (it does not auto-derive from the running server, so a spec/behavior mismatch is a doc bug to fix, not gospel). The long-form guide is `docs/integration.md`.

## Contract invariants — every adapter must honor these

1. **One key = one site.** `Authorization: Bearer pbk_…`; the key routes all endpoints to its site. Keys are issued in the Integrations panel (admin), seeded via `PB_SEED_KEYS="<siteId>=pbk_…"` in production automation, or deterministic dev keys when the platform runs with `PB_DEV_KEYS=1` (`pbk_dev_` + site id without hyphens, e.g. `pbk_dev_plant07`).
2. **Registration is idempotent by `serial`.** Re-POST the factsheet to update it. The platform-side robot id is `ext-` + the lowercased serial (non-alphanumerics become `-`): `ACME-0007` → `ext-acme-0007` — lowercase when correlating read-API ids to your serial.
3. **State ≈ 1 Hz doubles as the heartbeat.** >20 s of silence shows the robot OFFLINE; it auto-recovers on the next report. The state response carries `ordersPending` — pull orders only when it is > 0.
4. **Settle every order** with `done` or `failed` (+ note). Pulling an order marks it acked; an acked-but-unsettled order is **re-queued after a platform restart**, so tolerate seeing the same order id twice.
5. **Capability honesty.** Unsupported order kind → `failed` with note `unsupported: <kind>`. Never fake success; the operator must see the vendor's true capability surface.
6. **Only `mission`-kind order completion settles the platform-side mission.** `pause`/`resume`/`abort` orders carry `missionId` as a reference — settle them `done` once applied, and never treat them as mission completion.
7. **`goto` with `dock: true` is return-to-charge.** Substitute the vendor's own docking/charging routine when one exists.
8. **Coordinates are site-world meters** (x → east, z → south). If the robot navigates in its own SLAM/map frame, apply the CALIB similarity transform: `fwd` (vendor → world) on every pose you report, `inv` (world → vendor) on every goto/mission target you execute. Details in external-adapter.md §Calibration.
9. **Streams: pass real URLs, never pre-redact.** Factsheet `streams[].url` may be the robot's native `rtsp://user:pass@…`. The platform plays it via its go2rtc relay and strips credentials from every non-admin surface itself.
10. **Event `type` must exist in the site vocabulary** (`GET /site` → `eventTypes`; admins register custom types in the Integrations panel). Use the platform snapshot service (`POST /snapshot`) for evidence frames instead of transcoding yourself.
11. **Readings accept only registered metrics.** The `POST /readings` response carries that registry (`{accepted, skipped, metrics}`; the TS SDK's `readings()` returns this object) — so a rejected write (`accepted: 0`) tells you exactly which metric ids are valid.
12. **Never crash on platform unavailability.** Retry forever; the platform may boot later or restart mid-run. The TypeScript SDK client never throws on transport errors by design.

## Managed connector config (no code)

For the three built-in vendors on a platform that can reach the robot's network. UI: **FLEET → CONNECT ROBOT → managed**, or **INTEG → MANAGED CONNECTORS → NEW CONNECTOR**. The platform runs the bundled official adapter as a supervised child process (crash backoff, log ring, auto-resume on boot, cascade kill on shutdown).

- Fill vendor connection fields (robot IP + credentials for Spot, robotserver host/port + dock pose for X30, GoRobot cloud URL + credentials + SN for GS F2), identity (`serial`, `callsign`), and the robot's native camera `rtsp://` URLs in the streams rows.
- Spot/X30 accept optional calibration fields (`s, θ, t.x, t.z`) solved on the Site Builder → CALIB page; leave empty when the robot's map origin is the site origin.
- Manage via the panel: START/STOP/RESTART, live LOGS dialog (last 200 lines), delete. Connector config carries robot credentials → **admin-only routes**; robot rtsp URLs are stripped from all public payloads automatically.
- Troubleshoot by reading the LOGS dialog first — the adapter prints its southbound session and northbound registration steps.

## Definition of done — verify before calling it integrated

- Robot appears on FLEET with the `EXTERNAL` badge, correct callsign/model; marker stands at a sane position on MAP.
- Battery/mode/speed update live. Kill the adapter → OFFLINE within ~20 s; restart it → back online, no manual steps.
- MAP tap-to-dispatch (`goto`) executes and settles `done`; a mission dispatched from MISSIONS runs step-by-step with visible progress and a recorded result.
- PAUSE/RESUME/ABORT on a running mission act on the robot (or settle `failed: unsupported…` honestly).
- Factsheet cameras appear on LIVE (playback needs the platform's `MEDIA_RELAY` go2rtc for rtsp sources); events land in EVENTS with snapshots; readings plot on the robot detail page.
- Self-check via the open read API with the same key: `GET /fleet` shows your serial with fresh telemetry; `GET /events`, `GET /robots/:serial/readings` round-trip what you posted.
- New built-in vendors additionally: both typechecks (`cd server && node_modules/.bin/tsc --noEmit`, `cd integrations && node_modules/.bin/tsc --noEmit`) pass, `cd integrations && pnpm test` is green, and the docs-sync list in managed-connector.md is done.
