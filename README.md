# Plantbot

[English](README.en.md) | 简体中文

Plantbot 是一个多场站巡检机器人管理平台，用于统一管理不同品牌的机器人、巡检任务、视频和设备异常。路线、地图和设备档案按场站管理，机器人通过适配器接入并执行任务。

[在线演示](https://m3rcyzzz.club/robots) · [下载版本](https://github.com/supcon-international/plantbot/releases) · [更新记录](CHANGELOG.md) · [使用指南](docs/guide.zh.md)

## 功能

- **场站与机队**：场站建模、二维/三维地图、机器人位置和状态、坐标标定。
- **巡检任务**：任务模板、自动或指定机器人派单、定时排程、日历、执行记录与报告导出。
- **视频与云台**：实时视频、录像检索与回放、片段下载、云台控制、预置点和定时巡检。
- **机器人遥操作**：控制权申请、按住移动与松开停止、键盘操作、任务中断确认。
- **设备与异常**：设备档案、工业位号台账、传感器读数、告警证据及缺陷处理记录。
- **管理与集成**：场站权限、用户和组织管理、操作审计、OIDC 单点登录、HTTP API、TypeScript SDK 和 Node-RED 节点。

界面支持中英文、明暗主题及 iframe 嵌入。云台入口位于 **LIVE → 云台巡检**，机器人遥操作位于 **FLEET → 机器人 → 遥操作**。

## 快速体验

预构建演示包包含平台、视频中继和三家厂商的仿真机器人，无需本地构建。当前提供 Linux x86-64 包，需要 Docker Engine 和 Docker Compose 2.17+。

从 [v2.3.1 Release](https://github.com/supcon-international/plantbot/releases/tag/v2.3.1) 下载压缩包及 `.sha256` 校验文件，放在同一目录后运行：

```bash
sha256sum -c plantbot-v2.3.1-linux-amd64.tar.gz.sha256
tar -xzf plantbot-v2.3.1-linux-amd64.tar.gz
cd plantbot-v2.3.1-linux-amd64
bash start.sh
```

打开 [http://127.0.0.1:18080/robots/](http://127.0.0.1:18080/robots/)。首次登录凭证由启动脚本生成，保存在 `.env.demo`。远程访问、停止服务及保留数据升级见[版本部署文档](docs/release.md)。

## 本地开发

需要 Node.js 22.22+、pnpm 10+ 和 FFmpeg。

```bash
git clone https://github.com/supcon-international/plantbot.git
cd plantbot
pnpm install
pnpm run setup
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。开发模式会创建三个演示场站，账号为 `admin`、`operator`、`viewer`，默认密码均为 `plantbot`。`pnpm run setup` 下载视频素材、机器人模型和视频中继；请保留命令中的 `run`。

要运行完整的机器人演示，先停止开发服务，在平台仓库目录下安装独立的[仿真器](https://github.com/supcon-international/plantbotsimulator)：

```bash
git clone https://github.com/supcon-international/plantbotsimulator.git ../plantbotsimulator
cd ../plantbotsimulator
npm install
npm run setup
cd ../plantbot
pnpm dev
```

`pnpm dev` 会一起启动平台、适配器、仿真器和视频中继。未安装仿真器且未连接真机时，没有在线机器人；仅开发平台界面和 API 可使用 `pnpm dev:core`。

## 机器人接入

内置适配器支持 Boston Dynamics Spot、云深处 Jueying X30 和高新兴 GS Patrol F2。可在 **INTEG → 托管连接器** 配置机器人地址和凭证，由平台运行适配器；也可在机器人所在网络运行外部适配器，通过场站 API key 接入。

| 内置适配器 | 机器人遥操作 | 云台能力 |
| --- | --- | --- |
| Spot | 前进、横移、转向 | 配备并识别到 Spot CAM 机械云台后，支持控制、预置点和巡检 |
| GS Patrol F2 | 方向控制 | 相机复位 |
| X30 robotserver | 当前接口不提供 | 当前接口不提供 |

具体能力取决于机器人硬件及适配器声明，操作方式和接入条件见[遥操作与云台文档](docs/manual-control.md)。

Plantbot 负责调度和数据管理，导航、避障由机器人完成。检测算法可通过集成 API 上报读数、事件和证据。新增型号可使用 [TypeScript SDK](sdk/adapter-sdk-ts/README.md) 或 [Node-RED 节点](sdk/node-red-contrib-plantbot/README.md)，接入流程见[集成指南](docs/integration.md)。

## 项目结构

```text
server/         Fastify 后端与 SQLite 持久化
web/            React、Vite、shadcn/ui 和 Three.js 前端
integrations/   厂商适配器与集成测试
sdk/            TypeScript SDK 和 Node-RED 节点
docs/           使用指南、API、协议与部署文档
scripts/        开发、构建、发布和 UI 测试脚本
```

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动完整开发环境 |
| `pnpm dev:core` | 仅启动后端和前端 |
| `pnpm build` | 构建根路径部署的前端 |
| `WEB_BASE=/robots/ pnpm build` | 构建 `/robots/` 子路径部署的前端 |
| `pnpm --dir integrations test` | 适配器单元测试与集成测试；厂商行为测试需要仿真器 |
| `pnpm --dir sdk/adapter-sdk-ts test` | SDK 单元测试 |

UI 回归脚本为 `scripts/test-inspection-ui.mjs` 和 `scripts/test-control-ui.mjs`，运行前需构建 `/robots/` 子路径前端，并安装仿真器和 Google Chrome。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/guide.zh.md) | 功能模块与基本操作 |
| [版本部署](docs/release.md) / [生产部署](docs/deploy.md) | 预构建包、升级、真机部署和运维 |
| [集成指南](docs/integration.md) | 机器人接入、API、SDK 与嵌入 |
| [遥操作与云台](docs/manual-control.md) | 操作流程、设备支持和控制约束 |
| [集成 API](docs/openapi.yaml) / [平台 API](docs/openapi-platform.yaml) | OpenAPI 接口定义 |
| [平台模型](docs/platform-model.md) / [适配器架构](docs/adapter-sim-architecture.md) | 数据模型与厂商集成设计 |
