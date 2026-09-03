# CLAUDE.md

Plantbot：多场站巡检机器人运营平台——**纯集成层**，机器人全部经 adapter 接入，平台管「巡哪里、谁去巡、发现了什么、证据在哪」。生产实例跑在 https://m3rcyzzz.club/robots（子路径，见下）。pnpm workspace 四块：

- `server/` — Fastify 5 平台：会话面 `/api/sites/:siteId/*`（RBAC）+ 开放面 `/api/integration/v1`（Bearer 场站 key）；node:sqlite 持久化；一个场站一个 `World` 实例（`server/src/world.ts`）
- `web/` — Vite 8 + React 19 SPA（shadcn/ui 皮肤化为 Carbon 工业控制台 + R3F 3D）
- `integrations/` — 三厂商 **adapter**（Spot·gRPC / 云深处 X30·TCP+XML / 高新兴 F2·REST+WS），经 profile 起五个 adapter 进程。**simulator 层已剥离到独立仓库 [plantbotsimulator](https://github.com/supcon-international/plantbotsimulator)**（三家仿真机器人 + 自带 RTSP 视频）——adapter 指向它=仿真,指向真机=生产
- `sdk/` — adapter SDK 双形态：TypeScript `@plantbot/adapter-sdk`（workspace 包，零依赖，**构建产物 `dist/`**——`pnpm install` 经包内 `prepare` + 根 `postinstall` 自动构建，`exports` 指向 dist；`integrations/shared` 是薄 re-export——内置 adapter 用的就是这个包，不会漂移）+ Node-RED `node-red-contrib-plantbot`（config/robot/orders/event 四节点 + 示例 flow，凭证存 Node-RED credential store；`plantbot-client.js` 是 SDK 的手抄 JS 副本，改 SDK 契约要同步）。SDK `pumpOrders` 语义：按 `order.id` 去重（重启重放不重复执行）；`goto/mission` 运动类对同一 serial 串行 FIFO，新运动到达先调可选 `preempt(inflight, incoming)` 钩子再等在飞单结束；`pause/resume/abort/announce/ptz` 干预类立即执行不排队；exec 处理运动类必须返回「运动真正完成才 resolve」的 Promise。

## 命令

```bash
pnpm install              # 要求 Node ≥ 22.22（react-router 8 / vite 8 要求;平台用内建 node:sqlite）；全新安装会构建 sdk/adapter-sdk-ts/dist
pnpm run setup            # 必须带 run（裸 `pnpm setup` 是 pnpm 内置命令）；下载素材+X30/Spot URDF(钉 commit)+go2rtc(bin/)+redoc(钉版本+sha256)
pnpm dev                  # server :8787（PB_DEMO=1 + PB_DEV_KEYS=1 + 固定 SESSION_SECRET + MEDIA_RELAY→:1984）+ web :5173 + go2rtc 中继 + 五个 adapter（+仿真机器人若 plantbotsimulator 在侧）
pnpm dev:core             # 仅 server + web（不起集成层）；同样带 PB_DEMO/PB_DEV_KEYS/SESSION_SECRET
WEB_BASE=/robots/ pnpm build   # 生产构建（见下）；本地根路径构建用 pnpm build
cd server && node_modules/.bin/tsc --noEmit         # 服务端类型检查（无独立 build）
cd web && node_modules/.bin/tsc --noEmit            # 前端类型检查
cd integrations && node_modules/.bin/tsc --noEmit   # 集成层类型检查
cd integrations && pnpm test                        # 先 test/unit 单测，再全行为 e2e（起真平台+真 sim+真 adapter,含托管连接器与开放 API）
cd sdk/adapter-sdk-ts && pnpm test                  # SDK 单测（订单泵去重/串行/preempt）；pnpm run build 出 dist
node scripts/record-demos.mjs                       # 录制各模块演示视频到 demos/（需 pnpm dev 在跑；scripts/build-demo.sh 合成）
```

## ⚠️ 生产部署形态（改代码前必读）

本项目**线上跑在云服务器的子路径下**：`https://m3rcyzzz.club/robots`（nginx 反代 + Cloudflare tunnel）。开发时默认根路径，但**一切 URL 必须经过前缀机制**，否则本地正常、线上 404：

- **web 端**：禁止硬编码根绝对路径（`/api/...`、`/assets/...`、`/media/...`）。
  - HTTP 用 `apiFetch` / `sfetch`（`lib/store.ts`）；WS、静态资产用 `BASE`（`lib/base.ts`，来自 `import.meta.env.BASE_URL`）。
  - 生产构建：`WEB_BASE=/robots/ pnpm build`（vite `base` 读该环境变量）。
- **server 端**：凡是会**下发给客户端的 URL**（媒体、快照、地图）必须加 `PUB` 前缀（`process.env.PUBLIC_BASE ?? ''`，线上为 `/robots`）。路由注册本身**不加前缀**（nginx 负责剥 `/robots`）。
- 新增 API 路由后无需动 nginx（`/robots/api/`、`/robots/ws`、`/robots/media/` 已整段反代）；新增**顶级路径**才需要加 nginx location。

## 架构不变式（动核心逻辑前对照）

- **纯集成层**：World 无运动仿真、无 A* 规划（路径规划在机器人端 Nav 栈）；机器人唯一来路是 adapter 的 `registerExternal`（平台侧 id = `ext-<小写化 serial>`）；接入向导只出集成指引，不创建机器人。
- **场站中心**：路线/地图/检测器/摄像头属于 World，不属于机器人。**场站是数据不是代码**——`sites.ts` 只是 PB_DEMO 首启种子；运行时 `/api/sites` CRUD 动态起停 World+WS 房间；几何（航点/区域/摄像头/dock/bounds）在 **Site Builder**（`/sites/:id`，admin）编辑，PUT `/geometry` 实时生效（WS `geo` 帧）；坐标标定在 Builder 的 CALIB 页（相似变换最小二乘 → transforms 表，可导出 adapter 环境变量）；用户管理在 `/sites` 页（平台 admin）。
- **六域模型已全量落地**（视频流 Channel+StreamSession / payload Reading+metric 注册表 / 事件 Detector+lifecycle / 任务 Template-Schedule-Run / 建图 Map+Transform / 控制语义化 Command）——动这六域先对照 `docs/platform-model.md`。关键：流地址是**会话资源**（TTL/续期/撤销）；schedule **创建即生效**（无「下发」步骤）；坐标对外**只有世界系一个出口**（其余坐标系经 Transform 在服务端换算）。
- **调度**：`auto` 任务按能力/电量/距离挑在线的 dispatchable 外部机器人；显式钉死（任务 `requestedRobot` / 排程 `assign:{kind:'robot'}`）的机器人未注册/离线时任务留队（订单队列是缓冲），**已有在跑任务（nav.missionId）时同样留队**，不会双发 mission 订单；**只有 `mission` 类订单的完结才结算平台侧任务**（pause/resume/abort 只是引用）。
- **视频 RTSP-first**：摄像头/机器人流填 `rtsp://` 即生产源（经 go2rtc 播放、ffmpeg 快照），`file` 为 demo 环路；素材在 `scripts/setup.mjs` 登记；快照源由 `World.frameSource(streamKey)` 从 channel 源解析（rtsp 快照用 `-rtsp_transport tcp -timeout`，死源快速失败）。**go2rtc 中继开箱即用**：setup 下载二进制进 `bin/`，dev 经 `scripts/relay.mjs` 起在 :1984 并设 `MEDIA_RELAY`；`media.ts` 每 15s 探测 `<relay>/api` 保持 `relayOnline` 诚实（探测失败/流注册失败即 false，`openSession` 已 await 注册结果）；vite/nginx 反代 `/stream`→:1984。LIVE 页有固定摄像头增删改（server 端 POST/PATCH/DELETE `/cameras/:camId` 定点改，防止看不到 rtsp 明文的客户端整组覆盖）；播放会话是租约，前端 120s 前自动 renew、卸载即 close。

## 持久层与生产开关

- **SQLite**（`server/data/plantbot.db`，node:sqlite/WAL；`server/src/db.ts` + `config.ts` store 层）：用户 / API key（sha256 哈希，明文只在创建响应出现一次）/ 场站建模（sites/waypoints/zones/cameras/transforms/底图）/ 外部机注册 / 规则 / 模板 / 排程 / 任务 / 事件 / 订单 / 命令审计 / 读数（7d 滚动）。World 内存为热路径读模型，mutator 写穿（`Persist` 钩子），启动水合（`hydrate`+seq 恢复+僵尸 run 收尸）；**acked 未完结订单在重启时重新入队**——adapter 可能收到重复单，SDK `pumpOrders` 按 `order.id` 去重，自写 adapter 需容忍。**boot 重放的外部机器人一律先 OFFLINE**（`registerExternal(rec, {online:false})`，lastSeen=0），adapter 首次 POST /state 才上线——避免重启后假在线 20 s 被 auto 派单。`inTx` 可嵌套（深度计数，只在最外层 BEGIN/COMMIT）；readings 表有 `idx_readings_ts` 供 7d 滚动删除（SCHEMA_VERSION 4）。旧 config.json 首启自动导入。e2e 用 `PB_DATA_DIR` 隔离。
- **开关**：`PB_DEMO=1` = 演示模式（首启导入三演示站 plant-07 / plant-12 / campus-east 种子——含绑定摄像头与机器人流的规则、钉死外部机器人的排程——并跑随机事件生成器；不设 = 空库生产，事件只来自集成上报+阈值检测器）；`PB_PUBLIC_VIEW=0` = 关匿名浏览（全站登录门禁+WS 拒连）；`MEDIA_RELAY=http://…:1984` = go2rtc 中继（RTSP→MSE）；`OIDC_ISSUER`+`OIDC_CLIENT_ID`(±`OIDC_CLIENT_SECRET`/`OIDC_DEFAULT_ROLE`/`OIDC_ADMIN_USERS`) = 启用 SSO；`PB_COOKIE_SAMESITE=none` = 跨站 iframe cookie（强制 Secure）。CORS 已整体移除（dev 走 vite 代理，生产同源 nginx）。

## 权限与凭证红线

- 角色 `viewer < operator < admin` × 场站授权；匿名 = viewer 只读（可被 PB_PUBLIC_VIEW=0 关闭）。无 `:siteId` 的平台路由（sites/users）只有 `'*'` admin 可过（前端 `roleFor/useRole` 有 `'*'` 通配兜底，空平台的平台 admin 才能建首站）。种子账户 `admin/operator/viewer`（默认密码 `plantbot`，生产用 `PB_*_PASSWORD` 环境变量覆盖；登录 5 次/15 分钟限速）。**OIDC SSO**（`server/src/oidc.ts`，零依赖授权码+PKCE，回调**强制校验 nonce**）：JIT 建号（`OIDC_DEFAULT_ROLE` 默认 viewer，`OIDC_ADMIN_USERS` 清单开 `'*'` admin，仅创建时生效），SSO 用户本地密码为随机值；mock IdP 在 `integrations/test/mock-idp.ts`。会话/state cookie 的 HMAC 用 `safeStrEqual`（timingSafeEqual）比较；`SESSION_SECRET` 未设时启动 warn 一次（多实例/重启会话失效）。
- **rtsp:// URL 内嵌凭证，只对该站 admin 回传**：对外的 fleet/channels/WS/开放 API 载荷一律经 `publicCameras()/publicChannels()/publicRobots()` 剥除；connector config 含机器人凭证，只走 admin 路由。

## 集成层

**动 sim/adapter 前先读 `docs/vendors/` 对应文档——实现必须忠实官方协议，禁止臆造报文。**

- **三层架构** simulator ⇄ adapter ⇄ platform（设计与厂商映射见 `docs/adapter-sim-architecture.md`）：sim 按官方协议还原机器人/厂商云的 server 面，adapter 面向官方协议写 client、北向翻译到 `/api/integration/v1`（对真机即插）。三家刻意异构：Spot = 机直连 gRPC 会话（59 个官方 proto vendored，auth→timesync→lease→estop→power 全套闸）、X30 = 裸 TCP `EB90` 帧+XML（robotserver_sdk）、F2 = 厂商云 REST `.action`+WS 推送。
- **接入型号只有三种**（`ROBOT_CATALOG` in `fleet.ts` = 有 adapter 的型号）：Spot / Jueying X30 / GS Patrol F2，向导也只列这三种。云深处另有官方**智巡平台 Station OpenAPI**（2026-07 发布，任务模板/排程/识别结果/告警/云台/回充/地图面，`/remoteApi/*` + RocketMQ），当前 X30 adapter 只接底层 robotserver 导航面，Station 是候选第二条接入路径（见 `docs/adapter-sim-architecture.md` §3.4，未实现）；优必选无公开机队运营 API（§3.5）。场站机队分布：plant-07 = SPOT·A；plant-12 = X30·HB；campus-east = SPOT·CE + X30·CE + GS·F2×2（三厂商一屏协同）。X30/Spot 有官方 URDF 孪生（Spot 为白色系材质 SPOT_BODY/LIMB_MAT、压平 URDF 在 repo 内、网格 setup 下载；X30 钢灰），GS·F2 用 silhouette。
- **多实例编排**：spot/deeprobotics 用 `SPOT_PROFILE`/`DR_PROFILE`（plant07|campus / plant12|campus）选身份+通道+场站 key，同一份代码起两实例；`pnpm dev` 经 `integrations/scripts/dev-all.mjs` 拉起五个 adapter，并在 `../plantbotsimulator`（或 `PLANTBOT_SIM_DIR`）存在时连仿真机器人一起拉起（否则只跑 adapter，机器人 OFFLINE=生产形态）。e2e 模式见 `integrations/test/harness.ts`：临时端口 + `PB_DATA_DIR` 起真平台，`standUpVendor` 一站式厂商 fixture；sim 从 sibling 解析（`simsAvailable()` 缺失即 skip 厂商行为套件，平台/SSO 套件照跑）。
- **两种接入模式**（向导 FLEET→CONNECT ROBOT 第一步选）：**托管连接器**——`server/src/connectors.ts` supervisor 把 `integrations/` 的官方 adapter 作为**受监督子进程**代跑（崩溃退避重启、200 行日志环缓、boot 自动恢复、平台退出级联回收：SIGTERM 2 s 后 SIGKILL 兜底），北向走回环集成 API + 每次 boot 重签的内部密钥（明文只在内存）；**子进程只继承白名单 env**（PATH/HOME/TMPDIR/LANG/TZ/NODE_OPTIONS/证书与代理变量），其余全部显式注入——身份经 `PB_SERIAL/PB_CALLSIGN/PB_DOCK_X|Z/PB_STREAMS`（bridge.ts `customProfileFromEnv`），rtsp:// 流原样进 factsheet。**外部 adapter**——场站 key + 北向 API，跨网/任意型号。adapter 南向重连一律 `makeBackoff()`（bridge.ts，1 s 起封顶 30 s）。高新兴 adapter 的 goto/mission **先 `changeControl(carmode=1)` 切手动**再 `navigateToPoint`（手动模式下到点驻留），到点判定 = 最近逼近锁存或 `taskType=standBy` 信号，280 ms 自采样。
- **真机坐标系**：dr/spot adapter 的 `toWorld/toMap` 经 `worldTransformFromEnv()`（bridge.ts，`PB_TF_SCALE/THETA/TX/TZ`，CALIB 页解出）做厂商 SLAM 系→世界系相似变换，默认恒等（demo 的 sim 原点即世界原点）；connector 表单有对应可选字段。
- **开放数据面**：同一把场站 key 可只读 GET fleet（机队+遥测）/ events（过滤，走 SQLite `queryEvents` 不受内存环 400 条限制）/ missions / schedules / channels（脱敏）/ robots/:serial/readings——World 的 `telemetry()` 是 tick 的纯读版，**GET 端点禁止调 tick**（有调度副作用）。key 有效但场站 World 未加载 → `404 {error:'site not loaded'}`；分页参数一律 `clampInt`（events 1..500、readings 1..1000）；排程 cadence 入口校验（weekly `HH:MM`/days 0-6、interval everyMin>0）不合法 400。**OpenAPI 双规范都是事实源**：集成面 `docs/openapi.yaml`（`GET /api/integration/v1/openapi.json`）+ 会话面全量 `docs/openapi-platform.yaml`（`GET /api/openapi.json`），boot 时解析、免鉴权 serve——**改任一面的 API 必须同步对应 yaml**。`GET /site` 含 metric 注册表，`GET /maps`（集成面）回底图+标定变换。adapter 秘钥播种 `PB_SEED_KEYS`/`PB_DEV_KEYS`、订单七类（goto/mission/announce/pause/resume/abort/ptz）与 `dock:true` 语义、证据快照服务见 `docs/integration.md`。

## 前端约定

- **组件基座 = shadcn/ui**（Tailwind v4，`web/src/components/ui/*`，别名 `@/`），已**皮肤化为 Carbon 工业控制台**：直角（`--radius:0`）、硬偏移阴影、IBM Plex 三字重分工——Condensed 只做标题、Sans 做标签与正文、Mono 只做数据（id/坐标/数值/时间/通道名）。**酸绿 signal 只用于两处：主动作按钮与「在线/活动」指示**（live-dot、导航当前项、选中态）；状态胶囊/电量条/火花线/面板头一律中性令牌（`.microlabel` 是句首大写 Sans，不是全大写 mono；Badge 基类同样句首大写，只有 `micro` 变体保留 mono 大写给 id）。没有页面级网格纹理（只有 3D 地图自己画的 4 m 栅格）；空态用 `EmptyNote` 写成句子（可带 action），不用全大写占位语；火花线在数据平直时由 `Spark` 自动显示「steady」。shadcn 语义变量（`--background`/`--primary`…）在 `app.css` 里**派生自 Carbon 令牌**（`--color-*`），改设计只动 Carbon 令牌，双主题自动翻。写页面用 `Button`(variant utility/signal/outline/ghost)/`Dialog`/`Select`/`Tabs|ToggleGroup`(段控)/`Table`/`Input`/`Switch`/`Slider`/`Progress`/`Badge`，不要手搓原生 `<button>/<select>/<input type=checkbox>`；确认/输入框用 `components/ConfirmDialog.tsx` 的 `useConfirm()`（返回 Promise，删除类传 `destructive`），禁止 `window.confirm/prompt`。`components/ui.tsx` 的 `Panel/PanelHead/Modal/SevTag/ModeChip` 是包在 shadcn 之上的领域封装。Toast 走 sonner（`lib/notify.tsx` 渲染 Carbon 卡片）。重后台页（SiteBuilder/Integrations/Docs/Sites）在 `App.tsx` 走 `React.lazy` + 骨架 fallback，新增重页照此分包。`useT()` 返回的 `t` 按 lang 稳定（可安全进 memo 依赖）。**iframe 嵌入**：`?embed=1` 去壳模式（隐藏顶栏/侧栏，**保留一条紧凑模块导航条** `EmbedNav`，`?embednav=top|bottom|hidden` 控制其位置或隐藏；tab 会话粘滞，`?embed=0` 退出）+ `?site=` 钉场站（main.tsx 在 WS 连接前应用）。**坑：`.panel` 类带 `position:relative`，别加到需要 `fixed` 的元素（Dialog 已规避）；React 必须单副本（19.2.7），重复副本会触发 Invalid hook call。**

## 文档地图（改动时的同步义务）

| 文档 | 是什么 | 何时同步 |
| --- | --- | --- |
| `docs/guide.zh.md` / `guide.en.md` | 新读者双语指南（功能模块/场站中心/两种接入） | 改产品形态 |
| `docs/integration.md` + `docs/openapi.yaml` | 集成 API 文字版（含嵌入与 SSO 节）+ 集成面机器可读事实源 | 改集成 API（yaml 必须同步） |
| `docs/openapi-platform.yaml` | 会话面全量 OpenAPI（auth/SSO/场站/任务/事件/媒体/连接器） | 改会话面 API |
| `docs/adapter-sim-architecture.md` | 三层架构、厂商映射、进程拓扑、e2e 面 | 改集成层结构 / 新增厂商 |
| `docs/vendors/*` | 三厂商逐字段协议参考 | 动 sim/adapter **前必读** |
| `docs/platform-model.md` | 六域模型设计+落地状态（输入调研：`gorobot-study.md`） | 动六域 |
| `docs/deploy.md` | 生产部署/运维/建站交付/清库重播种 | 改部署形态或恢复语义 |
| `.claude/skills/robot-adapter/` | 接入配置 Agent Skill（自包含、可整体拷出仓库）；`.agents/skills/robot-adapter/` 是给 Codex 类 agent 的**逐字镜像** | 改集成 API / SDK / connector 目录（两份一起改） |
| `README.md` | 面向初级开发者的项目入口（是什么/五分钟跑起来/目录/接入方式/命令） | 改命令、目录或接入形态 |

CLAUDE.md 与 AGENTS.md 保持逐字镜像（仅标题行不同）。
