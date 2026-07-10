# Plantbot 集成层设计:API 层与模块关系模型

> 输入:[gorobot-study.md](gorobot-study.md)(高新兴量产平台的功能面貌与反面清单)+ Plantbot 现状
> (`server/src/world.ts` / `sites.ts` / `fleet.ts` / integration API v1)。
> 目标:定义视频流、payload 数据、事件、CV 算法事件、任务、建图六个域的**目标模型**,
> 让任何厂商机器人(含 GoRobot 这种 RPC 风格的)都能被一个薄 adapter 优雅接入。

## 0. 设计原则

从 GoRobot 的教训直接导出:

1. **站点中心,不是机器人中心。** 地图、航点、路线模板、检测器都属于 World(site);机器人是可调度、
   可替换的资源。GoRobot 把这些挂在单机上,导致路线不能跨机复用、多机协同无从谈起。
2. **一切皆资源,命名一次定义。** 机器人在所有接口里都叫 `robotId`(外部序列号 `serial` 只出现在
   integration 边界)。不允许出现 GoRobot 式 deviceId/modelId/deviceCode 漂移。
3. **信封稳定,负载开放。** 遥测、读数、事件都是「稳定信封 + 开放字典」:新增传感器/算法/事件类型
   永远是**数据**(注册表登记),不是 schema 变更。GoRobot 的 80 字段平铺状态是反例。
4. **有生命周期的东西建模成会话/状态机,不是 getter。** 流地址、对讲、遥操作、任务执行,都有
   开始-存续-结束;服务端持有状态机并校验前置条件(GoRobot 让客户端保证「先切手动模式」「每 200ms 重发」)。
5. **坐标只有一个出口。** 对外一律 site 世界系(x/z 米,y 向上);其余坐标系(占据栅格像素、WGS84、
   厂商激光图)通过显式 Transform 资源换算,换算在服务端。绝不把「height − y 自己翻」写进文档。
6. **为误报洪水设计。** 单条巡逻计划 3746 条告警是行业常态。事件必须有:分诊生命周期、复核流水线
   (含 LLM 二次确认)、可信度标注、证据留存(训练回流)。
7. **南北向分离。** 南向(机器人→平台)走 `/api/integration/v1`(Bearer key,VDA 5050 语义);
   北向(UI/第三方)走 `/api/sites/:siteId/*`(会话 + RBAC)。两边共享同一套领域对象。

## 1. 模块关系模型

```
Site (World)
├─ Map[]            occupancy | splat | aerial     ←— integration: 地图上传
│   └─ Transform[]  mapFrame ↔ world ↔ wgs84       (标定即资源)
├─ Waypoint[] / Zone[]                              (site 级,非机器人私产)
├─ Robot[]  adapter: sim | external
│   ├─ Channel[]    video/audio 通道 (role/codec)   ←— factsheet 声明
│   │   └─ StreamSession   显式 TTL/续期/撤销
│   ├─ Payload[]    挂载的传感器包
│   │   └─ Reading  {metric, value, unit, ts}      ←— integration: 批量上报
│   ├─ Telemetry    位姿/电量/模式 (稳定信封)
│   └─ Command 队列 goto/dock/announce/ptz…        —→ integration: 拉单/回执
├─ Detector[]  rule | onboard-cv | cloud-cv | threshold (+ LLM verify 开关)
│   └─ 绑定 EventType + Zone/Waypoint + Robot?
├─ EventType[]      内建 + 自定义词表
├─ Event 流         信封 + evidence[] + verification + lifecycle
│        ↑ 来源:Detector 触发 / MissionRun 采集 / integration 直报
├─ MissionTemplate[]   waypoint 序列 × 各点 actions[]  (路线=模板,site 级)
├─ Schedule[]          cron/interval/once → 生成 Run  (排程与模板解耦)
└─ MissionRun[]        执行实例:progress + captures[] ——runId 关联 Event
```

关联关系(GoRobot 用 `patrolId` 串起告警↔巡逻,我们显式化):

- `Event.runId?` → MissionRun;`Event.detectorId?` → Detector;`Event.evidence[].channelId?` → Channel。
- `MissionRun.captures[]` 中「判定为异常」的项**就是**一条 Event(同一 id,不是两张表)。
- `Reading` 超阈值由 threshold-Detector 转化为 Event —— 传感器数据与事件之间只有这一条通路。

## 2. 六个域的目标形状

### 2.1 视频流(Channel + StreamSession)

现状:`PayloadSpec.file/stream` 把「演示 mp4」和「流」混在 payload 里;UI 直接拿文件地址。

目标:通道从 payload 中独立(GoRobot 通道模型是对的,资源化是我们的改进):

```ts
interface Channel {
  id: string            // 'r1/front'
  robotId: string
  role: 'front' | 'rear' | 'left' | 'right' | 'ptz' | 'thermal' | 'ogi' | 'audio'
  label: string
  codec: 'h264' | 'h265' | 'mjpeg' | 'opus'
  source:               // 平台侧如何取到它(UI 永远不感知)
    | { kind: 'file'; file: string }              // 演示循环
    | { kind: 'rtsp'; url: string }               // 真机,经 go2rtc 网关转 webrtc/hls
    | { kind: 'webrtc'; sdpEndpoint: string }
  ptz?: { pan: [number, number]; tilt: [number, number]; zoom: number }
}
```

- `GET  /api/sites/:s/robots/:id/channels` — 通道清单。
- `POST /api/sites/:s/channels/:chId/sessions` → `{ url, protocol, expiresAt }` — **显式会话**:
  TTL 明说、`DELETE` 撤销、到期前 `POST …/renew`。对演示 file 源,session 直接返回静态 url、
  `expiresAt: null` —— 同一契约同时覆盖演示与真机,UI 不分叉。
- 快照:`GET /channels/:chId/snapshot`(现 frames.ts 逻辑归入 channel)。
- 对讲(远期):`POST /channels/:audioChId/talk-sessions`,同一会话模式(GoRobot 三步协议的资源化)。

南向:factsheet 声明通道(`POST /integration/v1/robots` 增加 `channels[]`),平台生成 Channel 资源。
厂商流协议差异(GoRobot 的 websocket-flv、10 秒时效 url)由 adapter 在 session 创建时现取现换,
**时效性契约被会话模型吸收**,不泄漏给 UI。

### 2.2 Payload 数据(Reading 信封 + Metric 注册表)

现状:`Telemetry` 固定字段 + `payloadHealth`;没有时序读数通道。GoRobot 的反例:每种传感器一个字段。

目标:

```ts
interface MetricDef {              // site 级注册表,payload 目录携带默认集
  id: string                       // 'ch4.ppmm' | 'rad.gamma.cps' | 'noise.db' | 'temp.c'
  label: string; unit: string
  kind: 'gauge' | 'counter' | 'enum'
  nominal?: [number, number]       // 正常带,UI 画带用
}
interface Reading {                // 稳定信封 —— 永不因新传感器而改
  robotId: string; payloadId: string
  metric: string; value: number | string
  ts: number; quality?: 'ok' | 'degraded' | 'stale'
  wp?: string                      // 采集时所在航点(巡检读数天然带位置)
}
```

- 南向:`POST /integration/v1/robots/:serial/readings`(批量数组,幂等按 ts+metric)。
- 北向:`GET /robots/:id/readings?metric=&since=&limit=` + WS 增量帧 `{t:'readings', items:[…]}`。
- 存储:World 内存环形缓冲(每 metric 保留最近 N 点)——演示平台够用,真库是实现细节。
- `Telemetry` 保持现状(位姿/电量/模式是**平台语义**,不塞传感器);GoRobot 平铺的 80 字段
  在 adapter 里拆解:位姿/电量 → state,α 射线/CO2/噪声 → readings,故障码 → events。

### 2.3 事件 & CV 算法事件(Detector + Event 升级)

现状:`DetectionRule`(model/source/zone/threshold/severity)+ `DetectionEvent`(acked 单一生命周期)。
这已是「规则产生事件」的正确骨架;缺的是 GoRobot 用血泪长出来的部分——分诊、复核、证据。

目标(在现有接口上**增量扩展**,不推翻):

```ts
interface Detector extends DetectionRule {        // rule 更名泛化,兼容别名保留
  kind: 'sim' | 'onboard-cv' | 'cloud-cv' | 'threshold' | 'external'
  metric?: string; op?: '>' | '<'; bound?: number // threshold 型:Reading → Event 的通路
  verify?: {                                       // GoRobot needLargeModel 的泛化
    mode: 'none' | 'llm' | 'human'
    promptTemplate?: string                        // 「图中是否有人在钓鱼」
    referenceImage?: string
  }
}
interface Event extends DetectionEvent {
  lifecycle: 'new' | 'acked' | 'resolved' | 'dismissed'   // acked:boolean 的超集
  verification?: { state: 'pending' | 'confirmed' | 'rejected'; by: 'llm' | string; note?: string }
  evidence: { kind: 'image' | 'clip' | 'reading'; url?: string; channelId?: string; reading?: Reading }[]
  runId?: string                                   // 关联 MissionRun(GoRobot patrolId 的显式化)
  category: 'security' | 'fire' | 'env' | 'equipment' | 'robot-fault'   // 分流:业务 vs 本体
}
```

- 生命周期:`POST /events/:id/ack | resolve | dismiss`(dismiss 保留 evidence → 负样本导出
  `GET /events/export?lifecycle=dismissed`,GoRobot algorithmDetectionImage 训练回流的对应物)。
- 复核:verify.mode='llm' 的事件先进 `verification:pending`,平台(演示:模拟;真实:调 LLM)
  给出 confirmed/rejected;UI 的未处理队列**默认只看 confirmed**——误报洪水的闸门。
- `robot-fault` 类别承接 GoRobot AlarmRunInfo(50101 位置丢失等):同一 Event 流,
  UI 按 category 分栏,不另建「运行告警」体系。
- 南向直报:现有 `POST /integration/v1/events` 增加可选 `evidence[]/category/detectorRef`。

### 2.4 任务(Template / Schedule / Run 三层)

现状:`Mission` 一个对象承担三件事(requestedRobot + recurring + steps + results)。
GoRobot 的对应物是 路线/计划/执行记录 三个概念但耦在单机上、创建与下发两步。

目标:拆三层,全部 site 级:

```ts
interface MissionTemplate {        // “路线” —— 可复用、不绑机器人
  id: string; name: string
  steps: MissionStep[]             // 现有 waypointId + actions[] 原样保留
  requires?: PayloadSpec['kind'][] // 能力需求:['thermal'] —— 谁能跑由平台匹配
}
interface Schedule {               // “计划” —— 排程与模板解耦
  id: string; templateId: string
  cadence: { kind: 'once' } | { kind: 'interval'; everyMin: number }
         | { kind: 'weekly'; days: number[]; at: string }     // GoRobot 周日历的对应物
  assign: { kind: 'auto' } | { kind: 'robot'; robotId: string }  // auto = 按 requires 匹配
  enabled: boolean
}
interface MissionRun {             // “执行” —— 即现有 Mission,改名+补字段
  …现有 Mission 字段
  templateId?: string; scheduleId?: string
  captures: MissionResult[]        // 现有 results:点位级进度流(GoRobot capture 的对应物)
}
```

- 创建即生效:`POST /schedules` 后由 World.tick 到点生成 Run 并入队调度——**没有「下发」这一步**;
  adapter 机器人则由平台推 order(现有 AdapterOrder 队列),状态回执驱动 Run 前进。
- 点位进度:现有 `MissionResult`(stepIdx/waypointId/action/ok/note/snapshot)已经是
  GoRobot 点位 capture 的正确形状;补一条:`ok:false` 或检出异常时**同时产生 Event(带 runId)**。
- 临时任务:现有 `createMission`/`teleopGoto` 即「跑一次模板/去一个点」,平台校验机器人状态
  (充电中/已有任务→排队或拒绝),不像 GoRobot 要求调用方先切模式。

### 2.5 建图(Map + Transform)

现状:site 单张 occupancy(ROS 约定 origin/resolution)+ splat 场景写死前端;已优于 GoRobot
(坐标只有 world 一个出口,UI 从不翻转)。

目标:多地图 + 显式变换:

```ts
interface MapAsset {
  id: string; kind: 'occupancy' | 'splat' | 'aerial'
  name: string; url: string                       // 完整可访问 url(带 PUB 前缀)
  occupancy?: { resolution: number; origin: [number, number, number]; w: number; h: number }
}
interface Transform {                              // 标定即资源
  from: string; to: string                         // 'map:xxx' | 'world' | 'wgs84'
  kind: 'similarity'                               // s·R·p + t
  params: { s: number; thetaRad: number; t: [number, number] }
}
```

- `GET /api/sites/:s/maps` 列出全部底图(occupancy/splat/aerial),UI 图层选择器数据源;
  现有 integration 地图上传自动登记为 `kind:'occupancy'` 的 MapAsset + 一条 identity Transform。
- 厂商激光图(GoRobot mapName 像素系)接入:adapter 上传图 + 标定 Transform,
  此后该厂商机器人上报的像素坐标由平台换算成 world 再入库——**换算只发生一次、在边界上**。
- splat 场景从前端硬编码挪进 maps 清单(url + 初始相机位),为多场景切换留位。

### 2.6 控制(Command 语义化)

现状:`teleopGoto` + adapter order 队列。GoRobot 反例:方向枚举 + XML in query + 客户端 200ms 重发。

目标:统一命令资源,服务端校验与兜底:

```ts
type Command =
  | { type: 'goto'; wp: string }
  | { type: 'dock' }
  | { type: 'pause' } | { type: 'resume' } | { type: 'abort' }
  | { type: 'announce'; text: string; priority?: number }     // GoRobot 喊话的对应物
  | { type: 'ptz'; channelId: string; pan?: number; tilt?: number; zoom?: number }  // 绝对量,非步进
  | { type: 'velocity'; vx: number; wz: number; deadmanMs: 400 }  // 服务端超时自动置零
```

- `POST /api/sites/:s/robots/:id/commands` → `{ commandId, accepted, reason? }`;
  前置条件(急停按下、离线、低电)服务端拒绝并给 reason。
- velocity 的 deadman 在**平台侧**:超时未续 → 自动下发停;客户端只表达意图。
- 南向:命令进现有 AdapterOrder 队列,外部机器人 `GET /orders` 拉单 + `POST /orders/:id/status` 回执。

## 3. 落地状态(2026-07-10 全量实施)

**✅ P0 — 已落地**
1. Event 升级:lifecycle 四态(ack/resolve/dismiss 端点)+ category(含 robot-fault 流)+ evidence[]
   + runId 回链(MissionResult 异常项自动生成带 runId 的 Event)。
2. ~~Detector.verify(LLM 二次复核)~~ **已实现后于 2026-07-10 按产品决定移除**——demo 阶段
   模拟裁决价值有限;误报治理由 lifecycle 的 dismiss(证据保留,`GET /events/export` 仍可导负样本)
   承担。未来接真实多模态复核时按原设计恢复:Detector 加 verify 字段 + Event 加 verification 态。
3. Mission 拆 Template/Schedule/Run:种子 recurring 任务全部改由 schedule 驱动;
   requires 能力匹配进入 auto 指派;pause/resume。

**✅ P1 — 已落地**
4. Channel 资源(payload/site-camera 派生)+ StreamSession 契约(`POST /channels/:id/sessions`,
   file 源 `expiresAt:null`,live 源 120s 可续期);Live 页全量改走 sessions。
5. Reading 信封 + METRIC_DEFS 注册表 + 仿真时序(每 3s,巡检中带 wp 上下文)
   + Robot 详情 Payload Telemetry 面板;threshold-Detector 通路(带 180s 冷却)。
6. Schedule 层(once/interval/weekly)+ auto 指派;创建即生效,无「下发」步骤。

**✅ P2 — 平台侧已落地,adapter 参考实现待真机**
7. `GET /maps` 清单(occupancy/splat)+ Transform 资源(像素→world、world→wgs84 演示锚点);
   splat 从前端硬编码迁入 SiteDef,无扫描站点自动降级 ops 图层。
8. integration v1 扩展:`POST /robots/:serial/readings` 批量上报、events 接受
   evidence/category/runId。GoRobot adapter 参考实现(tk 保活、getVideoUrl 换 session、
   80 字段拆 state/readings/events 三流)留待真机接入时验证。

## 4. 明确不做

- **iframe 嵌入集成**(token in URL):Plantbot 是 API-first,第三方要 UI 自己拿数据画。
- **每设备类型一个模块**(电梯/空开/消防柜管理页):非机器人设备一律走 integration API 的
  state+events,是「外部数据源」,不是新模块。
- **PDS/VDS 双算法栈**:Detector 一张表,media kind 是字段不是体系。
- **平台级「下发」按钮**:配置生效靠状态机与版本号,不靠人肉同步动作。
