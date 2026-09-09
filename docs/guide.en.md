# Plantbot Platform Guide

> 中文版：[guide.zh.md](guide.zh.md)

Plantbot is a **multi-site inspection-robot operations platform**: bring robots of different brands and fixed cameras into one console — watch the site, dispatch patrols, manage alarms. The robots handle walking and obstacle avoidance themselves; the platform handles *where to patrol today, who goes, what was found, and where the evidence is*.

The interface defaults to light and preserves saved theme and language preferences. On phones, Overview, Live, Tasks and Fleet stay in the bottom bar; More contains the other modules. Keyboard users can Tab between controls, press Enter to open resources and Escape to close dialogs.

## 1 · What each module does

Ten entries on the left rail (Integrations / Sites / Documentation are admin-only):

| Module | The question it answers |
| --- | --- |
| **Overview** | What does the site look like right now? — robots and alarms on a 3D plant map; tap a waypoint to send a robot there |
| **Live** | Live video, recording search/playback/download, camera presets, inspection plans and execution records |
| **Tasks** | Templates, schedules, week/month calendars, archived results and related events, CSV and printable reports |
| **Fleet** | How are the robots doing? — battery, speed, current job for every unit, with 3D models; the "connect a robot" wizard lives here too |
| **Map** | What does the plant look like? — the full working map: base layer, zones, waypoints and live robot positions |
| **Events** | Alarm review and evidence; equipment defects with severity, category, submitter, assignee, treatment history and resolution |
| **Assets** | Inspected equipment records in cards or tables; equipment–tag–inspection point–data type–unit–address register |
| **Integrations** (admin) | How do external systems plug in? — managed connectors, API keys, the event vocabulary and map upload, all on one page |
| **Sites** (admin) | Sites and Site Builder, user accounts, factory/department/position membership, login and operation audit logs |
| **Documentation** (admin) | How do I use the APIs? — the "API & Integration" reference: both OpenAPI specs rendered live from the running platform (never drifts) + the connect/embed guide |

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

In **Integrations → Managed connectors**, click *New*, pick the robot's brand, and fill in three things: the robot's IP address, its login credentials, and (optionally) the rtsp URLs of its onboard cameras. Click *Create & start* — done.

The platform runs the integration program for you: it restarts on crashes, its logs are one click away, and it comes back automatically after a platform restart. The robot shows up in the fleet within seconds, and its onboard cameras become live channels on the video wall.

Three models ship built-in, each speaking its vendor's official protocol: Boston Dynamics Spot, DeepRobotics Jueying X30, and Gosuncn GS Patrol F2.

### Route B — external adapter (across networks, or for any other robot)

If the platform runs in the cloud while the robots are inside the plant (no direct network path), or you're connecting a model we don't ship, run a small program — an *adapter* — next to the robot. It does four things: register the robot, report position and battery about once a second, pick up dispatch orders, and report findings.

Two ready-made toolkits help you write it:

- **TypeScript** (`sdk/adapter-sdk-ts`): about 50 lines per robot;
- **Node-RED** (`sdk/node-red-contrib-plantbot`): no code — wire four nodes into a flow; handy where Modbus/MQTT devices already live in Node-RED.

Either way, authentication is a single *site key* (issued on the Integrations page; the plaintext is shown exactly once).

### How the robot lands on the map

Once connected, the robot appears on the Overview / Map scene at its **real reported position**. If the robot navigates in its own mapping frame (most real robots do), calibrate once on the Site Builder's Calibration page — click two or more matching points on the map and the platform solves the conversion — then paste the result into the connector form. From then on the robot's position lines up with the plant map exactly.

## 4 · The data is open

Everything important on the platform can be read over HTTP with the same site key — for report tools, ticketing systems, wall dashboards and other third-party software:

- fleet and live status (position, battery, current job)
- the event stream (filter by time, state, category)
- mission history and schedules
- the video channel list
- sensor readings (query a metric over a time range)

The full interface definition comes as two standard **OpenAPI 3.0 documents**: the integration face [openapi.yaml](openapi.yaml) (robot reporting + read-only data) and the session face [openapi-platform.yaml](openapi-platform.yaml) covering every console operation. A running platform serves both live (`GET /api/integration/v1/openapi.json` and `GET /api/openapi.json`, no auth). Drop them into any OpenAPI tool (Swagger UI, Postman, Apifox) to browse and try.

Want Plantbot **inside your own system**? Pages embed in an iframe (`?embed=1&site=…`): the brand bar, utilities and side rail drop away, but a **compact module-nav strip stays** so users can still move between modules (`?embed=0` exits; the choice is sticky per tab-session). Use `?embednav=top|bottom|hidden` to place that strip — `top` (default, a slim top strip), `bottom` (when the host already owns the top edge), or `hidden` (the host drives navigation itself via the URL). Sign-in can delegate to your identity provider (OIDC/OAuth2 SSO) — see the "Embedding & SSO" section of [integration.md](integration.md).

Fields that contain video source addresses (with embedded credentials) never leave through these APIs — playback goes through viewing sessions, evidence frames through the snapshot endpoint.

## 5 · Inspection operations

To start recording, an administrator enables each channel in Live → Recordings and selects 1–30 days of retention. Earlier footage is not recovered. For camera inspections, save named presets, arrange their order and set dwell times. Execution requires an adapter that supports absolute positioning and confirms arrival; weekly camera schedules use UTC. The current F2 adapter only supports reset because its directional stop protocol is unverified; Spot CAM supports measured positioning and patrols; X30 robotserver does not expose camera positioning. After an interrupted move, an operator must verify that the camera has stopped before releasing its reservation.

Administrators maintain equipment and tags. A tag can bind to a metric from a registered robot; device protocols and credentials stay in adapters/connectors. Operators report, assign and treat defects in Events → Defects; closure requires a resolution and reopening preserves the history. Organization membership does not grant access: site roles remain separate. Event types are managed in Integrations → Event types. Camera patrols do not automatically capture images or run AI; external algorithms use the existing event, reading and evidence interfaces.

## 6 · Further reading

- Full feature coverage, boundaries and reference designs (Chinese): [inspection-operations.md](inspection-operations.md)
- Endpoint details and examples: [integration.md](integration.md)
- Machine-readable interface definition: [openapi.yaml](openapi.yaml)
- Deployment and operations: [deploy.md](deploy.md)
- The three-layer integration architecture (simulator ⇄ adapter ⇄ platform): [adapter-sim-architecture.md](adapter-sim-architecture.md)
- Connecting robots with a code agent (Claude Code etc.): the repo ships an Agent Skill at [.claude/skills/robot-adapter](../.claude/skills/robot-adapter/SKILL.md) — hand the folder to your agent

Open Fleet → robot → Teleoperation for manual driving, and Live → PTZ inspection for camera controls. See [manual-control.md](manual-control.md) for ownership, stopping behavior, supported hardware and adapter configuration.

## Events and monitoring rules

Open Events → Monitoring rules to view Adapter sources, choose one of eleven presets, preview the scene and configure regions, lines, thresholds and UTC schedules. Vision and real sensor thresholds share the monitoring rules workspace. Normal observations remain in rule details; anomalies enter Events with the triggering configuration revision, observation and evidence. Renaming or deleting a rule does not rewrite history. Explicitly linked video channels open the same rule editor. Continuous rules require a fixed view. Mobile OCR requires device-confirmed stationary feedback. See [release.md](release.md) and [vision.md](vision.md) for the separate Server and Adapter packages.

