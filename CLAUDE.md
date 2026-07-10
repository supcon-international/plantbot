# CLAUDE.md

Plantbot：多场站巡检机器人运营平台演示。pnpm workspace：`server/`（Fastify 平台 + 开放集成 API）+ `web/`（Vite + React 19 SPA）+ `integrations/`（三对独立进程的 **simulator ⇄ adapter**：Spot·gRPC / 云深处·TCP+XML / 高新兴·REST+WS，见下）。

## 命令

```bash
pnpm install
pnpm run setup            # 必须带 run（裸 `pnpm setup` 是 pnpm 内置命令）；下载素材+URDF+splat，生成 .low.mp4 省流变体
pnpm dev                  # server :8787 + web :5173 + 三对 sim/adapter（9 进程全栈）
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

- 新视频通道：素材在 `scripts/setup.mjs` 登记（自动出 640p `.low.mp4` 孪生），快照抓帧源在 `server/src/frames.ts` 的 `SOURCE` 表登记。
- 仿真状态全内存（重启即复位）；持久配置（用户/API key/自定义事件类型/上传地图/外部机器人）在 `server/data/config.json`（已 gitignore，删除即重新播种）。
- 权限：匿名=viewer 只读；种子账户 `admin/operator/viewer`（默认密码 `plantbot`，生产用 `PB_*_PASSWORD` 环境变量覆盖）。写接口按 `viewer<operator<admin` × 场站授权。
- 多场站：一个 `World` 实例一个场站（`server/src/world.ts`），新场站在 `server/src/sites.ts` 加 `SiteDef` 即可（含规划器障碍、种子机队/规则/任务/自定义事件词表 `eventTypeSeeds`/排程周期 `everyMin`）。三站：plant-07 / plant-12 / campus-east。
- **三层架构（simulator ⇄ adapter ⇄ platform）**：厂商虚拟机器人不再内嵌平台进程——`integrations/` 里每家厂商一对独立 Node 进程：**sim 按官方协议还原机器人/厂商云的 server 面，adapter 面向官方协议写 client、北向翻译到 `/api/integration/v1`**（对真机即插）。三家刻意异构：Spot=机直连 gRPC 会话（59 个官方 proto vendored，auth→timesync→lease→estop→power 全套闸）、云深处 X30=裸 TCP `EB90` 帧+XML（robotserver_sdk）、高新兴 F2=厂商云 REST `.action`+WS 推送。设计与厂商映射见 `docs/adapter-sim-architecture.md`，逐字段协议参考在 `docs/vendors/`（spot-sdk / deeprobotics-robotserver / gosuncn-api）。**动 sim/adapter 前先读对应 vendors 文档——实现必须忠实官方协议，禁止臆造报文**。外部机器人落点：SPOT·A→plant-07、X30·EXT→plant-12、GS·F2×2→campus-east。
- 集成 API 见 `docs/integration.md`（含 adapter 秘钥播种 `PB_SEED_KEYS`/`PB_DEV_KEYS`、证据快照服务、订单七类 goto/mission/announce/pause/resume/abort/ptz 与 `dock:true` 语义）；部署运维见 `docs/deploy.md`。
- 集成层六域模型（视频流 Channel+StreamSession / payload Reading+metric 注册表 / 事件 Detector+lifecycle / 任务 Template-Schedule-Run / 建图 Map+Transform / 控制语义化 Command）**已全量落地**，设计与落地状态见 `docs/platform-model.md`，输入调研见 `docs/gorobot-study.md`。动这六个域先对照该文档；关键不变式：站点中心（路线/地图/检测器属于 World 不属于机器人）、流地址是会话资源、schedule 创建即生效（无「下发」步骤）。
