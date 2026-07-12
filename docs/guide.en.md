# Plantbot Platform Guide

> 中文版：[guide.zh.md](guide.zh.md)

Plantbot is a **multi-site inspection-robot operations platform**: bring robots of different brands and fixed cameras into one console — watch the site, dispatch patrols, manage alarms. The robots handle walking and obstacle avoidance themselves; the platform handles *where to patrol today, who goes, what was found, and where the evidence is*.

## 1 · What each module does

Eight entries on the left rail, one job each:

| Module | The question it answers |
| --- | --- |
| **OPS** | What does the site look like right now? — robots and alarms on a 3D plant map; tap a waypoint to send a robot there |
| **LIVE** | What do the cameras see? — robot onboard cameras plus fixed cameras, focus view or wall; admins add, edit and remove fixed cameras right here |
| **TASKS** | How are the patrols going? — running, queued and historical missions, step by step, with what was captured at each stop |
| **FLEET** | How are the robots doing? — battery, speed, current job for every unit, with 3D models; the "connect a robot" wizard lives here too |
| **MAP** | What does the plant look like? — the full working map, switchable to a photorealistic 3D scan |
| **EVENTS** | What happened? — an alarm board split by severity, every entry with snapshot evidence; acknowledge, resolve or dismiss |
| **INTEG** | How do external systems plug in? — managed connectors, API keys, the event vocabulary and map upload, all on one page |
| **SITES** | Which plants are on the platform? — create sites, draw them (Site Builder), manage user accounts |

## 2 · Why the platform is site-centric

Much robot software is robot-centric: routes live inside the robot, alarm rules are bound to the robot. Swap the robot and you start over.

Plantbot turns that around: **knowledge about the plant belongs to the plant, not to any one robot.**

- Patrol routes, maps, alarm rules and cameras all hang off the *site*.
- Robots are executors: Spot patrols a route today, an X30 patrols the same route tomorrow — the route doesn't change.
- One platform runs many sites, each with its own setup, fully isolated.

Delivering a new site is therefore plain: **create the site → upload the map → place waypoints and zones → connect the robots.** The first three steps are a few clicks in the Site Builder; the last one is the next section.

## 3 · Two ways to connect a robot

Pick by your network layout:

### Route A — platform-managed (recommended when platform and robots share a network)

In **INTEG → Managed connectors**, click *New*, pick the robot's brand, and fill in three things: the robot's IP address, its login credentials, and (optionally) the rtsp URLs of its onboard cameras. Click *Create & start* — done.

The platform runs the integration program for you: it restarts on crashes, its logs are one click away, and it comes back automatically after a platform restart. The robot shows up in the fleet within seconds, and its onboard cameras become live channels on the video wall.

Three models ship built-in, each speaking its vendor's official protocol: Boston Dynamics Spot, DeepRobotics Jueying X30, and Gosuncn GS Patrol F2.

### Route B — external adapter (across networks, or for any other robot)

If the platform runs in the cloud while the robots are inside the plant (no direct network path), or you're connecting a model we don't ship, run a small program — an *adapter* — next to the robot. It does four things: register the robot, report position and battery about once a second, pick up dispatch orders, and report findings.

Two ready-made toolkits help you write it:

- **TypeScript** (`sdk/adapter-sdk-ts`): about 50 lines per robot;
- **Node-RED** (`sdk/node-red-contrib-plantbot`): no code — wire four nodes into a flow; handy where Modbus/MQTT devices already live in Node-RED.

Either way, authentication is a single *site key* (issued on the INTEG page; the plaintext is shown exactly once).

### How the robot lands on the map

Once connected, the robot appears on the OPS / MAP scene at its **real reported position**. If the robot navigates in its own mapping frame (most real robots do), calibrate once on the Site Builder's CALIB page — click two or more matching points on the map and the platform solves the conversion — then paste the result into the connector form. From then on the robot's position lines up with the plant map exactly.

## 4 · The data is open

Everything important on the platform can be read over HTTP with the same site key — for report tools, ticketing systems, wall dashboards and other third-party software:

- fleet and live status (position, battery, current job)
- the event stream (filter by time, state, category)
- mission history and schedules
- the video channel list
- sensor readings (query a metric over a time range)

The full interface definition is a standard **OpenAPI 3.0 document**: [openapi.yaml](openapi.yaml) in the repo, and served live by a running platform (`GET /api/integration/v1/openapi.json`, no auth). Drop it into any OpenAPI tool (Swagger UI, Postman, Apifox) to browse and try every endpoint.

Fields that contain video source addresses (with embedded credentials) never leave through these APIs — playback goes through viewing sessions, evidence frames through the snapshot endpoint.

## 5 · Further reading

- Endpoint details and examples: [integration.md](integration.md)
- Machine-readable interface definition: [openapi.yaml](openapi.yaml)
- Deployment and operations: [deploy.md](deploy.md)
- The three-layer integration architecture (simulator ⇄ adapter ⇄ platform): [adapter-sim-architecture.md](adapter-sim-architecture.md)
