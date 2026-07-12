# @plantbot/adapter-sdk

TypeScript client for Plantbot's open integration API (`/api/integration/v1`).
Write a vendor robot adapter in ~50 lines: register a factsheet, report state
at ~1 Hz, pull orders, execute them with the robot's own protocol, report
events with evidence snapshots.

- **Node ≥ 18, zero dependencies** (global `fetch`).
- The client **never throws on transport errors** — adapters must outlive
  platform restarts. Every method returns `null`/`false`/`[]` on failure.
- State reports double as the heartbeat: >20 s of silence marks the robot
  OFFLINE; the response carries `ordersPending` so you know when to pull.

## Install

Inside this repo the package is a workspace member — depend on it with
`"@plantbot/adapter-sdk": "workspace:*"`. Outside, install from a checkout:

```bash
npm i /path/to/plantbot/sdk/adapter-sdk-ts
```

TypeScript / tsx projects consume the source directly. Plain-JS projects can
compile it with `tsc -p .` or bundle it with esbuild.

## Minimal adapter

```ts
import { PlantbotClient, waitForSite, pumpOrders } from '@plantbot/adapter-sdk'

const pb = new PlantbotClient({ base: 'http://plantbot:8787', key: process.env.PLANTBOT_KEY! })
const SERIAL = 'MY-ROBOT-001'

const site = await waitForSite(pb)               // blocks until the platform is up
await pb.registerUntilUp({
  serial: SERIAL,
  model: 'My Robot X1',
  level: 'dispatchable',                          // or 'state-only'
  streams: [{ id: 'front', name: 'Front camera', url: 'rtsp://user:pw@10.0.0.9:554/ch1' }],
})

setInterval(async () => {
  const pose = await myRobot.getPose()            // ← your vendor protocol
  const rep = await pb.state(SERIAL, { x: pose.x, z: pose.z, battery: pose.batt, mode: 'idle' })
  await pumpOrders(pb, SERIAL, rep, async (order) => {
    switch (order.kind) {                         // your capability matrix
      case 'goto':
        await myRobot.navTo(order.payload.x!, order.payload.z!)
        await pb.orderStatus(order.id, 'done')
        break
      default:
        await pb.orderStatus(order.id, 'failed', `unsupported: ${order.kind}`)
    }
  })
}, 1000)
```

Report a detection with platform-captured evidence:

```ts
const url = await pb.snapshot('front')            // platform grabs a frame from your stream
await pb.event({ type: 'person', robotSerial: SERIAL, severity: 'high', snapshotUrl: url })
```

## API surface

| Method | Semantics |
|---|---|
| `site()` / `waitForSite(pb)` | site bounds, waypoints, zones, event vocabulary |
| `register(fs)` / `registerUntilUp(fs)` | factsheet upsert (streams may be `rtsp://` — native cameras) |
| `state(serial, s)` | ~1 Hz pose/battery/mode; heartbeat; returns `ordersPending` |
| `pullOrders(serial)` / `orderStatus(id, st, note)` | pull-based order queue; settle with done/failed |
| `pumpOrders(pb, serial, rep, exec)` | pull + dispatch helper for the state loop |
| `event(ev)` / `reportFault(pb, serial, detail)` | detections & robot-health events |
| `readings(serial, items)` | batch payload metrics (registry-typed) |
| `snapshot(stream)` | evidence frame from a registered stream → hosted URL |
| `uploadMap(m)` | ROS map_server-style occupancy PNG |
| `runWaypointMission(opts)` | point-by-point mission runner (pause/abort-aware) for vendors without a native task list |

Full protocol reference: `docs/integration.md` in the Plantbot repo.
A Node-RED flavor of this SDK lives at `sdk/node-red-contrib-plantbot`.
