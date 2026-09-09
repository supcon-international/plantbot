# Plantbot

English | [简体中文](README.md)

Plantbot is a multi-site inspection robot management platform for managing mixed robot fleets, inspection tasks, video and equipment issues. Routes, maps and equipment records belong to each site. Robots connect through adapters and execute the assigned tasks.

[Live demo](https://m3rcyzzz.club/robots) · [Downloads](https://github.com/supcon-international/plantbot/releases) · [Changelog](CHANGELOG.md) · [User guide](docs/guide.en.md)

## Features

- **Sites and fleets:** site configuration, 2D and 3D maps, robot position and status, and coordinate calibration.
- **Inspection tasks:** task templates, automatic or assigned robot dispatch, schedules, calendars, execution records and report exports.
- **Video and PTZ:** live video, recording search and playback, clip downloads, camera control, presets and scheduled patrols.
- **Robot teleoperation:** exclusive control, hold-to-move and release-to-stop input, keyboard controls and confirmation before interrupting a task.
- **Events and monitoring rules:** unified vision and sensor threshold configuration; eleven vision presets for people, boundaries, restricted areas, crowds, post occupancy, dwell, vehicles and display OCR, with configurable regions, previews and evidence review.
- **Equipment and issues:** equipment records, industrial tag registers, sensor readings, alarm evidence and defect resolution history.
- **Administration and integration:** site permissions, users and organizations, audit logs, OIDC single sign-on, HTTP APIs, a TypeScript SDK and Node-RED nodes.

The interface follows the [Tier0 product design guidelines](docs/ui-design-audit.md), with English and Chinese, light and dark themes, and iframe embedding. New sessions default to light; additional mobile modules are available under More. Camera controls are under **Live → PTZ inspection**. Robot controls are under **Fleet → robot → Teleoperation**.

## Quick start

[Download v2.5.0](https://github.com/supcon-international/plantbot/releases/tag/v2.5.0) as separate **Server** and **Adapter** packages. Server runs the web application, API and video relay. Adapter connects robots and cameras and runs vision models near the devices. The prebuilt Linux x86-64 packages require Docker Engine and Docker Compose 2.17+; no source build is needed.

```bash
sha256sum -c plantbot-server-v2.5.0-linux-amd64.tar.gz.sha256
tar -xzf plantbot-server-v2.5.0-linux-amd64.tar.gz
cd plantbot-server-v2.5.0-linux-amd64
bash start.sh
```

Open [http://127.0.0.1:18080/robots/](http://127.0.0.1:18080/robots/) and sign in using the initial password in `.env.server`. Create a site and issue its API key. Configure the Adapter package with `serverUrl`, device addresses and `PB_SITE_KEY`, then run its `start.sh`. Pretrained models are included.

Fresh installations start with an empty platform. See the [deployment guide](docs/release.md) for installation, separate hosts and upgrades, and [vision monitoring](docs/vision.md) for monitoring configuration.

For a complete demonstration, download the same-version **Adapter Demo** package, extract it and run `bash start.sh`. It includes Server, three native-protocol robot simulators, real adapters, models and labelled sample videos. Open `http://127.0.0.1:18080/robots/?site=demo-lab`. Actual inference produces instrument threshold, occupancy and intrusion results; Server random alarms are disabled. See [Demo package](docs/demo.md) for the walkthrough, persistent restarts and external Server mode.

## Local development

Requires Node.js 22.22+, pnpm 10+ and FFmpeg.

```bash
git clone https://github.com/supcon-international/plantbot.git
cd plantbot
pnpm install
pnpm run setup
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Development mode creates three demo sites with the accounts `admin`, `operator` and `viewer`, all using `plantbot` as the default password. `pnpm run setup` downloads video assets, robot models and the video relay; keep `run` in this command.

For the complete robot demo, stop the development server and install the separate [simulator repository](https://github.com/supcon-international/plantbotsimulator) from the platform repository directory:

```bash
git clone https://github.com/supcon-international/plantbotsimulator.git ../plantbotsimulator
cd ../plantbotsimulator
npm install
npm run setup
cd ../plantbot
pnpm dev
```

`pnpm dev` starts the platform, adapters, simulators and video relay together. Without an installed simulator or connected physical robots, no robots will be online. Use `pnpm dev:core` to work on the interface and APIs with only the platform running.

## Connecting robots

Built-in adapters support Boston Dynamics Spot, DeepRobotics Jueying X30 and Gosuncn GS Patrol F2. Configure a robot's address and credentials in **INTEG → Managed connectors** to let the platform run its adapter. Alternatively, run an external adapter on the robot's network and connect it using a site API key.

| Built-in adapter | Robot teleoperation | Camera support |
| --- | --- | --- |
| Spot | Forward, lateral and turning motion | Control, presets and patrols with a detected Spot CAM mechanical PTZ payload |
| GS Patrol F2 | Directional control | Camera reset |
| X30 robotserver | Not exposed by the current interface | Not exposed by the current interface |

Available controls depend on the robot hardware and the capabilities declared by its adapter. See [robot and camera control](docs/manual-control.md) for operation and integration requirements.

Plantbot handles scheduling and data management; robots handle navigation and obstacle avoidance. Detection algorithms can submit readings, events and evidence through the integration API. Use the [TypeScript SDK](sdk/adapter-sdk-ts/README.md) or [Node-RED nodes](sdk/node-red-contrib-plantbot/README.md) to connect additional models. See the [integration guide](docs/integration.md) for details.

## Project structure

```text
server/         Fastify backend and SQLite persistence
web/            React, Vite, shadcn/ui and Three.js frontend
integrations/   Vendor adapters and integration tests
sdk/            TypeScript SDK and Node-RED nodes
docs/           User guides, APIs, protocols and deployment documentation
scripts/        Development, build, release and UI test scripts
```

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the full development environment |
| `pnpm dev:core` | Start the backend and frontend only |
| `pnpm build` | Build the frontend for a root-path deployment |
| `WEB_BASE=/robots/ pnpm build` | Build the frontend for deployment under `/robots/` |
| `pnpm --dir integrations test` | Run adapter unit and integration tests; vendor behavior tests require the simulators |
| `pnpm --dir sdk/adapter-sdk-ts test` | Run SDK unit tests |

UI regression scripts are available at `scripts/test-inspection-ui.mjs` and `scripts/test-control-ui.mjs`. Build the frontend for `/robots/` and install the simulators and Google Chrome before running them.

## Documentation

| Document | Contents |
| --- | --- |
| [User guide](docs/guide.en.md) | Modules and basic operation |
| [Release deployment](docs/release.md) / [Production deployment](docs/deploy.md) | Prebuilt packages, upgrades, physical robot deployments and operations |
| [Integration guide](docs/integration.md) | Robot integration, APIs, SDKs and embedding |
| [Robot and camera control](docs/manual-control.md) | Workflows, device support and control constraints |
| [Integration API](docs/openapi.yaml) / [Platform API](docs/openapi-platform.yaml) | OpenAPI specifications |
| [Platform model](docs/platform-model.md) / [Adapter architecture](docs/adapter-sim-architecture.md) | Data models and vendor integration design |
