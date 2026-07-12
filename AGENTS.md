# AGENTS.md

Plantbot：多场站巡检机器人运营平台演示。pnpm workspace：`server/`（Fastify 平台 + 开放集成 API）+ `web/`（Vite + React 19 SPA）+ `integrations/`（三厂商的 **simulator ⇄ adapter** 独立进程对：Spot·gRPC / 云深处·TCP+XML / 高新兴·REST+WS,经 profile 起 5 对 10 进程，见下）。

## 命令

```bash
pnpm install              # 要求 Node ≥ 22.5（平台用内建 node:sqlite;Node 20 已 EOL）
pnpm run setup            # 必须带 run（裸 `pnpm setup` 是 pnpm 内置命令）；下载素材+X30/Spot URDF+splat
pnpm dev                  # server :8787（PB_DEMO=1 演示模式）+ web :5173 + 五对 sim/adapter（12 进程全栈）
pnpm dev:core             # 仅 server + web（不起集成层）
WEB_BASE=/robots/ pnpm build   # 生产构建（见下）；本地根路径构建用 pnpm build
cd server && node_modules/.bin/tsc --noEmit         # 服务端类型检查（无独立 build）
cd integrations && node_modules/.bin/tsc --noEmit   # 集成层类型检查
cd integrations && pnpm test                        # 三厂商全行为 e2e（起真平台+真 sim+真 adapter）
```

## ⚠️ 生产部署形态（改代码前必读）

本项目**线上跑在云服务器的子路径下**：`https://m3rcyzzz.club/robots`（nginx 反代 + Cloudflare tunnel）。开发时默认根路径，但**一切 URL 必须经过前缀机制**，否则本地正常、线上 404：

- **web 端**：禁止硬编码根绝对路径（`/api/...`、`/assets/...`、`/media/...`）。
  - HTTP 用 `apiFetch` / `sfetch`（`lib/store.ts`）；WS、静态资产用 `BASE`（`lib/base.ts`，来自 `import.meta.env.BASE_URL`）。
  - 生产构建：`WEB_BASE=/robots/ pnpm build`（vite `base` 读该环境变量）。
- **server 端**：凡是会**下发给客户端的 URL**（媒体、快照、地图）必须加 `PUB` 前缀（`process.env.PUBLIC_BASE ?? ''`，线上为 `/robots`）。路由注册本身**不加前缀**（nginx 负责剥 `/robots`）。
- 新增 API 路由后无需动 nginx（`/robots/api/`、`/robots/ws`、`/robots/media/` 已整段反代）；新增**顶级路径**才需要加 nginx location。

## 其他约定

- **前端组件基座 = shadcn/ui**（Tailwind v4，`web/src/components/ui/*`，别名 `@/`）。这些基元已**皮肤化为 Carbon 工业控制台**：直角（`--radius:0`）、硬偏移阴影、IBM Plex Condensed、酸绿 signal。shadcn 语义变量（`--background`/`--primary`…）在 `app.css` 里**派生自 Carbon 令牌**（`--color-*`），改设计只动 Carbon 令牌，双主题自动翻。写页面用 `Button`(variant utility/signal/outline/ghost)/`Dialog`/`Select`/`Tabs|ToggleGroup`(段控)/`Table`/`Input`/`Switch`/`Slider`/`Progress`/`Badge`，不要再手搓原生 `<button>/<select>` 或旧的 `.utility-button/.segmented-control`（已删）。`components/ui.tsx` 的 `Panel/PanelHead/Modal/SevTag/ModeChip` 是包在 shadcn 之上的领域封装，API 不变。Toast 走 sonner（`lib/notify.tsx` 渲染 Carbon 卡片）。**坑：`.panel` 类带 `position:relative`，别加到需要 `fixed` 的元素（Dialog 已规避）；React 必须单副本（19.2.7），重复副本会触发 Invalid hook call。**
- **持久层 = SQLite**（`server/data/plantbot.db`,node:sqlite/WAL,`server/src/db.ts`+`config.ts` store 层）：用户/API key(sha256 哈希,明文只在创建响应出现一次)/场站建模(sites/waypoints/zones/cameras/transforms/底图)/外部机注册/规则/模板/排程/任务/事件/订单/命令审计/读数(7d 滚动)。World 内存为热路径读模型,mutator 写穿(`Persist` 钩子),启动水合(`hydrate`+seq 恢复+僵尸 run 收尸)。旧 config.json 首启自动导入。e2e 用 `PB_DATA_DIR` 隔离。
- **生产开关**：`PB_DEMO=1`=演示模式(首启导入三演示站种子+随机事件生成器;不设=空库生产,事件只来自集成上报+阈值检测器);`PB_PUBLIC_VIEW=0`=关匿名浏览(全站登录门禁+WS 拒连);`MEDIA_RELAY=http://…:1984`=go2rtc 中继(RTSP→MSE)。CORS 已整体移除(dev 走 vite 代理,生产同源 nginx)。
- **场站是数据不是代码**：`sites.ts` 只是 PB_DEMO 首启种子;运行时增删场站走 `/api/sites` CRUD(动态起停 World+WS 房间),几何(航点/区域/摄像头/dock/bounds)在 **Site Builder**(`/sites/:id`,admin)编辑,PUT `/geometry` 实时生效(WS `geo` 帧)。摄像头填 `rtsp://` 即生产源(经 go2rtc 播放+ffmpeg 快照),留 `file` 为 demo 环路。标定 UI 在 Builder 的 CALIB 页(相似变换最小二乘,存 transforms 表,可导出 GOSUNCN_* 环境变量)。用户管理在 `/sites` 页(平台 admin)。
- 新视频通道：素材在 `scripts/setup.mjs` 登记;快照源不再有 SOURCE 表——`World.frameSource(streamKey)` 从 channel 源解析(file→media 文件 / rtsp→直抓)。
- 权限：匿名=viewer 只读(可被 PB_PUBLIC_VIEW=0 关闭)；种子账户 `admin/operator/viewer`（默认密码 `plantbot`，生产用 `PB_*_PASSWORD` 环境变量覆盖,登录有 5 次/15 分钟限速）。写接口按 `viewer<operator<admin` × 场站授权;无 `:siteId` 的平台路由(sites/users)只有 `'*'` admin 可过。**摄像头 rtsp:// URL 含凭证,只对该站 admin 回传**——对外的 fleet/channels/WS 载荷走 `publicCameras()/publicChannels()` 剥 URL(前端 `roleFor/useRole` 有 `'*'` 通配兜底,空平台的平台 admin 才能建首站)。
- 多场站：一个 `World` 实例一个场站（`server/src/world.ts`）。三演示站：plant-07 / plant-12 / campus-east。**平台是纯集成层：World 无运动仿真/A* 规划（路径规划在机器人端 Nav 栈）,机器人全部经 adaptor 的 `registerExternal` 接入；接入向导只出集成指引,不创建机器人**。规则种子绑定固定摄像头 + 外部机器人 stream；任务种子的 `requestedRobot` 钉外部机器人 id（`ext-<serial>`,未注册留队自愈）,`auto` 任务按能力/电量/距离挑在线的 dispatchable 外部机器人。
- **纯集成层 · 三层架构（simulator ⇄ adapter ⇄ platform）**：`integrations/` 里每家厂商一对独立 Node 进程：**sim 按官方协议还原机器人/厂商云的 server 面，adapter 面向官方协议写 client、北向翻译到 `/api/integration/v1`**（对真机即插）。三家刻意异构：Spot=机直连 gRPC 会话（59 个官方 proto vendored，auth→timesync→lease→estop→power 全套闸）、云深处 X30=裸 TCP `EB90` 帧+XML（robotserver_sdk）、高新兴 F2=厂商云 REST `.action`+WS 推送。设计与厂商映射见 `docs/adapter-sim-architecture.md`，逐字段协议参考在 `docs/vendors/`（spot-sdk / deeprobotics-robotserver / gosuncn-api）。**动 sim/adapter 前先读对应 vendors 文档——实现必须忠实官方协议，禁止臆造报文**。
  - **接入型号只有三种**（`ROBOT_CATALOG` in `fleet.ts`,= 有 adaptor 的型号）：Spot / Jueying X30 / GS Patrol F2。接入向导也只列这三种。
  - **场站机队分布**：plant-07 = SPOT·A；plant-12 = X30·HB；campus-east = SPOT·CE + X30·CE + GS·F2×2（三厂商三 adaptor 一屏协同）。X30/Spot 有官方 URDF 孪生(3D;Spot 的压平 URDF 在 repo 内、网格 setup 下载自 RAI spot_description),GS·F2 用 silhouette。
  - **多实例编排**：spot/deeprobotics 的 sim+adaptor 用 `SPOT_PROFILE`/`DR_PROFILE`（plant07|campus / plant12|campus）选身份+通道+场站 key,同一份代码起两个实例。`pnpm dev` 经 `integrations/scripts/dev-all.mjs` 拉起 10 进程（gosuncn 一对 + spot 两对 + deeprobotics 两对）。
- **两种接入模式**：**托管连接器**（INTEG 面板选厂商填地址/凭证/相机 rtsp:// 即接入——`server/src/connectors.ts` supervisor 把 `integrations/` 的官方 adapter 作为**受监督子进程**代跑：崩溃退避重启、200 行日志环缓、boot 自动恢复、平台退出级联回收;北向走回环集成 API + 每次 boot 重签的内部密钥,明文只在内存。adapter 侧经 `PB_SERIAL/PB_CALLSIGN/PB_DOCK_X|Z/PB_STREAMS`（bridge.ts `customProfileFromEnv`）注入身份,rtsp:// 流原样进 factsheet）与**外部 adapter**（场站 key + 北向 API,跨网/任意型号）。接入向导（FLEET→CONNECT ROBOT）第一步选模式。**Connector config 含机器人凭证,只走 admin 路由**;机器人 payload 的 rtsp URL 对外经 `publicRobots()` 剥除。
- **adapter SDK 双形态**（`sdk/`）：TypeScript `@plantbot/adapter-sdk`（workspace 包,零依赖,`integrations/shared` 是薄 re-export——SDK 源码即内置 adapter 用的客户端,不会漂移）+ Node-RED `node-red-contrib-plantbot`（config/robot/orders/event 四节点 + 示例 flow,凭证存 Node-RED credential store）。
- 集成 API 见 `docs/integration.md`（含两种接入模式、SDK 两形态、adapter 秘钥播种 `PB_SEED_KEYS`/`PB_DEV_KEYS`、证据快照服务、订单七类 goto/mission/announce/pause/resume/abort/ptz 与 `dock:true` 语义）；部署运维见 `docs/deploy.md`。**开放只读数据面**：同一把场站 key 可 GET fleet(机队+遥测)/events(过滤)/missions/schedules/channels(脱敏)/robots/:serial/readings——World 的 `telemetry()` 是 tick 的纯读版,GET 端点禁止调 tick(有调度副作用)。**OpenAPI 3.0 规范** `docs/openapi.yaml` 是唯一事实源(swagger-parser 校验过),server boot 时解析并在 `GET /api/integration/v1/openapi.json` 免鉴权 serve——改集成 API 必须同步改 yaml。平实语言双语指南 `docs/guide.zh.md`/`guide.en.md`(功能模块/厂站中心设计/两种接入),改产品形态时同步。
- 真机坐标系：dr/spot adapter 的 `toWorld/toMap` 经 `worldTransformFromEnv()`(bridge.ts,PB_TF_SCALE/THETA/TX/TZ,CALIB 页解出)做厂商 SLAM 系→世界系相似变换,默认恒等(demo 的 sim 原点即世界原点);connector 表单有对应可选字段。视频通道 CRUD:LIVE 页对 fixed camera 有 EDIT/DELETE(server PATCH/DELETE `/cameras/:camId`,服务端定点改防整组覆盖);Spot URDF 材质为白色系(SPOT_BODY/LIMB_MAT),X30 保持钢灰。
- 集成层六域模型（视频流 Channel+StreamSession / payload Reading+metric 注册表 / 事件 Detector+lifecycle / 任务 Template-Schedule-Run / 建图 Map+Transform / 控制语义化 Command）**已全量落地**，设计与落地状态见 `docs/platform-model.md`，输入调研见 `docs/gorobot-study.md`。动这六个域先对照该文档；关键不变式：站点中心（路线/地图/检测器属于 World 不属于机器人）、流地址是会话资源、schedule 创建即生效（无「下发」步骤）。
