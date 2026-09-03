# Simulator / Adapter / Platform 三层架构

> 2026-07。把「虚拟机器人」从平台进程里抽出来，变成 **simulator ⇄ adapter ⇄ platform** 三个独立层：
> adapter 面向**厂商官方协议**编写（换真机即插）,simulator 按同一份官方协议**还原机器人端**（无真机可开发），
> 平台只暴露一套开放集成 API。三家厂商三种协议形态，全部忠实还原官方文档，不做臆造。
> 厂商协议参考（实现级逐字段）：[spot-sdk.md](vendors/spot-sdk.md) ·
> [deeprobotics-robotserver.md](vendors/deeprobotics-robotserver.md) · [gosuncn-api.md](vendors/gosuncn-api.md)。

## 1. 为什么是这三层（前沿实践对照）

| 实践 | 形状 | 我们的对应 |
| --- | --- | --- |
| **Open-RMF fleet adapter** | RMF core 不懂任何厂商协议;每个机队一个 adapter 进程,南向说厂商话、北向说 RMF 话;官方用 `rmf_demos` 的 mock fleet 做无真机开发 | platform=RMF core,adapter=fleet adapter,simulator=mock fleet |
| **VDA 5050** | Master Control ⇄ AGV 之间只有标准消息(factsheet/state/order/instantAction),厂商差异被压到车端固件/网关 | 平台集成 API 的 factsheet/state/orders 语义即 VDA 5050 式 |
| **Formant / InOrbit agent** | 云平台定义稳定 ingest 协议,厂商侧跑一个 agent 进程做翻译;agent 掉线=机器人 offline | adapter 进程=agent;state 上报兼作心跳(20s 判 offline) |
| **sim-in-the-loop**(Gazebo/Isaac/Webots 的 HIL 替身) | 被测软件面向真实接口,硬件换成行为等价的仿真端 | simulator 实现**官方 server 面**,adapter 完全不知道对面是不是真机 |

核心不变式：**adapter 对「真机 or sim」零感知**。它按官方文档做会话、发指令、收状态；
sim 的唯一职责是把官方协议的 server 面演到以假乱真（包括协议里的坏脾气——见 §3 各厂商「忠实还原的怪癖」）。

## 2. 拓扑与进程（两仓库）

**simulator 层已剥离到独立仓库 [`plantbotsimulator`](https://github.com/supcon-international/plantbotsimulator)**——
它是「台架上的假机队」:三家仿真机器人（按官方协议还原）+ 自带视频经 go2rtc 以 **RTSP** 对外服务
（`rtsp://…:8554/<camera>`,机器人相机成为真实可拉取的 RTSP 源）。plantbot 本仓库只留 **adapter**
（受监督子进程即托管连接器代跑的那份;接真机时也是这份）。adapter 对「真机 / 仿真机器人」零感知——
指向 plantbotsimulator 就是仿真,指向真机就是生产。

```
┌──────────── plantbot (this repo) ────────────┐   ┌──── plantbotsimulator (sibling repo) ────┐
│ server :8787 (纯集成层)   web :5173 (vite)     │   │ RTSP 视频 :8554 (go2rtc,循环 mp4)        │
│ integrations/ 五个 adapter 进程:               │   │ 三家仿真机器人(官方协议 server 面):       │
│   spot-adapter ×2  (plant07 / campus)         │◄──┤   spot-sim   :9103/:9113 (bosdyn gRPC)   │
│   dr-adapter   ×2  (plant12 / campus)         │   │   dr-sim     :30000/:30010 (EB90 TCP)    │
│   gosuncn-adapter  (campus, 一对驱两台 F2)      │   │   gosuncn-sim :9101 (GoRobot 云 REST+WS) │
└───────────────────────────────────────────────┘   └──────────────────────────────────────────┘
    adapter 北向走 /api/integration/v1(Bearer 场站 key);campus 一屏三厂商协同
```

`pnpm dev` 经 `integrations/scripts/dev-all.mjs` 拉起五个 adapter;若 `../plantbotsimulator`
（或 `PLANTBOT_SIM_DIR`）已 checkout,连它的仿真机器人一起拉起 → 全栈演示（含真 RTSP 视频）;
未 checkout 则只跑 adapter,机器人显示 OFFLINE（即生产形态——等你指向真机）。

`ROBOT_CATALOG`(`fleet.ts`)与接入向导只列有 adapter 的三种型号:Spot / Jueying X30 / GS Patrol F2。
spot/deeprobotics 的 adapter 用 `SPOT_PROFILE`/`DR_PROFILE` 选身份(serial/callsign)+通道命名+场站 key,
同一份代码起两个实例。

- **三种协议形态刻意异构**——这正是 adapter 层存在的理由（sim 侧在 plantbotsimulator 忠实还原同一协议的 server 面）:
  - Spot：**机直连 gRPC 会话模型**（auth JWT → time-sync → lease keep-alive → estop check-in → power → command）;
  - 云深处：**机直连裸 TCP**（16 字节二进制帧头 + XML 报文,请求/响应靠序列号配对）;
  - 高新兴：**厂商云 REST+WS**（adapter 连的是 GoRobot 云平台,不是机器人;告警/状态从云上转手）。
- 北向客户端 = **`@plantbot/adapter-sdk`**（`sdk/adapter-sdk-ts`,对外发布的同一个包,现为构建产物
  `dist/`——`pnpm install` 自动构建;`integrations/shared/{plantbot,bridge}.ts` 只是薄 re-export,
  SDK 与内置 adapter 永不漂移）：注册重试直到平台起来、state 兼心跳、ordersPending 提示拉单、
  传输错误永不 throw（平台可以比 sim 晚启动、中途重启）。`pumpOrders` 按 `order.id` 去重(平台重启后
  acked 单会重新入队,去重防止重复动作);`goto`/`mission` 运动类订单对同一 serial 串行执行,新运动类订单
  到达时先过可选 `preempt(inflight, incoming)` 钩子再执行;`pause`/`resume`/`abort`/`announce`/`ptz`
  干预类立即执行,不被运动队列阻塞。

### 秘钥交接（adapter onboarding）

生产：管理员在 Integrations 面板签发场站 key，或 `PB_SEED_KEYS="plant-07=pbk_…"` 由 systemd 注入。
开发：根 `pnpm dev` 给 server 挂 `PB_DEV_KEYS=1`，播种确定性 `pbk_dev_<site>`，adapter 与仿真机器人零配置互认。
（对照反面：GoRobot 把 `Basic admin:admin` 写死在文档里——key 必须可轮换、不进 git。）

## 3. 厂商映射表（vendor ⇄ 平台六域）

### 3.1 Boston Dynamics Spot（plant-07 · 工业巡检）

| 平台域 | Spot 侧 | 说明 |
| --- | --- | --- |
| state | `RobotStateService.GetRobotState` 1 Hz | battery_states[].charge_percentage(DoubleValue)、kinematic_state.transforms_snapshot 的 odom→body SE3、velocity_of_body_in_odom |
| orders: goto | `GraphNavService.NavigateToAnchor`(seed_tform_goal) | 世界米坐标直接进 seed frame;NavigationFeedback 轮询到 REACHED_GOAL 回 done |
| orders: mission | NavigateToAnchor 逐点串行 + 步内 dwell | Autowalk 录制是真机流程,ad-hoc 任务用 anchor 导航是官方支持的普通做法 |
| commands: velocity | `RobotCommandService` SE2VelocityCommand + end_time | ⚠️ **平台侧未实现**(velocity 尚是设计目标,现有 Command 联合无此支);真接后平台 400ms deadman ≈ Spot 命令 end_time 语义,天然对齐 |
| events | BehaviorFault / SystemFault / EstopState 变化沿 | fault→`robot-fault` 事件;估计不出的厂商侧 CV 事件 Spot 没有(裸机无 CV 栈) |
| readings | robot_state 里的 battery temp/voltage、odom speed | 上报 batt.temp.c 等 metric |
| channels | `ImageService.GetImage`(5 目鱼眼) | 快照证据用平台快照服务;实时流真机走 Spot CAM(WebRTC),demo 注册本地环路 |
| 会话 | lease RetainLease 2s、estop check-in timeout/3、time-sync 60s | adapter 全套照做;sim 校验 lease/estop/power 前置,不满足回官方错误码 |

**忠实还原的怪癖**：estop challenge 是 uint64 取反（BigInt）；`RobotCommand.mobility_command` 顶层已 reserved,
必须走 `synchronized_command`；enum 有 allow_alias（STOPPED=AT_GOAL=1）按数字比较；未上电发运动指令→
`STATUS_NOT_POWERED_ON`；lease 过旧→`LeaseUseResult.STATUS_OLDER`。

### 3.2 云深处 robotserver_sdk（plant-12 · 海港重载 X30）

| 平台域 | robotserver 侧 | 说明 |
| --- | --- | --- |
| state | Type 1002 实时状态查询(1 Hz 轮询) | 位姿/电量/速度,XML 字段照 SDK 头文件 |
| orders: goto/mission | Type 1003 下发导航任务(多点) | **1003 的响应=任务终态**(ErrorCode 0/1/2),不是 ACK;进行中靠 1007 查询 |
| orders: abort | Type 1004 取消导航 | 响应回填同序列号 |
| commands: pause/resume | 无原生对应 → 1004 取消 + 重发剩余点 | 记录为厂商能力缺口,adapter 桥接 |
| events | 1007 Status=-1/ErrorCode 细因码 → robot-fault | 该 SDK 无 CV 事件面(纯导航主机) |
| readings | 1002 里的电量/里程 | batt 域 metric |
| maps | 无地图下载接口 → adapter 不上传 | X30 的 SLAM 地图由平台侧占据栅格代表 |

**忠实还原的怪癖**：16 字节头（`EB 90 EB 90` + 小端 uint16 长度/序列号 + 8 字节 0）;长度=UTF-8 **字节**数;
响应必须回填请求序列号；官方 SDK 收包「只解析缓冲区首帧、成功后清空整个缓冲」——sim 绝不能把两帧写进同一
TCP 段，坏帧会永久卡死官方接收端；无心跳无鉴权，保活/重连全在 client 侧。

### 3.3 高新兴 GoRobot（campus-east · 校园安防 F2 ×2）

| 平台域 | GoRobot 侧 | 说明 |
| --- | --- | --- |
| state | WS `RobotStatus`(**delta 推送**) + `findRobotStatus` 1 Hz 轮询兜底 | WS 机器人级推送一次只能盯一台(DeviceChange),多机接入靠 REST 轮询——厂商模型的真实摩擦 |
| orders: goto | **先 `changeControl`(carmode=1) 切手动** → `navigateToPoint.action`(激光 px 坐标+mapName) | 到点判定=最近逼近锁存(距目标最近点)或手动模式下 `taskType=standBy`;导航结束后保持手动驻留(不自动交还自动模式)。adapter 持有 px↔米标定(GoRobot 不暴露分辨率,标定责任在集成方——原样) |
| orders: goto(dock) | `sendMQComandByUTF8` 一键充电 XML | 平台 dock 命令带 `dock:true` 语义,adapter 换充电指令 |
| orders: mission | 逐点:每点 **changeControl(1) 前置 + `navigateToPoint`**,同上到点判定 + 手动驻留 | GoRobot 的「路线」是预配置资产(手绘/组合上传),没有 ad-hoc imperative 接口——桥接即真实集成商做法 |
| orders: announce / pause / resume | `voiceSoundtextSet` / `pauseTask` / `resumeTask` | 直接映射 |
| commands: ptz | 云台 XML(unCtrlValue 1/3/5/7…,200ms 重发语义留在 sim) | |
| events | WS `AlarmInfo`(alarmType 码表→平台事件类型) + `AlarmRunInfo`(本体故障) | 315 陌生人→tailgating、1015 聚集→crowding、10012 遗留背包→unattended-bag…;picUrl 无 host,adapter 拼接;**AlarmInfo 无 x/y 时事件位置回落机器人当前位置** |
| readings | findRobotStatus 温湿度/噪声/PM | amb.temp.c / amb.rh.pct / noise.db |
| channels | `selectChannelList` + `getVideoUrl`(10 秒时效) | 通道表照搬;demo 流地址注册本地环路,10s 时效机制 sim 完整还原 |

**忠实还原的怪癖**：`.action` RPC + POST 参数在 query；`Token` 自定义 header + Basic admin:admin 登录 +
md5 密码；token 2h 滑动过期；`selectLineInfo.action` 不带 `/robotservice` 前缀（文档原样）；命名漂移
deviceId/robotSn/deviceCode 并存；激光地图 y 轴原点左下角；WS RobotStatus 只推变化字段。

### 3.4 云深处官方接口分层与智巡平台 Station OpenAPI

云深处对外有**两层**接口,当前 X30 adapter 只接了底层：

- **底层 = `robotserver_sdk`**(本仓库 adapter 接的这一层):最底层的**导航面**(EB90 TCP + XML,§3.2),
  单机、无任务模板/无识别结果/无告警面。上游仓库单次提交定格在 **2025-03-31**,基本是稳定的裸导航 SDK。
- **上层 = `station-openapi-devkit`**(官方智巡平台的运营面,**2026-07-21** 发布,BSD-3 授权,Java SDK):
  **27 个 HTTP 接口 `/remoteApi/*` + RocketMQ 四类推送**(任务状态 / 识别结果 / 告警 / 路线)。
  鉴权二选一:AppKey 签名 或 Access Token。能力面(正是底层 robotserver 缺的那些):
  任务模板与排程、`taskCtrl` 2/3/4(暂停 / 恢复 / 停止)、`cameraCtrl` 3/4/5(云台 + 可见光 / 红外切换)、
  `chargeCtrl` 1/2(回充)、识别结果(`patrolValue` + `confidence` + 证据图)、
  地图导出(`mapList` / `roadMap` / `node`)、`streamPage` 流地址。

结论:平台侧的 pause/resume、ptz、读数、事件(识别结果 / 告警)这些在 robotserver 面**空缺**的能力,
在 Station 面**都能点亮**——因此 Station OpenAPI 是云深处的**候选第二条接入路径**(Station-adapter,
与现有 robotserver-adapter 并列),**尚未实现**,列为路线图。
来源:<https://github.com/DeepRoboticsLab/station-openapi-devkit> ·
<https://github.com/DeepRoboticsLab/robotserver_sdk>。

### 3.5 候选厂商:优必选(UBTECH)

评估结论:**先商务后工程**——目前没有可直接自助对接的公开机队运营 API。

- **AIMBOT / Cruzr**:能力在厂商**私有云后台**,无公开运营 API,接入需走商务授权拿到接口/凭证。
- **Walker S**(人形):对外是**板载 ROS SDK**——若接,将是本平台的**第四种协议形态原型「板载 ROS 桥接」**
  (adapter 直接在机器人板上/同网跑 ROS 节点,北向翻到集成 API),与现有三种(gRPC / 裸 TCP / 厂商云)并列。
- **电力场景**:可按 **T/CEC 159-2018**(变电站巡检机器人接口)扩展接口,或走 **IEC 60870-5-104** 三遥接入。
- 排序:优必选整体在**商务谈成之前不投工程**;真要接,Walker S 的板载 ROS 路径最接近本架构的 adapter 模型。

## 4. 平台侧因实践而生的修正（反思日志）

按「先接入、遇阻、再修平台」的顺序记录（这是本次改造的方法论：**用真实集成压力测试自己的 API**）：

1. **key 交接没有故事** → `PB_SEED_KEYS`/`PB_DEV_KEYS` 播种机制（§2）。手工签发依旧是生产正道。
2. **测试隔离** → `PB_DATA_DIR` 重定向 plantbot.db / maps / snapshots，e2e 起临时平台不污染开发数据。
3. **外部任务无法中止** → 平台 abort/pause/resume 命中外部机器人任务时下发 `abort|pause|resume` 订单
   （原先只有 goto/mission/announce 三类，操作员对外部任务只能干看）。
4. **dock 语义丢失** → dock 命令对外部机器人产生的 goto 订单带 `dock: true`，adapter 可换厂商的
   充电指令（GoRobot 一键充电 / Spot 无自动回坞则普通导航）。
5. **证据快照** → `POST /api/integration/v1/snapshot {stream}` → `{url}`：adapter 引用平台登记的
   帧源出快照（InOrbit 式平台侧抓帧），事件证据不再依赖 adapter 自己会转码。
6. **ptz 命令止于日志** → 外部机器人 ptz 命令转发为 `ptz` 订单（GoRobot 映射云台 XML，其余厂商回
   `failed: unsupported`——能力矩阵由 adapter 声明真话）。
7. **gosim 退役 → 纯集成层** → 平台进程里不再内嵌任何厂商行为模型；随后原生种子机队也整体退役
   （World 不再有运动仿真与 A* 规划——路径规划回归机器人端 Nav 栈），机器人只有一种来路：外部 adapter。
8. **外部机器人的常态活水** → 排程可 `assign: {kind:'robot', robotId}` 钉死外部单元
   （plant-07「Spot switchgear anchors」/ plant-12「X30 berth sweep」种子）；机器人未注册时任务留队，
   注册后自动派发——e2e 期间它真的点火并抢占了测试场地，证明活水成立（测试改为显式停排程取得可控场地）。
9. **pause 订单误结算任务（实测抓出）** → pause/resume/abort 订单为引用也携带 missionId，而
   `setOrderStatus` 原本把「任何带 missionId 的订单完结」当作任务完结——适配器回报 pause done 时任务被
   误标 done。修正：只有 `kind === 'mission'` 的订单结算任务。
10. **robot 级 pause/resume/abort 对外部单元失灵（实测抓出）** → 派单给外部机器人时未挂 `nav.missionId`，
    操作员的暂停按钮找不到「活动任务」。修正：外部派单同样钉 missionId，订单完结时清除。
11. **能力矩阵讲真话** → 协议没有的能力不模拟：robotserver 无 pause/announce/ptz、裸机 Spot 无扬声器/云台，
    适配器一律 `failed: unsupported` 回报——操作员看到的是厂商真实能力面。

## 5. 测试（三机器人全行为）

`integrations/test/*.e2e.ts`（node:test + tsx）。每个厂商一个 suite，模式相同：

1. 临时端口 + `PB_DATA_DIR` 启动 platform → 启动 sim → 启动 adapter；
2. 断言：注册出现（FLEET 含 serial/EXTERNAL）→ state 流动（坐标变化、心跳在线）→
   goto 派单（operator API 下 goto → 机器人移动到目标 → 订单 done）→ mission 指派（逐步执行、进度、结果）→
   abort 中止 → announce/ptz/dock 命令 → 事件上报（类型映射、快照 url、confidence）→ readings 时序 →
   通道会话（10s 时效/续期）→ 故障注入（sim 掉线 → 平台 20s 判 offline → sim 回来自动恢复）；
3. 厂商特有断言：Spot 的 lease 丢失/estop 未 check-in 拒令、云深处 1003 终态回帧与 1004 取消、
   GoRobot 手动模式前置与 token 过期重登。

## 6. 生产部署

生产只部署 **adapter**（五个进程,systemd 各一 unit;仿真机器人 plantbotsimulator 只在演示/开发环境需要），
环境变量：`PLANTBOT_BASE=http://127.0.0.1:8787`、`PLANTBOT_KEY=<PB_SEED_KEYS 对应值>`、
`STREAM_BASE=/robots/media`（子路径部署时流地址前缀）、多实例的 `SPOT_PROFILE`/`DR_PROFILE`。
详见 [deploy.md](deploy.md)。
