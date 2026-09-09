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
| `ptz` | `{channelId, mode?: 'absolute'\|'relative'\|'home', pan?, tilt?, zoom?}` | PTZ intent; absolute success requires verified arrival, not just acceptance |

Settle: `POST /orders/:id/status` `{status: "done"|"failed", note?}`. Unsupported kind → `failed` with note `unsupported: <kind>`. After a platform restart, ordinary acked-but-unsettled orders are re-queued — the same order id may arrive twice. Interrupted platform-owned PTZ runs are failed instead; their unfinished orders are retracted and an uncertain camera position remains reserved until an operator verifies it.

Dispatch policy: `auto` selects an online, dispatchable external robot by required capability, battery and distance. Explicitly pinned missions wait when that robot is unregistered, offline or already running a mission; they dispatch when it becomes available.

### Camera capability and PTZ execution

Factsheet `streams[].ptz` is optional: `{absolute:boolean, pan:[min,max], tilt:[min,max], zoom:[min,max]}`. Declare `absolute:true` only for repeatable absolute positioning with measured arrival feedback. Absolute pan/tilt are calibrated degrees (positive right/up); zoom is optical magnification (1 = wide). Convert vendor-native coordinates at the adapter boundary and report the actual supported ranges. Do not pass normalized ONVIF coordinates through as if they were degrees.

For `payload.mode:'absolute'`, pan/tilt/zoom are required and `done` means the camera arrived, not that a vendor accepted the request. The platform starts dwell only after this receipt. Relative control is constrained by the declared ranges; `home` must not contain nonzero directional values. A reliable stop protocol is required before advertising directional control. The bundled F2 adapter currently allows reset only; directional movement/zoom and absolute positioning fail. Bundled Spot/X30 adapters do not support PTZ positioning.

Presets, ordered plans and immutable run steps belong to the site's Channel and are managed through the session-facing API. One patrol reserves each camera at a time. Weekly camera schedules use UTC. Cancellation stops further stops; it does not physically recall a delivered command. An operator verifies that an uncertain camera has stopped before releasing the reservation. Patrol dwell does not automatically capture images, collect readings or run AI: use the existing snapshot, event and reading interfaces for actual evidence and algorithm outputs.

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

## Manual control extension

`teleop:{forward,lateral,turn,watchdog:"native"|"adapter",mode?:"direction"}` declares driving. SI limits are m/s and rad/s; directional mode uses normalized direction codes. `streams[].ptz.manual:"position"` declares bounded position adjustment and a verified `mode:"stop"` PTZ order. Do not declare either capability from simulator assumptions alone.

GET `/robots/:serial/control` returns `{frame:null}` or `{id,sequence,target,channelId?,status,axes,remainingMs}`; `channelId` is the adapter stream key. POST the same path with `{id,sequence,status:"ready"|"applied"|"stopped"|"failed",position?:{pan,tilt,zoom},note?}`. Poll at about 80 ms and deduct HTTP round-trip time from TTL. Input expires after 400 ms; SDK bounds it to 350 ms with an independent 40 ms watchdog. Never replay sequences, queue these inputs or renew an old command's deadline. A stop receipt must confirm physical stopping, and match the latest sequence. Failure and platform restart retain the lock until confirmation.

The TypeScript and Node-RED client export `pumpControl(pb, serial, {start,apply,stop,position?})`. Start confirms stationary state; apply respects remaining TTL; stop resolves only after vendor confirmation. Spot supports native expiring velocity and discovered optional Spot CAM mechanical positioning. F2 direction controls have an adapter watchdog only; reset remains its only verified PTZ operation. X30 robotserver does not expose these interfaces. Managed Spot connector optional fields: `camStreamId`, `camStreamUrl` (RTSP), `camPtz` (default mech). Port 443 uses the official CA and Directory authority routing.

## Vision capability (v2.4.0)

These routes use the same site Bearer key, under `/api/integration/v1`. Vision does not require a fabricated robot.

- `POST /vision/heartbeat`: `{adapterId,runtimeId,name,sources:[{id,label,view:"fixed"|"mobile",status:"ready"|"paused"|"unavailable",channelId?}],models:{detector,ocr},capabilities:{presets:[implementedPresetId]}}`. Renew every 3 seconds; runtimeId changes each boot. Returns `{token,serverTime,configs,jobs}`; exclusive lease expires after 15 seconds. Declare only implemented presets; Server filters configuration to that capability. Legacy heartbeats without capabilities remain compatible. Do not send source URLs or device credentials.
- `POST /vision/results`, with `X-Vision-Token`: `{id,adapterId,configId,revision,capturedAt,status,value?,text?,note?,model,observationId,image?,annotations?}`. `capturedAt` is Unix milliseconds; status is normal/alert/unknown/failed; `image` is the base64 original JPEG (maximum 3 MiB encoded), annotations are `{label,box:[x1,y1,x2,y2],score}` in normalized coordinates. A test uses `jobId` instead of active configId. Reuse the result ID on retry. 409 means expired lease or changed configuration; 410 means removed config/expired job.

`configs` contain preset, sourceId, region, line/direction, threshold, durationS, confidence, intervalS, optional UTC schedule, assetId and numeric OCR settings. Jobs freeze the same configuration and expire after 60 seconds. Previews do not generate events. Unknown/failed results never mean recovery; results older than 60 seconds are archived without raising current alarms. Camera motion or missing frames must reset tracking and duration state. Mobile sources support OCR only with trustworthy, fresh stationary feedback. The built-in worker packages pinned RT-DETRv2, ByteTrack and PP-OCRv5 and never downloads models at runtime.
