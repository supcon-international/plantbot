# Build an external adapter

An external adapter is a process **you** run — anywhere that can reach both the robot and the platform. Any language works (the contract is plain HTTP, see [northbound-api.md](northbound-api.md)); two official flavors exist:

- **TypeScript** — `@plantbot/adapter-sdk` (`sdk/adapter-sdk-ts` in the Plantbot repo). Node ≥ 18, zero dependencies. The three built-in vendor adapters import this exact package, so it never drifts from reality. Install outside the repo: `npm i /path/to/plantbot/sdk/adapter-sdk-ts` (tsx/TS projects consume the source directly).
- **Node-RED** — `node-red-contrib-plantbot` (`sdk/node-red-contrib-plantbot`). Four nodes; southbound via any Node-RED ecosystem node (Modbus, MQTT, OPC UA, BACnet, HTTP).

Before writing code you need: the platform base URL, a site API key (`pbk_…`, issued in the Integrations panel), and a way to read/command your robot (its own SDK/protocol).

## TypeScript skeleton (complete adapter shape)

```ts
import {
  PlantbotClient, waitForSite, pumpOrders, runWaypointMission, reportFault,
  type PlantbotOrder, type MissionRun,
} from '@plantbot/adapter-sdk'

const pb = new PlantbotClient({ base: process.env.PLANTBOT_BASE, key: process.env.PLANTBOT_KEY! })
const SERIAL = 'ACME-0007'

const site = await waitForSite(pb)              // blocks until the platform is reachable
await pb.registerUntilUp({
  serial: SERIAL, model: 'Acme Ranger R1', level: 'dispatchable',
  callsign: 'ACME·07', family: 'ugv', home: { x: 0, z: 0 },
  streams: [{ id: 'front', name: 'Front cam', kind: 'camera', url: 'rtsp://user:pw@10.0.0.9:554/ch1' }],
})

let run: MissionRun | null = null               // at most one mission at a time

async function exec(o: PlantbotOrder) {
  switch (o.kind) {                             // ← this switch IS your capability matrix; keep it honest
    case 'goto': {
      const r = o.payload.dock
        ? await vendorDockRoutine()             // dock:true → vendor's own return-to-charge if it has one
        : await vendorNavTo(o.payload.x!, o.payload.z!)
      return pb.orderStatus(o.id, r.ok ? 'done' : 'failed', r.note)
    }
    case 'mission': {
      run = { orderId: o.id, missionId: o.payload.missionId, aborted: false, paused: false }
      return runWaypointMission({
        pb, order: o, run,
        waypoints: site.waypoints,              // resolves step.waypointId → {x,z}
        navTo: (x, z) => vendorNavTo(x, z),
        doneNote: (d, t) => `${d}/${t} waypoints inspected`,
        onSettled: () => { run = null },
      })
    }
    case 'pause':  { if (run) run.paused = true;  return pb.orderStatus(o.id, 'done') }
    case 'resume': { if (run) run.paused = false; return pb.orderStatus(o.id, 'done') }
    case 'abort':  { if (run) run.aborted = true; return pb.orderStatus(o.id, 'done') }
    default:       return pb.orderStatus(o.id, 'failed', `unsupported: ${o.kind}`)
  }
}

setInterval(async () => {
  const s = await readYourRobot()               // southbound: your vendor protocol
  if (!s) return                                // robot unreachable → skip the beat, platform shows OFFLINE after 20 s
  const rep = await pb.state(SERIAL, { x: s.x, z: s.z, heading: s.heading, speed: s.speed, battery: s.battery, mode: s.mode })
  await pumpOrders(pb, SERIAL, rep, exec)       // pulls only when rep.ordersPending > 0
}, 1000)
```

Notes:

- `runWaypointMission` is for vendors **without** a native multi-point mission: point-by-point navigation honoring pause/abort, dwelling per step action durations, settling the order. If the vendor has a native task list (e.g. DeepRobotics Type 1003 takes all points in one command), map one `mission` order to one vendor task instead and settle when the vendor task terminates.
- The client never throws on transport errors — methods return `null`/`false`/`[]` and collapse repeated failures into one log line. Don't wrap it in try/catch; check return values only where you care.
- Robot-side faults: `reportFault(pb, SERIAL, 'IMU overheat')` → a `robot-fault` event on the platform.
- Evidence flow: `const url = await pb.snapshot('front')` (a stream id you registered) → pass as `snapshotUrl` in `pb.event(...)`.
- Readings: `await pb.readings(SERIAL, [{ metric: 'amb.temp.c', value: 24.1 }])` returns `{accepted, skipped, metrics}` — `metrics` is the site's registered-metric registry, so a rejected write (`accepted: 0`) is also your discovery mechanism for valid metric ids.

## Calibration — vendor SLAM frame → site world frame

If your robot navigates in its own map frame (most SLAM stacks), you must convert both ways. The platform's Site Builder → **CALIB** page solves a similarity transform (scale `s`, rotation `θ`, translation `t.x`, `t.z`) from point pairs (drive the robot to known site positions, record both coordinates). Bake the four numbers into your adapter (env vars by convention: `PB_TF_SCALE/THETA/TX/TZ`):

```ts
// fwd: vendor pose → world (apply to EVERY pose you report)
// inv: world → vendor frame (apply to EVERY goto/mission target you execute)
function makeTransform(s: number, th: number, tx: number, tz: number) {
  const c = Math.cos(th), n = Math.sin(th)
  return {
    fwd: (x: number, z: number) => ({ x: s * (c * x - n * z) + tx, z: s * (n * x + c * z) + tz }),
    inv: (x: number, z: number) => {
      const dx = (x - tx) / s, dz = (z - tz) / s
      return { x: c * dx + n * dz, z: -n * dx + c * dz }
    },
  }
}
```

Identity (robot map origin = site origin) needs no transform. Watch axis conventions: Plantbot is x-east / z-south; ROS-style maps are y-up, so typically `z = -y` before/after the transform (the built-in X30/Spot adapters do exactly this).

## Node-RED flavor

Install: `cd ~/.node-red && npm i /path/to/plantbot/sdk/node-red-contrib-plantbot`, restart Node-RED. Four nodes:

| Node | Role |
| --- | --- |
| `plantbot-config` | one per site: base URL + key (stored in Node-RED's credential store, never exported with flows) |
| `plantbot-robot` | registers the factsheet on deploy; each incoming msg = one state report; emits when `ordersPending > 0` |
| `plantbot-orders` | order pump: one msg per order, `msg.topic` = kind → route with a `switch` node (that switch is your capability matrix); feed back `{orderId, status, note}` to settle |
| `plantbot-event` | raise events; `snapshotStream` auto-captures a platform evidence frame |

Canonical flow (shipped as `examples/minimal-adapter-flow.json`): `inject 1 Hz → function (read your robot) → plantbot-robot → plantbot-orders → switch (msg.topic) → vendor command nodes → function ({orderId,status}) → back into plantbot-orders`.

## Any other language

Implement the loop in the skeleton above against the raw HTTP contract ([northbound-api.md](northbound-api.md)): register until 2xx → every second: report state, pull orders if `ordersPending > 0`, execute, settle. A ~20-line Python example lives in the repo's `docs/integration.md`. Keep the etiquette: retry forever on transport errors, never crash because the platform is down.

## Testing your adapter

1. `curl -H "authorization: Bearer $KEY" $BASE/api/integration/v1/site` — key and reachability sanity check.
2. Start the adapter → FLEET page shows the robot (`EXTERNAL` badge) within seconds; MAP shows the marker where the robot actually is (if it's at the wrong place or origin, your calibration `fwd` is wrong).
3. Self-verify with the same key, no UI needed: `GET /fleet` (your serial + fresh telemetry), post a test event → `GET /events`, post readings → `GET /robots/:serial/readings`.
4. Dispatch a `goto` from MAP (tap a waypoint) — robot moves, order settles `done` (wrong target position on the robot side = calibration `inv` is wrong).
5. Create a mission in MISSIONS pinned to your robot — watch step progress; try PAUSE/RESUME/ABORT.
6. Kill the adapter → OFFLINE within ~20 s (UI badge; in `GET /fleet` the robot's telemetry `mode` reads `"offline"`, the robot row is retained); restart → recovers with no manual steps. Restart the **platform** while the adapter runs — the adapter must reconnect on its own (the SDK does).
7. Run through the Definition-of-done checklist in [SKILL.md](../SKILL.md).

## Production notes

- Run under a supervisor (systemd unit / container restart policy). Env: `PLANTBOT_BASE`, `PLANTBOT_KEY` (from `PB_SEED_KEYS` or panel-issued), plus your vendor credentials. Never commit keys.
- If the platform is deployed under a sub-path (e.g. `https://host/robots`), `PLANTBOT_BASE` includes it: `https://host/robots`.
- RTSP playback in the platform UI requires the platform operator to run a go2rtc relay (`MEDIA_RELAY` env on the server). Snapshots (ffmpeg) work without it.
- One adapter process may serve multiple robots (register several serials, report each robot's state, pull each robot's orders) — the Gosuncn built-in adapter drives two units this way.
