# node-red-contrib-plantbot

Node-RED nodes for Plantbot's open integration API — build a vendor robot
adapter as a flow. Same contract as `@plantbot/adapter-sdk` (the TypeScript
flavor): register a factsheet, feed ~1 Hz state, pull & settle orders, raise
events with platform-captured evidence.

Works with any southbound the Node-RED ecosystem speaks: Modbus, MQTT, OPC UA,
BACnet, plain HTTP — read your robot with those nodes, wire the result into
these.

## Install

```bash
cd ~/.node-red
npm install /path/to/plantbot/sdk/node-red-contrib-plantbot
# restart Node-RED
```

Requires Node-RED ≥ 3.0 on Node.js ≥ 18 (global fetch).

## Nodes

| Node | Role |
|---|---|
| `plantbot-config` | one per site: base URL + `pbk_…` key (kept in Node-RED's credential store, never exported with flows) |
| `plantbot-robot` | registers the factsheet on deploy; each incoming msg is a state report / heartbeat; emits `ordersPending` when the platform has work |
| `plantbot-orders` | order pump: emits one msg per pulled order (`msg.topic` = kind — route with a `switch`, that's your capability matrix); settle by feeding back `{orderId, status, note}` |
| `plantbot-event` | raise detections / robot faults; `snapshotStream` gets a platform-captured evidence frame |

## Minimal adapter

Import `examples/minimal-adapter-flow.json` (menu → Import). The shape:

```
inject 1Hz → function(read pose via YOUR protocol) → plantbot-robot ─┐
                                                                     ▼
        ┌──────────────────────────────────────────────── plantbot-orders
        ▼                                                            ▲
  switch on msg.topic ─ goto ─→ function(drive, settle done) ────────┤
        └────────────── else ─→ function(settle failed) ─────────────┘
```

Issue the site key in Plantbot → INTEG → SITE API KEYS (plaintext shows once).
Set `level` to `dispatchable` if the robot accepts goto/mission orders,
`state-only` for monitor-only.

Robot cameras: put the native `rtsp://user:pass@…` URL in the robot node's
Streams JSON — the platform plays it through its go2rtc relay and keeps the
credentialed URL admin-only.

Full protocol reference: `docs/integration.md` in the Plantbot repo.
