# Plantbot · Robotics Operations

工业巡检机器人管理平台。近黑科技灰 × 暖白的单色作战室美学（IBM Plex 字型体系），酸绿为唯一强调色；一键切换**明亮纸面模式**（3D 白模随主题换纸板质感，强调色自动加深保证对比度）。桌面与移动端全适配。

![stack](https://img.shields.io/badge/React_19-Vite_8-e6e8ea) ![3d](https://img.shields.io/badge/three.js-R3F_9-9aa2ab) ![video](https://img.shields.io/badge/Video-local_loops-b8ee46)

**新读者从这里开始** → 平台指南（平实语言,功能模块 / 场站中心设计 / 两种接入方式）:[中文](docs/guide.zh.md) · [English](docs/guide.en.md)。开放 API 的机器可读定义:集成面 [docs/openapi.yaml](docs/openapi.yaml) + 会话面全量 [docs/openapi-platform.yaml](docs/openapi-platform.yaml)（OpenAPI 3.0,运行中的平台在线提供 `GET /api/integration/v1/openapi.json` 与 `GET /api/openapi.json`,并在 `<BASE>/api-docs.html` 提供 **Redoc 渲染版**（双规范切换,demo: [m3rcyzzz.club/robots/api-docs.html](https://m3rcyzzz.club/robots/api-docs.html)）)。要接入新机器人/新品牌?仓库自带 **Agent Skill** [.claude/skills/robot-adapter](.claude/skills/robot-adapter/SKILL.md)——交给你的 code agent（Claude Code 等;文件夹自包含,可整体拷进自己的工程),由它引导完成外部 adapter 编写或内置厂商接入。

## 功能

| 模块 | 说明 |
|---|---|
| **OPS** 总览 | 大字 KPI、**实时 3D 作业地图**（占据主区）、fleet strip、检测流（带快照）、任务进度与最近巡检结果——视频统一收在 LIVE 页 |
| **LIVE** 视频墙 | 机器人机载相机 + 固定机位一屏聚焦或宫格;**RTSP-first**（生产源经 go2rtc 会话播放,demo 为本地零掉帧环路,含预渲染热成像 inferno 与 OGI/MWIR 通道——环路按公网出口带宽预算激进编码(640w·12fps·≤450kbps,整面视频墙数百 kbps 级)）;admin 可在页内直接**增删改固定 RTSP 摄像头**;事件快照压缩到 640w |
| **TASKS** 任务 | Mission = 航点 + 动作序列（拍照/热扫/OGI/气体采样/声学/读表）。创建向导在地图上点选航点、每站配动作；**调度器按优先级/电量/距离自动派单**（VDA5050 式整单交给 adapter）；路径由机器人端 Nav 栈计算，操作员只管目标点。步骤时间线 + 巡检结果记录（真实快照） |
| **FLEET** 机器人 | 全部经三层集成架构接入的外部机器人（波士顿动力 Spot / 云深处 X30 四足 + 高新兴 GS Patrol F2 轮式）分组管理；接入向导只列有 adaptor 的三种型号；**传感器覆盖矩阵**（optical/thermal/OGI/gas/acoustic/LiDAR × 机型）；X30 与 Spot 带官方 URDF 数字孪生（walk/trot 步态动画），GS·F2 用 silhouette；payload 3D 标注联动 |
| **MAP** 地图 | **OPS MAP** 作业地图：SLAM OccupancyGrid 栅格底图 → 主题化 canvas 渲染 + waypoint/zone/实时位姿/规划路径矢量层，点击航点即可 teleop 派遣 |
| **EVENTS** 事件 | **三列看板**（Critical / High / Routine）+ 表格视图 + **规则定义**：检测模型 × 视频源 × 置信度阈值 × severity，可新建/启停/调阈值——规则实时约束事件生成器;规则模型下拉同时提供**自定义事件类型** |
| **多场站 · 建站 UX** | 顶栏一键切换场站;每站独立 World 实例（任务调度/规则/事件流/WS 房间全隔离）。**场站是数据**：SITES 页新建场站 → **Site Builder** 地图中心编辑（上传 SLAM 占据栅格、点选航点、画区域、RTSP 摄像头、充电桩、坐标系标定）,保存即实时生效,零改码零重启。演示三站（Plant 07 / Plant 12 / Campus East）仅 `PB_DEMO=1` 首启播种 |
| **持久化 · SQLite** | 全部运行态入 `server/data/plantbot.db`（node:sqlite,零依赖）：任务历史/事件流/规则/排程/读数(7d)/订单/审计。重启不丢数据,孤儿任务由看门狗收尸;旧 config.json 自动迁移 |
| **安全** | API key 哈希存储（明文仅创建时一次）、登录限速+锁定、CORS 全移除（严格同源）、`PB_PUBLIC_VIEW=0` 全站登录门禁、用户管理 UI（角色 × 场站矩阵）、`PB_DEMO` 开关隔离演示血浆 |
| **Campus East 安防场景** | **三厂商三 adaptor 一屏协同**：波士顿动力 Spot（gRPC）+ 云深处 X30（robotserver TCP）+ 高新兴 GS Patrol F2 ×2（GoRobot 云），全部经三层集成架构接入,平台无原生机队。Checkpoint 停顿巡逻（大门→图书馆→食堂→宿舍）、周界夜巡（热成像）由排程钉给各外部机器人驱动;GS·F2 直报**可疑背包**事件;安防词表：跌倒 / 尾随 / 人员聚集 / 电动车占道,真实巡逻画面 |
| **用户与角色** | 匿名即可浏览（公开演示保留）;登录升权。三档角色 × 场站授权矩阵（Orbit/InOrbit 式）：`viewer` 只读 / `operator` 建任务·派遣·ACK / `admin` 规则·开通·集成配置。演示账户 `admin / operator / viewer`,密码 `plantbot`（生产用 `PB_*_PASSWORD` 环境变量轮换） |
| **集成开放 API** | 语义对齐 **VDA 5050**（factsheet/state/order），接入级别学 **Open-RMF**（`state-only` / `dispatchable`），地图上传走 **ROS map_server** 约定（PNG+resolution+origin,上传即在 3D 地图渲染底图）;自定义事件类型注册 + ingest + 证据抓帧服务。场站级 API Key,admin 面板管理。详见 [docs/integration.md](docs/integration.md) |
| **托管连接器 · 界面直连机器人** | INTEG 面板选厂商填**机器人地址/凭证/原生相机 rtsp://** 即接入——平台把官方 adapter 作为**受监督子进程**代跑（崩溃退避重启、日志面板、boot 自动恢复、退出级联回收）,北向走回环集成 API + 每次启动重签的内部密钥。机器人原生 RTSP 相机直接成为视频墙实时通道,含凭证 URL 只对 admin 回传;LIVE 页也可一键添加固定 RTSP 摄像头。跨网场景仍走外部 adapter + 场站 key（接入向导第一步选模式） |
| **嵌入与 SSO** | 为「被宿主 webapp 集成」而生:**OIDC/OAuth2 单点登录**（授权码+PKCE,零依赖实现,JIT 开号+角色映射,`OIDC_*` 环境变量即启用）;**iframe 无壳嵌入**（`?embed=1` 隐藏导航壳、`?site=` 钉场站,`PB_COOKIE_SAMESITE=none` 支持跨站 cookie,CSP frame-ancestors 白名单）;**双 OpenAPI**（集成面 v1 + 会话面全量,均在线 serve） |
| **adapter SDK 双形态** | `sdk/adapter-sdk-ts`（**TypeScript** `@plantbot/adapter-sdk`,零依赖,~50 行写一个 adapter;内置三厂商 adapter 就 import 它,SDK 与实战代码永不漂移）+ `sdk/node-red-contrib-plantbot`（**Node-RED** 四节点:config/robot/orders/event + 示例 flow,南向随意接 Modbus/MQTT/OPC UA 节点）——内置三型号之外的机器人由此接入 |
| **三层集成架构** | **simulator ⇄ adapter ⇄ platform**（Open-RMF fleet-adapter 式）:`integrations/` 里三家厂商 adapter（simulator 层剥离到独立仓库 [plantbotsimulator](https://github.com/supcon-international/plantbotsimulator)，自带 RTSP 视频）,**忠实还原官方协议**——Boston Dynamics Spot（59 个官方 proto,gRPC 会话舞蹈 auth→timesync→lease→estop→power 全套闸）/ 云深处 X30（robotserver_sdk 裸 TCP `EB90` 帧+XML,1003 终态语义）/ 高新兴 GS F2（GoRobot 云 `.action` RPC + WS 增量推送 + md5 登录 + 10s 流地址）。adapter 对「真机 or sim」零感知,接真机即插;全行为 e2e 套件（`cd integrations && pnpm test`,起真平台+真 sim+真 adapter,含托管连接器生命周期与开放 API）。设计见 [docs/adapter-sim-architecture.md](docs/adapter-sim-architecture.md) |

## 快速开始

前置依赖:**Node ≥ 22.22**(平台用内建 node:sqlite;react-router 8 / vite 8 要求 ≥ 22.22,推荐 Node 24 LTS)、**pnpm ≥ 9**、**ffmpeg**(素材转码与事件/RTSP 快照)。媒体中继 **go2rtc**(RTSP→MSE)由 `pnpm run setup` 自动下载进 `bin/`,`pnpm dev` 自动拉起并把 `MEDIA_RELAY` 指向它——RTSP 实时播放开箱即用,无需手工安装。

```bash
git clone https://github.com/supcon-international/plantbot.git && cd plantbot
pnpm install
pnpm run setup # 下载巡检视频素材、URDF 孪生网格（云深处 X30 官方模型 + 波士顿动力 Spot 官方 spot_description）、go2rtc 中继二进制（全自动）
pnpm dev       # server :8787 + web :5173 + go2rtc 中继 :1984 + 五个厂商 adapter（+仿真机器人若 ../plantbotsimulator 在侧）
pnpm dev:core  # 只起 server + web
```

`pnpm run setup` 幂等可重跑:资产已存在则跳过;网络抖动(CDN 限流)会自动重试。注意必须是 `pnpm run setup`——裸 `pnpm setup` 会被 pnpm 内置命令遮蔽。setup 最后一步下载 go2rtc 二进制(约 18 MB,存 `bin/`,已在 .gitignore);下载失败不阻断其余素材,RTSP 播放会保持离线直到提供中继。

## 架构

```
web/     Vite 8 · React 19 · TS · Tailwind v4 · zustand · react-router 8
         three.js + React Three Fiber 9
           - urdf-loader        → X30 + Spot 数字孪生（官方模型;GS·F2 为 silhouette）
         OpsMap：occupancy PNG → canvas 三值主题化（占据=白色激光线）
                 + 真 3D 作业地图（R3F 白模体块 + 轨道相机 + 实时 marker/路径）
         视频：demo 环路本地直出（/media Range 静态服务,原生 <video> 零转码零掉帧）；
                 真 RTSP 源经 go2rtc 会话租约播放（MSE,见 server 侧）

server/  Fastify 5 + ws + @fastify/static（/media，Range）——纯集成层,无运动仿真
           - SQLite 持久层（node:sqlite/WAL）:场站建模/任务/事件/规则/读数全入库,
             World 内存热路径 + 写穿 + 启动水合;场站运行时 CRUD（动态起停 World）
           - /api/sites/:id/*（会话+RBAC）与 /api/integration/v1（Bearer key,哈希存储）双面
           - mission 引擎：模板→排程→run；调度器按优先级/电量/能力挑外部机器人,
             整单作为 VDA5050 式订单交给 adapter,执行/暂停/中止都走订单闭环
           - 事件生成由启用中的规则驱动（PB_DEMO 限定）,快照 ffmpeg 抓帧（file 或 RTSP 直抓）
           - 视频面 RTSP-first:go2rtc 中继（MEDIA_RELAY）出 MSE 租约,demo 环路走 file 直放

integrations/  adapter 层（simulator 在独立仓库 plantbotsimulator），五个 adapter 进程
           - spot/      官方 bosdyn.api proto ×59；sim=gRPC server（lease/estop/power 闸），
                        adapter=mini bosdyn-client（会话舞蹈 + NavigateToAnchor）
                        → SPOT_PROFILE 双实例：plant-07 + campus-east
           - deeprobotics/  robotserver_sdk 线协议（TCP EB90 帧 + PatrolDevice XML）；
                        sim=X30「106 导航主机」，adapter=1002/1003/1004/1007 客户端
                        → DR_PROFILE 双实例：plant-12 + campus-east
           - gosuncn/   GoRobot 云 API（.action RPC + Token + WS 推送）；sim=伪厂商云 + F2 行为模型，
                        adapter=登录保活/告警桥/px↔米标定 → campus-east（一对驱动两台 F2）
           - test/      全行为 e2e：起真平台+真 sim+真 adapter 断言注册/遥测/派单/任务/
                        事件/读数/dock/故障/掉线恢复/线协议怪癖/托管连接器/开放 API

ffmpeg   快照抓帧：事件/任务快照直接从本地素材随机时间点截取
           - 热成像 inferno / OGI·MWIR 两路观感由 setup 预渲染成离线环路
```

地图分层遵循行业惯例（InOrbit/Formant 同款）：机器人 SLAM 产出 OccupancyGrid（ROS map_server 三值规范，free=254/unknown=205/occupied=0），后端转 PNG 位图 + 元数据（resolution/origin），前端 canvas 做主题化渲染当底图；waypoint、zone、位姿、规划路径是独立矢量层随 WebSocket 实时更新。路径规划不暴露为可编辑对象——可编辑的只有 waypoint 和 action。

