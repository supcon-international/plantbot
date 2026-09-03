# Plantbot

多场站巡检机器人运营平台。把不同品牌的巡检机器人接进同一个控制台：画好场站地图，排好巡检任务，平台派单给机器人，机器人把发现的异常、读数和视频送回来。

在线演示：<https://m3rcyzzz.club/robots>（匿名可浏览）。

## 它解决什么问题

一个工厂或园区里往往同时有几种巡检机器人，比如波士顿动力 Spot、云深处 X30 四足、高新兴 F2 轮式安防车。每家的协议都不一样，各有各的后台。Plantbot 不控制机器人的腿和轮子，只做运营层的事：

- 场站是什么样：地图、航点、禁行区、固定摄像头、充电桩
- 什么时候巡哪条路线：任务模板加排程，创建即生效
- 谁去巡：按电量、距离、能力自动派单，或钉死某一台
- 发现了什么：事件流带证据快照，可确认、关闭、驳回
- 证据在哪：视频墙、快照、传感器读数时序

机器人本身经「适配器」接入，见下文。

## 五分钟跑起来

需要 Node 22.22 以上（推荐 Node 24）、pnpm 10 以上、ffmpeg。

```bash
git clone https://github.com/supcon-international/plantbot.git && cd plantbot
pnpm install        # 安装依赖，并构建 @plantbot/adapter-sdk
pnpm run setup      # 下载演示视频、机器人 3D 模型、go2rtc 视频中继（必须带 run）
pnpm dev            # 打开 http://localhost:5173
```

第一次启动会创建三个演示场站，账号 `admin` / `operator` / `viewer`，密码都是 `plantbot`。

想让演示里的机器人真的动起来，把仿真器仓库克隆到本仓库旁边：

```bash
git clone https://github.com/supcon-international/plantbotsimulator.git ../plantbotsimulator
```

再跑 `pnpm dev`，仿真机器人会和平台一起启动。没有它的时候机器人显示 OFFLINE，这正是生产环境的样子：等真机的适配器连上来。

只想看平台本身，不起适配器：`pnpm dev:core`。

## 界面里有什么

| 页面 | 用途 |
| --- | --- |
| OPS | 总览：KPI、实时 3D 作业地图、机队状态、最新事件 |
| LIVE | 视频墙：机器人相机和固定摄像头，RTSP 源经 go2rtc 播放 |
| TASKS | 任务模板、排程、执行记录，创建向导在地图上点航点 |
| FLEET | 机器人列表、传感器覆盖、3D 数字孪生、接入向导 |
| MAP | 作业地图：占据栅格底图、航点、区域、实时位姿，点航点即可派遣 |
| EVENTS | 事件看板与表格，检测规则的启停和阈值 |
| SITES | 新建场站，进入 Site Builder 编辑地图、航点、摄像头、坐标标定（管理员） |
| INTEG | 接入面板：签发 API key、托管连接器、自定义事件类型（管理员） |
| DOCS | 在线 API 文档（管理员） |

顶栏可以切换场站、语言和明暗主题。

## 代码怎么组织

这是一个 pnpm workspace，四个包：

```
server/         Fastify 5 后端。一个场站一个 World 实例；SQLite 持久化（node:sqlite）
web/            React 19 + Vite 8 前端，shadcn/ui 组件，three.js 做 3D 地图
integrations/   三家厂商的适配器（Spot gRPC、X30 TCP+XML、F2 云 REST+WS）和端到端测试
sdk/            写适配器用的 SDK：TypeScript 包 @plantbot/adapter-sdk，以及 Node-RED 节点
docs/           指南、集成 API、OpenAPI 定义、厂商协议参考、部署文档
scripts/        setup 下载素材、go2rtc 中继、Docker 一键演示
```

后端有两组接口：

- `/api/sites/:siteId/*`：给浏览器用，登录会话加角色控制（viewer、operator、admin）
- `/api/integration/v1/*`：给适配器和第三方系统用，带场站 API key

## 一台机器人是怎么接进来的

适配器是一个独立的小程序。它一边用厂商自己的协议和机器人说话，一边调用平台的集成 API：

1. 注册：告诉平台自己的序列号、型号、有哪些相机
2. 每秒上报一次状态：位置、电量、模式。超过 20 秒不上报，平台把它标为离线
3. 拉取订单：平台把「去某点」「跑这条路线」「暂停」「喊话」「云台」这类命令放进队列，适配器取走执行，完成后回报
4. 上报事件和读数：发现异常就发事件，可以附证据图；传感器数值按 metric 批量上报

用 SDK 写一个最小适配器大概是这样：

```ts
import { PlantbotClient, waitForSite, pumpOrders } from '@plantbot/adapter-sdk'

const pb = new PlantbotClient({ base: 'http://plantbot:8787', key: process.env.PLANTBOT_KEY! })
await waitForSite(pb)
await pb.registerUntilUp({ serial: 'MY-01', model: 'My Robot', level: 'dispatchable' })
setInterval(async () => {
  const rep = await pb.state('MY-01', { x: 0, z: 0, battery: 80, mode: 'idle' })
  await pumpOrders(pb, 'MY-01', rep, async (order) => pb.orderStatus(order.id, 'done'))
}, 1000)
```

两种跑法：

- 托管连接器：平台部署在厂内，能直连机器人。在 INTEG 面板选厂商、填机器人地址和凭证，平台把内置的适配器作为受监督子进程代跑。适用于内置的三种型号。
- 外部适配器：机器人和平台不在一个网络，或者是内置之外的型号。签发一把场站 API key，用 SDK 自己写、自己跑。

细节见 [docs/integration.md](docs/integration.md)。仓库还自带一个给 code agent 用的接入向导 [.claude/skills/robot-adapter](.claude/skills/robot-adapter/SKILL.md)，可以整个文件夹拷进你自己的工程。

## 常用命令

```bash
pnpm dev                                          # 全栈开发：后端、前端、视频中继、适配器
pnpm dev:core                                     # 只起后端和前端
WEB_BASE=/robots/ pnpm build                      # 生产构建，线上跑在子路径 /robots 下
cd server && node_modules/.bin/tsc --noEmit       # 后端类型检查
cd web && node_modules/.bin/tsc --noEmit          # 前端类型检查
cd integrations && pnpm test                      # 单元测试加全行为端到端测试（需要仿真器在旁边）
cd sdk/adapter-sdk-ts && pnpm test                # SDK 单元测试
```

## 部署

线上形态是 nginx 反代到子路径，后端设置 `PUBLIC_BASE=/robots`，前端用 `WEB_BASE=/robots/` 构建。生产不设 `PB_DEMO`，库是空的，场站在 SITES 页里建。

Linux 服务器上想一键看完整演示（含仿真机器人和视频），用 Docker：

```bash
./scripts/demo-up.sh
```

环境变量、nginx 配置、单点登录、清库重播种，都在 [docs/deploy.md](docs/deploy.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/guide.zh.md](docs/guide.zh.md) / [guide.en.md](docs/guide.en.md) | 给新读者的平台指南 |
| [docs/integration.md](docs/integration.md) | 集成 API、SDK、嵌入与单点登录 |
| [docs/openapi.yaml](docs/openapi.yaml) / [openapi-platform.yaml](docs/openapi-platform.yaml) | 机器可读的接口定义，运行中的平台也在 `/api-docs.html` 提供渲染版 |
| [docs/adapter-sim-architecture.md](docs/adapter-sim-architecture.md) | 仿真器、适配器、平台三层架构与厂商映射 |
| [docs/vendors/](docs/vendors/) | 三家厂商协议的逐字段参考 |
| [docs/platform-model.md](docs/platform-model.md) | 视频、读数、事件、任务、地图、控制六个领域的模型 |
| [docs/deploy.md](docs/deploy.md) | 生产部署与运维 |
| [CLAUDE.md](CLAUDE.md) | 给 code agent 的项目约定，与 AGENTS.md 逐字相同 |

## 平台刻意不做的事

- 不做路径规划和运动仿真，路径由机器人自己的导航栈算，平台只给目标点
- 不在平台里写任何厂商协议，全部在适配器里
- 平台没有自己的机器人，所有机器人都来自适配器的注册
