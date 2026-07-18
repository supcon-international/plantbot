# Northbound API contract — `/api/integration/v1`

Compact reference for adapter authors. The authoritative machine-readable spec is served by every running platform at `GET <base>/api/integration/v1/openapi.json` (no auth) — fetch it for exact schemas. In the Plantbot repo: `docs/openapi.yaml` (source of truth) and `docs/integration.md` (long-form, zh).

Design lineage: factsheet/state/order semantics follow **VDA 5050**; the `state-only | dispatchable` access levels follow **Open-RMF** fleet adapters; map upload follows the **ROS map_server** convention. Transport is plain HTTP + JSON.

## Auth

```
Authorization: Bearer pbk_xxxxxxxx…
```

One key ↔ one site. Same endpoints, different keys land on different sites. Provisioning: Integrations panel (admin) → issue key (plaintext shown exactly once); production automation via `PB_SEED_KEYS="plant-07=pbk_…,campus-east=pbk_…"` env; dev stack (`PB_DEV_KEYS=1`) seeds deterministic keys: `pbk_dev_` + site id without hyphens (e.g. `pbk_dev_plant07`, `pbk_dev_campuseast`).

## Endpoints

Write side (adapter → platform):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/site` | Site factsheet: bounds, waypoints, zones, event-type vocabulary, reading-metric registry (`metrics`) |
| POST | `/robots` | Register/update robot (factsheet, idempotent by `serial`) |
| DELETE | `/robots/:serial` | Deregister (rarely needed — going silent just shows OFFLINE) |
| POST | `/robots/:serial/state` | ~1 Hz state report; doubles as heartbeat (>20 s → OFFLINE); response carries `ordersPending` |
| GET | `/robots/:serial/orders` | Pull pending orders (pulling marks them `acked`) |
| POST | `/orders/:id/status` | Settle an order: `{status: "done"\|"failed", note?}` |
| POST | `/events` | Push an event (type must be registered in the site vocabulary) |
| POST | `/robots/:serial/readings` | Batch payload readings (registered metrics only) |
| POST | `/snapshot` | Evidence capture: `{stream}` → `{url}` — platform grabs a frame from a registered stream source and hosts it |
| POST | `/maps` | Upload occupancy-grid map (ROS convention) |

Read side (same key, for BI / self-verification / third-party systems; **read-only, no side effects**):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/fleet` | Robots (public shape, rtsp credentials stripped) + live telemetry; a silent adapter (>20 s) shows as that robot's telemetry `mode: "offline"` |
| GET | `/events?since&lifecycle&category&limit` | Event stream (limit ≤ 500) |
| GET | `/missions?status&limit` | Mission runs |
| GET | `/schedules` | Schedules + templates |
| GET | `/channels` | Video channels (source URLs redacted) |
| GET | `/robots/:serial/readings?metric&since&limit` | Reading time series (limit ≤ 1000) |
| GET | `/maps` | Map inventory + calibration transforms (similarity params for pixel/vendor/WGS84 → world) |
| GET | `/openapi.json` | This API's OpenAPI 3.0 document (no auth) |

## Factsheet (POST /robots)

```jsonc
{
  "serial": "ACME-0007",           // required, idempotency key; platform robot id = ext- + lowercased serial (ext-acme-0007)
  "model": "Acme Ranger R1",       // free text; matching a catalog model (Spot / Jueying X30 / GS Patrol F2) brings its 3D twin + spec sheet, anything else gets a silhouette
  "level": "dispatchable",         // "state-only" = display only, never dispatched; "dispatchable" = operators can send orders
  "callsign": "ACME·07",           // display name
  "family": "quadruped",           // "quadruped" | "ugv"
  "vendor": "Acme Robotics",
  "protocol": "acme-bridge 2.1",   // shown on the robot card
  "home": { "x": -6, "z": -4 },    // optional home/dock marker (world meters)
  "streams": [                     // cameras this robot publishes → LIVE channels
    { "id": "front", "name": "Front cam", "kind": "camera", "url": "rtsp://user:pw@10.0.0.9:554/ch1" }
  ]
}
```

`streams[].url` accepts `rtsp://` (platform relays via go2rtc, snapshots via ffmpeg), `http(s)://` (HLS or file), or a platform-relative `/media/...` path. Send real credentials in rtsp URLs — the platform strips them from every non-admin surface itself.

## State (POST /robots/:serial/state)

```json
{ "x": -5.5, "z": -3.8, "heading": 1.2, "speed": 0.6, "battery": 81, "mode": "navigating", "errors": [] }
```

All fields optional — send what you have. `mode ∈ idle|navigating|executing|teleop|charging`. Response: `{ ok, ordersPending }`.

## Orders

`GET /robots/:serial/orders` → `{ orders: [{ id, kind, payload, state, createdAt }] }`. Seven kinds:

| kind | payload | Semantics |
| --- | --- | --- |
| `goto` | `{x, z, dock?}` | Navigate to world coords. `dock: true` = return-to-charge — substitute the vendor's docking routine if it has one |
| `mission` | `{missionId, name, steps: [{waypointId, actions?: [{type, durationS?}]}]}` | Full inspection mission. **Only this kind's settlement settles the platform-side mission.** Resolve `waypointId` against `GET /site` waypoints; dwell per action durations (capture/scan happens on-robot) |
| `announce` | `{text}` | Loudspeaker TTS |
| `pause` / `resume` / `abort` | `{missionId}` | Operator intervention on a running external mission; `missionId` is a reference — apply to your executor, settle `done`, do not treat as mission completion |
| `ptz` | `{channelId, pan?, tilt?, zoom?}` | PTZ intent for one of your streams |

Settle: `POST /orders/:id/status` `{status: "done"|"failed", note?}`. Unsupported kind → `failed` with note `unsupported: <kind>`. After a platform restart, acked-but-unsettled orders are re-queued — the same order id may arrive twice.

Dispatch policy: the platform never auto-assigns `auto` missions to external robots — only explicitly pinned ones (operator pick or schedule `assign: {kind:'robot', robotId}`). A pinned mission for an unregistered robot waits in queue and dispatches automatically once the robot registers.

## Events (POST /events)

```jsonc
{
  "type": "valve-leak",            // must exist in site vocabulary (GET /site → eventTypes); admins register custom types
  "robotSerial": "ACME-0007",      // optional: pins the event to the robot's current position
  "detail": "CH4 8ppm at flange B-12",
  "severity": "high",              // optional; defaults to the type's registered severity
  "x": 3.2, "z": -1.4,             // optional explicit coords
  "snapshotUrl": "…",              // use POST /snapshot to get a platform-hosted frame
  "confidence": 0.83,
  "category": "env",               // optional: security|fire|env|equipment|robot-fault
  "evidence": [{ "kind": "reading", "reading": { "metric": "ch4.ppm", "value": 8, "unit": "ppm" } }],
  "runId": "…"                     // optional: link to a mission run
}
```

Unregistered type → 400 (vocabulary stays controlled). Robot faults: `type: "fault"`, `category: "robot-fault"`.

## Readings (POST /robots/:serial/readings)

```json
{ "readings": [ { "metric": "ch4.ppm", "value": 2.4, "ts": 1783600000000 }, { "metric": "dt.max.c", "value": 8.1 } ] }
```

→ `{ accepted, skipped, metrics: [...] }` — only metrics in the site registry are accepted; `metrics` lists that registry, so a rejected write is also your discovery mechanism. Readings feed the robot detail time series and site threshold detectors (which auto-raise events). `ts` optional (defaults to now), 7-day rolling retention.

## Maps (POST /maps)

```jsonc
{
  "name": "slam_toolbox 2026-07-10",
  "resolution": 0.05,              // meters/pixel, from map.yaml
  "origin": [-16, -9],             // world coords [x, z] of the image's TOP-LEFT pixel
  "image": "data:image/png;base64,…"  // PNG (convert PGM first), ≤ 8 MB
}
```

World frame: x → east (image right), z → south (image down). Converting from ROS `map.yaml` (origin = bottom-left, y up): `originX` unchanged, `originZ = -(origin_y + height × resolution)`. Upload takes effect immediately (persisted + broadcast; renders as the 3D map's ground layer).
