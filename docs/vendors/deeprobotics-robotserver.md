# 云深处 DeepRobotics robotserver_sdk 通信协议参考

> 目标：**忠实、可直接照着实现**的线上协议（wire protocol）参考。用于我们用 Node.js/TypeScript 写一对
> **simulator（模拟机器人端 = TCP server）** + **adaptor（协议客户端 → Plantbot 平台）**，完美还原官方协议。
>
> 一切结论均标注出处文件路径。凡官方源码未能确证、仅为合理推断的机器人端行为，均以 **【推断】** / **【UNVERIFIED】** 显式标注，不得当作事实。
>
> 来源仓库：`https://github.com/DeepRoboticsLab/robotserver_sdk`（首次提交 `f70df5e`，2025-03-31；SDK 版本 `0.1.0`，MIT）。本文所有行号对应该仓库。

> **接口分层说明**：`robotserver_sdk` 是云深处的**底层导航面**（本文所述这套 TCP+XML 协议），单机、无任务模板 / 识别结果 / 告警面。云深处另有**上层运营面** `station-openapi-devkit`（智巡平台，HTTP `/remoteApi/*` + RocketMQ 推送），任务排程、云台、回充、识别结果、地图导出都在那一层——是候选的第二条接入路径。两层的取舍见 [adapter-sim-architecture.md](../adapter-sim-architecture.md) 的 **§3.4**。

---

## 0. 一句话概括

**TCP 长连接（客户端=SDK，服务端=机器人 106 导航主机，示例端口 30000）；每帧 = 16 字节二进制定长头（同步字 `EB 90 EB 90` + uint16 小端 body 长度 + uint16 小端序列号 + 8 字节保留 0）+ 变长 UTF-8 XML 报文体（根节点 `<PatrolDevice>`，用 `<Type>` 数字码区分消息）。** 共 **4 类请求 / 4 类响应**（Type 1002/1003/1004/1007）。无心跳、无自动重连、无鉴权。

---

## 1. 概述：SDK 定位、跑在哪、连谁

- **SDK 定位**：一个 C++17 客户端库，封装「控制/监控四足机器狗**导航巡检任务**」的底层协议与网络细节。它**只做客户端**（主动 `connect` 出去），不监听端口。出处：`README.zh-CN.md:5`、`include/robotserver_sdk.h:19-94`。
- **跑在哪**：装在**用户自己的电脑**上。README 反复警告：**严禁装在「106 导航主机」或机器人本机上**（`README.zh-CN.md:7`，`README.en.md:7`）。也就是说 SDK/adaptor 与机器人是两台机器，通过 TCP 相连。
- **连谁**：连接机器人侧的「导航主机 / 106 感知主机」。示例固定用 `192.168.1.106 : 30000`（`README.zh-CN.md:43,57`、`docs/zh-CN/quick_start.zh-CN.md:77`、`examples/basic/basic_example.cpp` 命令行参数）。机器人侧运行一个名为 `robot_server` 的服务进程，日志在导航主机 `jy_cog/system/log/<日期>/robot_server.XXX.log`（`README.zh-CN.md:59`）。
  - 因此我们的 **simulator 要实现的就是这个 `robot_server` 的 TCP server 面**（监听 30000，接受 SDK/adaptor 连接）。
- **面向机型**：本 SDK 对应**绝影 X30 / X30 Pro**（README 多次引用《绝影 X30 Pro 应用手册》，`README.zh-CN.md:50,59`）。**Lite3 系列走的是另一套 `Lite3_MotionSDK`（低层运动控制），与本导航协议不是一回事**（【推断】依据：DeepRoboticsLab 组织下 `Lite3_MotionSDK` 为独立仓库；本仓库通篇只提 X30，无 Lite3/机型分支代码）。
- **协议族名**：报文根节点叫 `<PatrolDevice>`（"巡检设备"），Type 采用 4 位数字码。本 SDK 只实现了 1002/1003/1004/1007 四个码；**其余码位（如 1001/1005/1006 等）在本 SDK 内无定义**，若线上存在属于更大的巡检协议，超出本 SDK 范围（本文不臆造）。

### 依赖与语言（旁证协议格式）
- C++17 + Boost.Asio（网络）+ nlohmann/json（**仅用于读本地导航点配置文件**）+ rapidxml（**解析线上 XML 报文**）。出处：`CMakeLists.txt:21-23`、`README.zh-CN.md:20-23`。
- 关键：**线上报文是 XML，不是 JSON**。JSON 只出现在本地 `default_navigation_points.json` 配置文件里，与 wire 无关。

---

## 2. 传输层与帧格式（wire protocol 核心）

### 2.1 传输层
| 项 | 值 | 出处 |
|---|---|---|
| 协议 | **TCP**（`boost::asio::ip::tcp::socket`） | `src/network/asio_network_model.hpp:96` |
| 角色 | SDK/adaptor = **client**；机器人 = **server** | `asio_network_model.cpp:25-101`（`async_connect`） |
| 主机/端口 | 示例 `192.168.1.106:30000`（域名或 IP 均可） | `README`/`quick_start`/`basic_example.cpp` |
| 连接方式 | 异步 connect + 超时定时器；默认连接超时 **5000ms** | `asio_network_model.cpp:44-77`；`types.h:198` |
| 收包缓冲 | 单次 `async_read_some` 读入 **4096 字节** 定长栈缓冲，再追加到 `receive_data_` 累积串 | `asio_network_model.hpp:100,102`；`asio_network_model.cpp:182-184,231` |
| 心跳 | **无**。SDK 不发任何 keepalive/ping | 全仓无相关代码 |
| 重连 | **无**。收/发出错（非 `operation_aborted`）即 `disconnect()`，不自动重连 | `asio_network_model.cpp:222-227,257-262` |
| 字节序 | body 长度、序列号均按**小端**上线（详见 2.3） | `protocol_header.cpp:16-22,40` |
| TLS/鉴权 | **无**。明文 TCP，无握手、无 token | 全仓无相关代码 |

### 2.2 帧结构总览
```
┌────────────────────────── 16 字节定长头 (ProtocolHeader) ──────────────────────────┐
│ 0xEB 0x90 0xEB 0x90  │  length(uint16 LE)  │  seq(uint16 LE)  │  reserved[8] = 0x00…  │  <body：UTF-8 XML，length 字节>
└─────────────────────────────────────────────────────────────────────────────────────┘
```
> 注意：同步字是 **EB 90 EB 90**（下一节逐字节列出，勿把上面示意里的第 3 字节看错）。

### 2.3 头部逐字段（16 字节，`#pragma pack(1)` 无填充）
出处：`src/protocol/protocol_header.hpp:7-23`，常量在 `protocol_header.cpp:5-9`。

| 偏移 | 字段 | 类型 | 值 / 说明 |
|---|---|---|---|
| 0 | `sync_byte1` | uint8 | `0xEB` |
| 1 | `sync_byte2` | uint8 | `0x90` |
| 2 | `sync_byte3` | uint8 | `0xEB` |
| 3 | `sync_byte4` | uint8 | `0x90` |
| 4–5 | `length` | uint16 | **body（XML）字节数**，小端。**不含头部 16 字节**。 |
| 6–7 | `sequenceNumber` | uint16 | 序列号，小端，用于请求/响应配对（见 §5） |
| 8–15 | `reserved[8]` | uint8×8 | 全 `0x00` |

**字节序细节（重要，避免 Node 实现踩坑）**：
- 序列化时只对 `length` 调了 `toLittleEndian`（在大端机才交换，小端机原样）；`sequenceNumber` **没调**，直接按主机字节序写。出处：`protocol_header.cpp:40`（只转 length）。
- 反序列化时 `getBodySize()` 直接返回 `length` 原始 2 字节、`header->sequenceNumber` 直接读原始 2 字节，**未做还原转换**。出处：`protocol_header.cpp:47-49`、`serializer.cpp:28,55`。
- 结论：机器人主机与 SDK 都是 x86/ARM **小端**，所以 **`length` 与 `sequenceNumber` 实际上都以小端上线**。Node 侧统一用 `readUInt16LE / writeUInt16LE` 即可。**同步字与 reserved 是逐字节，无字节序问题。**

### 2.4 报文体（body）格式
- **编码 UTF-8，内容为 XML 文本**（无 BOM）。出处：`messages.hpp` 各 `serialize()`。
- 换行符为 `\n`(LF)；顶层元素不缩进；**仅导航点 `<Items>` 的子元素用 2 空格缩进**（`messages.hpp:216-229`）。末行 `</PatrolDevice>` **无结尾换行**。
- 根节点恒为 `<PatrolDevice>`；靠子节点 `<Type>`（数字）区分消息种类（见 §3）。
- **接收端如何识别 body 是 XML**：`Serializer::extractMessageType` 判断 body 里是否含子串 `"<?xml"` **或** `"<PatrolDevice>"`（`serializer.cpp:84`）。响应体只要含 `<PatrolDevice>` 即可被解析，但**推荐带完整 XML 声明**以求保真。

### 2.5 分帧 / 粘包（Node 实现必须精确复刻，见 §7 坑位）
接收流程 `AsioNetworkModel::onReceive`（`asio_network_model.cpp:221-254`）+ `Serializer::deserializeMessage`（`serializer.cpp:9-62`）：
1. 把本次读到的字节 `append` 到 `receive_data_`。
2. 校验 `receive_data_.size() >= 16`，否则返回 `nullptr`（**保留缓冲**，继续等）。
3. 读 `length`；若 `size() < 16 + length` 返回 `nullptr`（**保留缓冲**，继续等）——**半包被正确处理**。
4. 取 `body = data.substr(16, length)`，按 `<Type>` 建对象并 `deserialize`。
5. **成功得到 message 时**，把整个 `receive_data_.clear()` 清空（`asio_network_model.cpp:237`），再回调。

> ⚠️ **两个致命限制（决定 sim 的发包纪律）**：
> - **每次只解析缓冲区中的第一帧，然后整段清空**。若一次 TCP 读里到达了「两帧」或「一帧半」，**第二帧（或半帧尾）会被 `clear()` 丢弃**。→ **sim 必须一帧一发，且不要在对端消费前把多帧背靠背塞进同一段 TCP 流**（最稳的做法：严格「收到请求→回一帧响应」，不主动连发）。
> - **只有解析出完整合法帧才清空**；若帧头长度合法但 XML 非法 / `<Type>` 不在 {1002,1003,1004,1007}，`deserializeMessage` 返回 `nullptr` 且**缓冲不清空**，该坏帧会永久滞留、卡死后续解析。→ **sim 只能发结构完全正确、Type 合法的帧。**

### 2.6 一个完整帧的字节级样例（1002 请求，seq=1）
body（LF 换行，时间戳取 19 字符 `2025-03-31 15:32:37`）：
```
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1002</Type>
<Command>1</Command>
<Time>2025-03-31 15:32:37</Time>
<Items/>
</PatrolDevice>
```
该 body 长度 = **150 字节**（=0x0096；随时间戳长度变化，务必按实际字节数算，勿硬编码）。完整帧头 16 字节：
```
EB 90 EB 90  96 00  01 00  00 00 00 00 00 00 00 00
└─ sync ──┘  └len┘  └seq┘  └──── reserved[8] ────┘
```
后接上面 150 字节 XML。总帧长 = 16 + 150 = 166 字节。

---

## 3. 消息总表

四种业务操作，各有「请求(REQ, SDK→机器人)」与「响应(RESP, 机器人→SDK)」。Type 码即 body 里 `<Type>` 的值，也是响应路由依据。出处：`serializer.hpp:69-74`（Type→类型映射）、`message_interface.hpp:11-21`、各 `messages.hpp` 类。

| Type | 操作 | REQ 方向 | RESP 方向 | SDK 调用 | 同步/异步 | 响应语义 |
|---|---|---|---|---|---|---|
| **1002** | 获取实时状态 | SDK→机器人 | 机器人→SDK | `request1002_RunTimeState()` | **同步**，阻塞等 RESP | 立即返回一帧姿态/电量快照 |
| **1003** | 下发导航任务 | SDK→机器人 | 机器人→SDK | `request1003_StartNavTask(points, cb)` | **异步回调** | RESP = **任务最终结果**（完成/失败/取消），非即时 ACK |
| **1004** | 取消当前导航任务 | SDK→机器人 | 机器人→SDK | `request1004_CancelNavTask()` | **同步**，阻塞等 RESP | 立即返回取消是否成功 |
| **1007** | 查询导航任务状态 | SDK→机器人 | 机器人→SDK | `request1007_NavTaskState()` | **同步**，阻塞等 RESP | 立即返回 执行中/完成/失败 |

- 所有 REQ 的 body 都含 `<Command>1</Command>`（`messages.hpp` 各 REQ `serialize()`；1 为固定值，SDK 端未见其他取值，响应端不解析 Command）。
- 所有 REQ 都带 `<Time>` 本地时间戳字符串 `"%Y-%m-%d %H:%M:%S"`（`messages.hpp:39-45`）；响应端**不解析** Time，可视为纯留痕。
- **响应体也必须带 `<Type>NNNN</Type>`**，NNNN 与对应请求同码——这是 SDK 给响应归类的唯一依据（`serializer.cpp:99-125,157-165`）。

---

## 4. 逐消息字段级定义（verbatim）

> 下列 REQ 的 XML 由 SDK 生成（sim 需**解析**）；RESP 的 XML 由机器人生成（sim 需**产出**，adaptor 需解析）。字段名区分大小写，逐字抄录。

### 4.1 Type 1002 — 获取实时状态

**REQ（SDK→机器人）** 出处 `messages.hpp:73-84`：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1002</Type>
<Command>1</Command>
<Time>2025-03-31 15:32:37</Time>
<Items/>
</PatrolDevice>
```
（无入参；`<Items/>` 为空自闭合标签。）

**RESP（机器人→SDK）** 由 `GetRealTimeStatusResponse::deserialize` 解析，字段全部位于**单个** `<Items>…</Items>` 块内。出处 `messages.hpp:134-187`。字段（XML 标签 / 类型 / 语义）：

| XML 标签 | 类型 | 语义 / 单位 | 取值说明 |
|---|---|---|---|
| `MotionState` | int | 运动状态 | 数值含义未在 SDK 给出（opaque） |
| `PosX` | double | 位置 X | 地图坐标系，米（推断） |
| `PosY` | double | 位置 Y | 米 |
| `PosZ` | double | 位置 Z | 米 |
| `AngleYaw` | double | 偏航角 | 弧度（推断，见 §4.2 配置样例值域） |
| `Roll` | double | 横滚角 | 弧度 |
| `Pitch` | double | 俯仰角 | 弧度 |
| `Yaw` | double | 偏航角（另一路） | 弧度 |
| `Speed` | double | 速度 | m/s（推断） |
| `CurOdom` | double | 当前里程 | 米 |
| `SumOdom` | double | 累计里程 | 米 |
| `CurRuntime` | uint64 | 当前运行时间 | 单位未定义（推断 ms 或 s） |
| `SumRuntime` | uint64 | 累计运行时间 | 同上 |
| `Res` | double | "响应时间"(res) | 语义模糊，opaque |
| `X0` | double | 坐标 X0 | opaque |
| `Y0` | double | 坐标 Y0 | opaque |
| `H` | int | 高度 | opaque |
| `Electricity` | int | 电量 | 百分比 0–100（`basic_example.cpp:89` 按 `%` 打印） |
| `Location` | int | 定位状态 | **0=定位正常，1=定位丢失**（`types.h:165` 明确） |
| `RTKState` | int | RTK 状态 | opaque |
| `OnDockState` | int | 上岸/上桩状态 | opaque |
| `GaitState` | int | 步态状态 | opaque |
| `MotorState` | int | 电机状态 | opaque |
| `ChargeState` | int | 充电状态 | opaque |
| `ControlMode` | int | 控制模式 | opaque |
| `MapUpdateState` | int | 地图更新状态 | opaque |

> 解析方式为 `stringstream >> value`（`messages.hpp:148-153`）：容忍缺字段（缺则保持默认 0）、容忍多余空白。sim 产出时给全字段最稳。

**RESP 样例（sim 产出）**：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1002</Type>
<Items>
<MotionState>1</MotionState>
<PosX>0.056387</PosX>
<PosY>0.035721</PosY>
<PosZ>0.004419</PosZ>
<AngleYaw>-0.062743</AngleYaw>
<Roll>0.0</Roll>
<Pitch>0.0</Pitch>
<Yaw>-0.062743</Yaw>
<Speed>0.8</Speed>
<CurOdom>12.3</CurOdom>
<SumOdom>1234.5</SumOdom>
<CurRuntime>60000</CurRuntime>
<SumRuntime>9000000</SumRuntime>
<Res>0.0</Res>
<X0>0.0</X0>
<Y0>0.0</Y0>
<H>0</H>
<Electricity>87</Electricity>
<Location>0</Location>
<RTKState>0</RTKState>
<OnDockState>0</OnDockState>
<GaitState>0</GaitState>
<MotorState>0</MotorState>
<ChargeState>0</ChargeState>
<ControlMode>0</ControlMode>
<MapUpdateState>0</MapUpdateState>
</Items>
</PatrolDevice>
```

### 4.2 Type 1003 — 下发导航任务

**REQ（SDK→机器人）** 出处 `messages.hpp:204-234`。可含**多个** `<Items>` 块，每块一个导航点：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1003</Type>
<Command>1</Command>
<Time>2025-03-31 15:32:37</Time>
<Items>
  <MapId>0</MapId>
  <Value>1</Value>
  <PosX>0.056386966</PosX>
  <PosY>0.035720933</PosY>
  <PosZ>0.0044188141</PosZ>
  <AngleYaw>-0.062743418</AngleYaw>
  <PointInfo>0</PointInfo>
  <Gait>0</Gait>
  <Speed>1</Speed>
  <Manner>0</Manner>
  <ObsMode>0</ObsMode>
  <NavMode>1</NavMode>
  <Terrain>0</Terrain>
  <Posture>0</Posture>
</Items>
<!-- …可重复更多 <Items> 点… -->
</PatrolDevice>
```

导航点字段（每个 `<Items>` 内，出处 `messages.hpp:18-33` 结构 + `messages.hpp:216-229` 序列化 + `types.h:107-141`）：

| XML 标签 | 类型 | 语义 | 备注 |
|---|---|---|---|
| `MapId` | int | 地图 ID | ⚠️ **wire XML 标签是 `MapId`**（`messages.hpp:217`）；但本地 JSON 配置键是 **`MapID`**（`types.h:125`）。sim **解析** REQ 认 `MapId`；adaptor 若也读 JSON 配置要认 `MapID`。 |
| `Value` | int | 点编号 | 任务里的目标点标识；响应用它回指是哪个点 |
| `PosX` | double | X 坐标 | 米 |
| `PosY` | double | Y 坐标 | 米 |
| `PosZ` | double | Z 坐标 | 米 |
| `AngleYaw` | double | 目标偏航角 | 弧度（样例 -2.61…1.14，属 ±π，佐证弧度） |
| `PointInfo` | int | 点信息 | opaque（样例 0/1/3） |
| `Gait` | int | 步态 | opaque |
| `Speed` | int | 速度档位 | opaque（样例 0/1，非 m/s） |
| `Manner` | int | 方式 | opaque |
| `ObsMode` | int | 避障模式 | opaque |
| `NavMode` | int | 导航模式 | opaque（样例恒 1） |
| `Terrain` | int | 地形 | opaque |
| `Posture` | int | 姿态 | opaque |

> 各点字段的具体枚举含义 SDK 未给出；对 sim/adaptor 而言是**透传整数**即可。真实值参考 `examples/basic/default_navigation_points.json`（4 个点样例，见 §8 引用）。

**RESP（机器人→SDK）= 任务最终结果**，由 `NavigationTaskResponse::deserialize` 解析，字段在单个 `<Items>` 内。出处 `messages.hpp:262-297`：

| XML 标签 | 类型 | 语义 |
|---|---|---|
| `Value` | int | 目标点编号，回指哪个点（与 REQ 的 `Value` 对应） |
| `ErrorCode` | int | **任务结果码**，见 `ErrorCode_Navigation`（§4.5.1）：0=成功,1=失败,2=取消 |
| `ErrorStatus` | int | **失败/结束的具体原因码**，见 `ErrorStatus_Navigation`（§4.5.2），是个大枚举 |

**RESP 样例（成功完成）**：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1003</Type>
<Items>
<Value>4</Value>
<ErrorCode>0</ErrorCode>
<ErrorStatus>8960</ErrorStatus>
</Items>
</PatrolDevice>
```
（8960 = `SINGLE_POINT_INSPECTION_TASK_COMPLETED`。失败例：`ErrorCode=1, ErrorStatus=41730`(电量过低)；取消例：`ErrorCode=2, ErrorStatus=8962`。）

### 4.3 Type 1004 — 取消导航任务

**REQ（SDK→机器人）** 出处 `messages.hpp:403-413`（结构同 1002，仅 Type 不同）：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1004</Type>
<Command>1</Command>
<Time>2025-03-31 15:32:37</Time>
<Items/>
</PatrolDevice>
```

**RESP（机器人→SDK）** 由 `CancelTaskResponse::deserialize` 解析，`<Items>` 内仅一个字段。出处 `messages.hpp:439-465`：

| XML 标签 | 类型 | 语义 |
|---|---|---|
| `ErrorCode` | int | `ErrorCode_CancelTask`：**0=成功,1=失败**（`message_interface.hpp:35-38`） |

**RESP 样例**：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1004</Type>
<Items>
<ErrorCode>0</ErrorCode>
</Items>
</PatrolDevice>
```
> SDK 判定：`request1004_CancelNavTask()` 仅当 `ErrorCode==0` 返回 `true`（`robotserver_sdk.cpp:354`）。

### 4.4 Type 1007 — 查询导航任务状态

**REQ（SDK→机器人）** 出处 `messages.hpp:313-323`（结构同 1002）：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1007</Type>
<Command>1</Command>
<Time>2025-03-31 15:32:37</Time>
<Items/>
</PatrolDevice>
```

**RESP（机器人→SDK）** 由 `QueryStatusResponse::deserialize` 解析，`<Items>` 内三个字段。出处 `messages.hpp:351-387`：

| XML 标签 | 类型 | 语义 |
|---|---|---|
| `Value` | int | 目标点编号 |
| `Status` | int | 导航状态 `Status_QueryStatus`：**0=已完成,1=执行中,-1=失败**（`types.h:86-90`） |
| `ErrorCode` | int | 错误码 `ErrorCode_QueryStatus`（同值域 0/1/-1，见 §4.5.3） |

**RESP 样例（执行中）**：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PatrolDevice>
<Type>1007</Type>
<Items>
<Value>2</Value>
<Status>1</Status>
<ErrorCode>1</ErrorCode>
</Items>
</PatrolDevice>
```
> ⚠️ 注意 `Status` 和 `ErrorCode_QueryStatus` **值域含负数 -1**（FAILED）。sim 产出 `-1` 字符串、adaptor 解析要按有符号整数处理。

### 4.5 枚举定义（verbatim）

#### 4.5.1 `ErrorCode_Navigation`（1003 结果码）
出处 `types.h:14-22`（SDK 对外）与 `message_interface.hpp:26-30`（协议层，仅前 3 个上线用）：
| 值 | 名 | 含义 |
|---|---|---|
| 0 | SUCCESS | 操作成功 |
| 1 | FAILURE | 操作失败 |
| 2 | CANCELLED | 操作被取消 |
| 3 | INVALID_PARAM | 无效参数（**SDK 本地产生**，非上线值） |
| 4 | NOT_CONNECTED | 未连接（**SDK 本地产生**） |
| 5 | UNKNOWN_ERROR | 未知错误（**SDK 本地产生**） |
> **机器人只会回 0/1/2**；3/4/5 是 SDK 在本地异常路径塞给回调的（`robotserver_sdk.cpp:246,253,297` 等），不出现在 wire 上。

#### 4.5.2 `ErrorStatus_Navigation`（1003 失败/结束细因码）
出处 `types.h:27-67`（与 `docs/zh-CN/api_reference.zh-CN.md:211-251` 一致）。**逐值抄录**：
| 值 | 名 | 含义 |
|---|---|---|
| 0 | DEFAULT | 默认值 |
| 8960 | SINGLE_POINT_INSPECTION_TASK_COMPLETED | 单点巡检任务执行完成 |
| 8962 | SINGLE_POINT_INSPECTION_TASK_CANCELLED | 单点巡检任务被取消 |
| 41729 | MOTION_STATE_EXCEPTION_FAILED | 运动状态异常，任务失败（软急停、摔倒） |
| 41730 | LOW_POWER_FAILED | 电量过低，任务失败 |
| 41731 | MOTOR_OVER_TEMPERATURE_EXCEPTION_FAILED | 电机过温异常，任务失败 |
| 41732 | USING_CHARGER_CHARGING_FAILED | 正在使用充电器充电，任务失败 |
| 41745 | NAVIGATION_PROCESS_NOT_STARTED_FAILED | 导航进程未启动，无法下发任务 |
| 41746 | NAVIGATION_MODULE_COMMUNICATION_EXCEPTION_FAILED | 导航模块通讯异常，无法下发任务 |
| 41747 | POSITION_STATE_CONTINUOUSLY_EXCEPTION_FAILED | 定位状态持续异常（超过 30s） |
| 41748 | TERRAIN_MODULE_STATE_EXCEPTION_FAILED | 地形模块状态异常 |
| 41761 | STAND_UP_FAILED | 发送起立失败 |
| 41762 | EXECUTE_STAND_UP_FAILED | 执行起立失败 |
| 41763 | SWITCH_FORCE_CONTROL_FAILED | 切换力控失败 |
| 41764 | SWITCH_WALKING_MODE_FAILED | 切换行走模式失败 |
| 41765 | PUP_FAILED | 趴下失败 |
| 41766 | SOFT_EMERGENCY_STOP_FAILED | 被软急停 |
| 41767 | SWITCH_GAIT_FAILED | 切换步态失败 |
| 41768 | SWITCH_NAVIGATION_MODE_FAILED | 切换导航模式失败 |
| 41769 | SWITCH_MANUAL_MODE_FAILED | 切换手动模式失败 |
| 41770 | SWITCH_NORMAL_OR_CRAWL_HEIGHT_STATE_FAILED | 切换正常/匍匐身高状态失败 |
| 41777 | SWITCH_STOP_AVOIDANCE_MODULE_SPEED_INPUT_SOURCE_FAILED | 切换停避障模块的速度输入源失败 |
| 41778 | SET_TERRAIN_MAP_PARAMETER_FAILED | 设置地形图参数失败 |
| 41793 | CURRENTLY_EXECUTING_TASK_FAILED | 当前正在执行任务，下发新任务失败 |
| 41794 | SCHEDULE_EXIT_SELF_CHARGING_FAILED | 调度退出自主充电失败 |
| 41795 | EXIT_SELF_CHARGING_EXECUTION_FAILED | 退出自主充电执行失败 |
| 41796 | SCHEDULE_ENTER_SELF_CHARGING_FAILED | 调度进入自主充电失败 |
| 41797 | ENTER_SELF_CHARGING_EXECUTION_FAILED | 进入自主充电执行失败 |
| 41798 | EXIT_PILE_RELOCATION_FAILED | 退桩后重定位失败 |
| 41799 | OPEN_ACCUMULATION_FRAME_FAILED | 开启累积帧失败 |
| 41800 | CLOSE_ACCUMULATION_FRAME_FAILED | 关闭累积帧失败 |
| 41801 | SWITCH_MAP_FAILED | 切换地图失败 |
| 41802 | EXIST_UPPER_MACHINE_CONNECTION_DISCONNECTED_AUTO_STOP_TASK_FAILED | 存在上位机连接断开，自动停止任务 |
| 41803 | STOP_AVOIDANCE_MODULE_STATE_EXCEPTION_FAILED | 持续停障异常，导航失败 |
| 41804 | NAVIGATION_GLOBAL_PLANNING_FAILED | 导航全局规划失败 |
| 41805 | NAVIGATION_CONTINUOUS_NAVIGATION_SPEED_NOT_REFRESHED_FAILED | 持续导航速度未刷新，导航失败 |
| 41806 | SELF_CHARGING_PROCESS_FAILED | 自主充电流程中，下发任务失败 |
| 41881 | RELOCATION_FAILED | 重定位失败 |
| 41983 | PROCESS_MANUAL_RESTART_STOP_TASK_FAILED | 进程手动重启中，停止任务 |

#### 4.5.3 `ErrorCode_QueryStatus` / `Status_QueryStatus`（1007）
出处 `types.h:72-90`、`message_interface.hpp:43-47`：
| 值 | 名 | 含义 |
|---|---|---|
| 0 | COMPLETED | 任务已完成 |
| 1 | EXECUTING | 任务执行中 |
| -1 | FAILED | 无法执行 / 失败 |
> `Status` 与 `ErrorCode` 两字段同值域。SDK 侧 `ErrorCode_QueryStatus` 另有本地态 2=INVALID_RESPONSE,3=TIMEOUT,4=NOT_CONNECTED,5=UNKNOWN_ERROR（`types.h:72-81`），**不上线**。

#### 4.5.4 `ErrorCode_CancelTask`（1004）
出处 `message_interface.hpp:35-38`：0=SUCCESS，1=FAILURE。

#### 4.5.5 `ErrorCode_RealTimeStatus`（1002，纯本地）
出处 `types.h:95-102`：0=SUCCESS,1=INVALID_RESPONSE,2=TIMEOUT,3=NOT_CONNECTED,4=UNKNOWN_ERROR。**全是 SDK 本地态**，不出现在 wire（机器人 1002 响应体里没有 ErrorCode 字段）。

---

## 5. 时序与生命周期

### 5.1 请求/响应配对规则（sim 必须遵守）
出处 `robotserver_sdk.cpp:444-494`（`onMessageReceived`）+ `generateSequenceNumber`（`:525-528`）：
1. **序列号**：SDK 内 `static atomic<uint16_t>`，**预自增**，故首个请求 seq=**1**，逐次 +1，65535 后回绕到 0。**跨所有 SDK 实例共享**（进程级静态）。
2. **配对键 = 帧头 `sequenceNumber`**。机器人**必须在响应帧头回填与请求相同的 seq**，否则：
   - 同步类（1002/1004/1007）：找不到 `pendingRequests_[seq]` → 丢弃 → 调用方 `requestTimeout` 超时。
   - 1003：找不到 `navigation_result_callbacks_[seq]` → 回调永不触发。
3. **二次校验**：同步类还要求 `expectedResponseType == 响应的 MessageType`（由响应体 `<Type>` 决定）。即 1002 请求只认 `<Type>1002</Type>` 的响应，以此类推。
4. **响应体 `<Type>` 必须 ∈ {1002,1003,1004,1007}**，否则解析成 `UNKNOWN` → `nullptr` → 卡缓冲（见 §2.5）。

### 5.2 连接握手
- **无应用层握手**。TCP 三次握手成功即视为"已连接"（`connected_=true`，`asio_network_model.cpp:80`），随即开始 `async_read`。
- 连上后**没有欢迎帧、没有版本协商、没有登录**。sim 接受连接后静待请求即可。

### 5.3 同步请求生命周期（1002 / 1004 / 1007）
出处 `robotserver_sdk.cpp:168-239`(1002)、`307-363`(1004)、`365-441`(1007)：
```
App 线程                     IO 线程                         机器人(sim)
  │ request1002()               │                                │
  │  seq=generateSeq()          │                                │
  │  addPendingRequest(seq)     │                                │
  │  sendMessage() ────post───▶ │ async_write(帧) ──────────────▶│ 收到 1002 REQ(seq)
  │  cv.wait_for(requestTimeout)│                                │ 立即回 1002 RESP(seq, 同 Type)
  │                             │ ◀── async_read 收到响应 ───────│
  │                             │ deserialize→onMessageReceived  │
  │  ◀── notify_one 唤醒 ────────│ 匹配 seq+type，存响应          │
  │  转换并 return 结果          │                                │
```
- **requestTimeout 默认 3000ms**（`types.h:199`）。超时后同步方法返回带 `TIMEOUT` 错误码的结果（1002→`ErrorCode_RealTimeStatus::TIMEOUT`；1007→`ErrorCode_QueryStatus::TIMEOUT`；1004→返回 `false`）。
- 无论成功/超时，函数结束都 `removePendingRequest(seq)`（ScopeGuard，`:188-190`）。

### 5.4 导航任务完整生命周期（1003，异步）★核心
出处 `robotserver_sdk.cpp:242-305`(下发)、`444-479`(结果回调)、`examples/basic/basic_example.cpp:164-211`(轮询模式)、`docs/zh-CN/architecture.zh-CN.md:206-242`(时序图)：

```
1) SDK: request1003_StartNavTask(points, cb)
     seq_nav = generateSeq()
     navigation_result_callbacks_[seq_nav] = cb     // 存回调，不阻塞
     发送 1003 REQ(seq_nav, 多个 <Items> 点)
     函数立即返回（异步）

2) 机器人(sim): 收到 1003 REQ → 开始跑导航 → 内部状态置「执行中」
     ★此时【不立即回 1003】★

3) SDK/App: 循环轮询（示例每 1s，最多 120 次）:
     - request1007_NavTaskState()  → 机器人回 Status=1(执行中), Value=当前点
     - request1002_RunTimeState()  → 机器人回实时姿态/电量
     （这两个是独立的同步请求，各自用新 seq，各自即时应答）

4) 机器人(sim): 任务终态到达（走完/失败/被取消）
     发送 1003 RESP(seq_nav, Value, ErrorCode, ErrorStatus)   // 用当年那个 seq_nav！

5) SDK: onMessageReceived 命中 NAVIGATION_TASK_RESP
     取出 navigation_result_callbacks_[seq_nav] 并 erase
     触发用户回调 cb(NavigationResult{value,errorCode,errorStatus})
```

**关键语义（决定 sim 状态机）**：
- **1003 的响应是「任务最终结果」，在任务结束时才发一帧**，不是即时 ACK。任务进行中的进度靠 **1007 轮询**、实时姿态靠 **1002 轮询**获得。（依据：示例代码正是「发 1003 后不断轮询 1007/1002 直到回调触发」，且 SDK 对每个 seq 只保留一个回调、触发即 erase。）
- **每个 1003 请求，机器人只应回一帧 1003 响应**。若机器人既发即时 ACK 又发终态（都用同 seq），SDK 会在**第一帧**就触发并 erase 回调，第二帧被忽略 → 所以 **sim 只发终态那一帧**。
- **取消**：App 调 `request1004_CancelNavTask()`（同步，机器人即时回 1004 成功）。**【推断】随后机器人应对被取消的导航任务补发一帧 1003 RESP，`ErrorCode=2(CANCELLED)`、`ErrorStatus=8962`**，以触发 1003 回调收尾。（依据：`ErrorCode_Navigation::CANCELLED=2` 与 `ErrorStatus 8962「单点巡检任务被取消」`的存在，以及示例在超时后走 cancel 流程；SDK 源码无法直接证明机器人一定补发，故标【推断】。sim 建议这样实现以形成闭环。）
- **1003 无客户端超时**：`navigation_result_callbacks_` 无超时清理（源码 `robotserver_sdk.cpp:540` 明确 `// TODO: 没有超时清理`）。若机器人永不回 1003，回调永久挂起、map 泄漏。→ adaptor 侧要自己加超时兜底。

### 5.5 断开
- `disconnect()`：cancel 所有异步操作、关 socket、停 io_context、join IO 线程（`asio_network_model.cpp:103-136`）。不发关闭通知帧，直接 TCP 关闭。sim 侧按普通 TCP FIN/RST 处理即可。

---

## 6. 错误、超时与重连语义

| 场景 | SDK 行为 | 出处 |
|---|---|---|
| 未连接就调用 | 同步方法立即返回 NOT_CONNECTED 结果；1003 立即回调 NOT_CONNECTED | `robotserver_sdk.cpp:170-174,251-256,309-311,367-370` |
| 1003 传空 points 或空回调 | 立即回调 `INVALID_PARAM`，不发包 | `robotserver_sdk.cpp:244-249` |
| 同步响应超时 | 等 `requestTimeout`(默认 3s) 后返回 TIMEOUT / false | `robotserver_sdk.cpp:202-210,338-345,398-407` |
| 连接超时 | `connectionTimeout`(默认 5s) 后 connect 返回 false | `asio_network_model.cpp:55-77` |
| 收/发 socket 错误 | 打印错误并 `disconnect()`，**不重连** | `asio_network_model.cpp:222-227,257-262` |
| 收到坏帧 / 未知 Type | `deserialize` 失败 → `nullptr` → **接收缓冲不清空**，可能卡死后续（见 §2.5） | `serializer.cpp:43-52`；`asio_network_model.cpp:236` |
| 响应 seq 不匹配 | 静默丢弃，最终超时 | `robotserver_sdk.cpp:482-488` |
| 回调抛异常 | `safeCallback` 兜住并打印，不崩 | `robotserver_sdk.cpp:56-79` |

- **无协议级错误响应帧**：除各消息 body 里的 `ErrorCode/ErrorStatus` 字段外，没有"通用错误帧/NACK"。机器人拒绝一个 1003，靠回 1003 RESP 带 `ErrorCode=1` + 具体 `ErrorStatus`（如 41745 导航进程未启动）表达。
- **重连责任在应用层**：SDK 断了就断了。adaptor 需自己实现「断线检测 + 退避重连 + 重连后重订阅/重轮询」。

---

## 7. Node/TS 实现要点

### 7.1 公共编解码（sim 与 adaptor 共用）
- **帧头 pack/unpack**（16 字节，全小端）：
  ```ts
  const SYNC = Buffer.from([0xEB, 0x90, 0xEB, 0x90]);
  function encodeFrame(seq: number, xmlBody: string): Buffer {
    const body = Buffer.from(xmlBody, 'utf8');
    const head = Buffer.alloc(16);
    SYNC.copy(head, 0);
    head.writeUInt16LE(body.length, 4);   // length = body 字节数（按 UTF-8 实际长度）
    head.writeUInt16LE(seq & 0xFFFF, 6);  // seq 小端
    // head[8..15] 已是 0
    return Buffer.concat([head, body]);
  }
  ```
- **流式拆帧**（务必按累积缓冲实现，TCP 无消息边界）：
  ```ts
  // 维护 acc: Buffer；每次 socket 'data' 事件 append 后循环取整帧
  while (acc.length >= 16) {
    if (!(acc[0]===0xEB && acc[1]===0x90 && acc[2]===0xEB && acc[3]===0x90)) {
      // 同步字丢失：可选择丢弃 1 字节重新找同步，或直接断链
    }
    const len = acc.readUInt16LE(4);
    if (acc.length < 16 + len) break;        // 半包，等更多
    const seq = acc.readUInt16LE(6);
    const body = acc.subarray(16, 16+len).toString('utf8');
    acc = acc.subarray(16+len);              // 消费掉这一帧
    handleFrame(seq, body);
  }
  ```
  > 我们**自己的两端都应支持多帧连续**（比官方 SDK 健壮）。但注意 **§7.3 的发包纪律**：面向「真官方 SDK」时不能背靠背连发。
- **XML**：body 用轻量拼接生成（如上样例），解析用 `fast-xml-parser` 之类读 `PatrolDevice.Type` 与 `PatrolDevice.Items.*`。字段名大小写敏感；数值按字符串取出再 `Number()`（注意 1007 的 `-1`、坐标的科学计数/小数）。

### 7.2 simulator（模拟机器人端 = TCP server）要实现的 server 面
1. `net.createServer()` 监听端口（默认 30000，可配）。接受连接，不做握手。
2. 对每条连接维护拆帧缓冲。收到帧后按 `<Type>` 分派：
   - **1002 REQ** → 立即回 **1002 RESP**（同 seq）：吐出当前（模拟的）姿态/电量/里程等 26 字段。
   - **1007 REQ** → 立即回 **1007 RESP**（同 seq）：`Value`=当前目标点、`Status`=(0 完成/1 执行中/-1 失败)、`ErrorCode`=同。
   - **1004 REQ** → 立即回 **1004 RESP**（同 seq）：`ErrorCode=0`；同时停掉当前导航任务；**【推断】随后补发 1003 RESP(cancelled)**（见下）。
   - **1003 REQ** → **不立即回**。解析出点列表，启动一个内部「导航任务」状态机，记住该帧 seq=`navSeq`。任务推进时更新内部「当前点/进度/姿态」，供 1002/1007 查询。
3. **导航任务状态机**（sim 的核心）：
   - 进入「执行中」；按时间推进模拟从点到点移动（可驱动 1002 的 PosX/Y 平滑变化）。
   - 终态到达时，用 `navSeq` 发**唯一一帧 1003 RESP**：
     - 正常走完：`ErrorCode=0, ErrorStatus=8960`。
     - 失败注入：`ErrorCode=1, ErrorStatus=41730/41729/...`（可做成可配置故障）。
     - 被 1004 取消：`ErrorCode=2, ErrorStatus=8962`。
   - 终态后 1007 查询应返回 `Status=0`（完成）或 `-1`（失败）。
4. **发包纪律**：**一帧一帧发**，每帧 = 16 头 + XML。**响应 seq 必须回填请求 seq**。响应体必带 `<Type>`。若要兼容"真 SDK"，**不要把两帧塞进一次 `socket.write` 且对端未及读取**（官方 SDK 会丢第二帧，见 §2.5）——最简单的安全策略：只在"收到请求"时"回一帧"，1003 终态帧则等对端处于轮询间隙时单独发（实际因 SDK 每次 `async_read` 后立刻重挂读、且清空缓冲，单帧到达总能被吃下，风险主要在"同一 TCP 段里粘了两帧"）。
5. 可选保真：REQ 里的 `<Time>`、`<Command>` 可忽略；`<Items/>`（1002/1004/1007）为空。

### 7.3 adaptor（协议客户端 → 平台）要实现的 client 面
1. **连接**：`net.connect(port, host)`。连接超时自管（默认 5s）。连上即认为可用（无握手）。
2. **序列号**：进程内 `uint16` 自增，首个=1，回绕到 0（复刻 SDK；也可从 1 开始自管，只要保证一次在途请求 seq 唯一即可）。**注意 65535→0 回绕**。
3. **请求/响应关联**：维护 `pending: Map<seq, {type, resolve, reject, timer}>`。发 REQ 时登记；收到 RESP 时按 `frameSeq` 找 pending，校验 `Type` 一致后 `resolve`。
   - **同步语义封装**：1002/1004/1007 封成返回 `Promise`，带 `requestTimeout`（默认 3s）超时 `reject`。
   - **1003 语义封装**：发 1003 后**不要**等一个即时响应；把 `navSeq → 任务回调/Promise` 单独登记，**收到该 seq 的 1003 RESP 时才结算**。★**务必自加超时兜底**（官方 SDK 这里会永久泄漏），例如整段任务级超时或"连续 N 次 1007 无进展"判失败。
   - 进度获取：用定时器轮询 1007（拿 Status/Value）与 1002（拿姿态/电量），把结果映射进平台的 telemetry/任务状态。
4. **健壮性**：
   - 拆帧用累积缓冲（§7.1），不要假设"一次 data = 一帧"。
   - 断线：监听 `error`/`close`，做**退避重连**；重连后重置 pending（reject 在途请求）、重启轮询。
   - 收到未知 Type / 坏 XML：记录并跳过该帧（我们比官方 SDK 宽容，不必卡死缓冲）。
5. **平台映射建议**（与 Plantbot 六域模型对接）：
   - 1002 → Reading/telemetry（pose、battery=Electricity、odometry、locationLost=Location==1）。
   - 1003 → 任务 Run 的下发；1003 RESP 的 `ErrorCode/ErrorStatus` → Run 终态与失败原因（用 §4.5.2 大表做人类可读文案）。
   - 1007 → 任务 Run 的进行中状态刷新。
   - 1004 → 任务取消 Command。
   - 导航点 14 字段基本透传；坐标系为机器人地图坐标（米/弧度）。

### 7.4 Node 选型坑位清单（务必留意）
1. **字节序**：length 与 seq 都是 **小端 uint16**；同步字/reserved 逐字节。别用大端。
2. **长度 = body 的 UTF-8 字节数**，不是字符数（含中文时尤其注意；本协议 body 基本 ASCII，但时间戳等仍按字节算）。
3. **`MapId`(wire XML) vs `MapID`(本地 JSON) 不一致**——解析/生成 REQ 用 `MapId`；读官方 JSON 配置用 `MapID`。
4. **1003 不是即时 ACK**：是任务终态。别在下发处 `await` 一个马上到来的响应。
5. **1003 无超时**是官方 bug，adaptor 必须自兜底。
6. **官方 SDK 接收端"单帧+整段清空"**：面向真 SDK 时，sim 不要在一个 TCP 段里粘多帧（否则第二帧被丢）；坏帧/未知 Type 会卡死其缓冲——sim 只发合法帧。
7. **无心跳/无重连/无鉴权**：连接保活与重连全在我们这边做。
8. **序列号进程级共享 + 回绕**：高并发下 seq 可能碰撞回绕，pending 用「seq+type」双判并配超时清理。
9. **负数状态值**：1007 的 `Status/ErrorCode` 可为 `-1`，按有符号解析。
10. **响应体最小集**即可被 SDK 接受（`<PatrolDevice><Type/><Items>…</Items></PatrolDevice>`，`<?xml>` 声明可选但建议带）；但字段名/层级必须精确匹配 §4。

---

## 8. 出处清单（逐文件）

仓库根：`/private/tmp/.../scratchpad/robotserver_sdk`（`github.com/DeepRoboticsLab/robotserver_sdk`，commit `f70df5e`）。

| 主题 | 文件 | 关键行 |
|---|---|---|
| 帧头结构（16B、同步字、length/seq/reserved） | `src/protocol/protocol_header.hpp` | 7-23 |
| 同步字常量 `EB 90 EB 90`、小端转换 | `src/protocol/protocol_header.cpp` | 5-9, 16-49 |
| 拆帧/长度校验/按 Type 建对象/序列化 | `src/protocol/serializer.cpp` | 9-79 |
| Type→消息类型映射(1002/1003/1004/1007) | `src/protocol/serializer.hpp` | 69-74 |
| 从 XML 提取 `<Type>`/`<Command>` | `src/protocol/serializer.cpp` | 99-155 |
| 各 REQ/RESP 的 XML 结构与字段解析 | `src/protocol/messages.hpp` | 63-466 |
| 1002 RESP 26 字段 | `src/protocol/messages.hpp` | 94-188 |
| 1003 REQ 导航点 14 字段（`<MapId>`）| `src/protocol/messages.hpp` | 18-33, 204-240 |
| 1003 RESP(Value/ErrorCode/ErrorStatus) | `src/protocol/messages.hpp` | 245-298 |
| 1004 REQ/RESP | `src/protocol/messages.hpp` | 393-466 |
| 1007 REQ/RESP(Value/Status/ErrorCode) | `src/protocol/messages.hpp` | 303-388 |
| 时间戳格式 `%Y-%m-%d %H:%M:%S` | `src/protocol/messages.hpp` | 39-45 |
| MessageType 枚举、ErrorCode_CancelTask、createMessage | `src/protocol/message_interface.hpp/.cpp` | hpp 11-47；cpp 6-27 |
| TCP、异步 connect+超时、收发、断开、无重连 | `src/network/asio_network_model.cpp` | 25-286 |
| 收包 4096 缓冲、`receive_data_` 累积、**单帧后 clear** | `src/network/asio_network_model.cpp` | 221-254 |
| socket 类型=tcp、buffer 大小 | `src/network/asio_network_model.hpp` | 96-103 |
| 序列号生成(static atomic,++,回绕)、pending 配对、**1003 无超时清理 TODO** | `src/robotserver_sdk.cpp` | 498-543, 525-528, 540 |
| 四个 request 方法(同步阻塞/异步回调)、超时/错误码本地态 | `src/robotserver_sdk.cpp` | 168-441 |
| 1003 结果回调路由(按 seq，erase) | `src/robotserver_sdk.cpp` | 444-494 |
| 对外类型/枚举(含 ErrorStatus_Navigation 全表、Location 语义) | `include/types.h` | 14-207 |
| 公共 API 签名 | `include/robotserver_sdk.h` | 19-96 |
| 默认超时(连接 5s/请求 3s) | `include/types.h` | 197-200 |
| 主机/端口示例 192.168.1.106:30000、106 主机禁装、X30 手册 | `README.zh-CN.md` / `README.en.md` | 7, 43-59 |
| 4 个导航点真实样例(JSON，键用 `MapID`) | `examples/basic/default_navigation_points.json` | 全文 |
| 轮询式用法(发 1003→轮询 1007/1002→超时则 1004) | `examples/basic/basic_example.cpp` | 133-226 |
| 三层架构、同步/异步时序图、"两个线程" | `docs/zh-CN/architecture.zh-CN.md` | 40-42, 168-242 |
| API 参考(枚举/结构体镜像) | `docs/zh-CN/api_reference.zh-CN.md` | 99-330 |
| 依赖(Boost/nlohmann/rapidxml)、C++17 | `CMakeLists.txt` | 21-23；`scripts/install_dependencies.sh` |

### 未能从官方材料确证、已标注的推断项汇总
- **1003 RESP 为任务终态、非即时 ACK**：强证据（示例轮询模式 + 每 seq 单回调），但机器人侧代码不在本仓库 → 归为高置信【推断】。
- **1004 取消后机器人补发 1003(cancelled)**：由枚举 8962/CANCELLED 与示例流程推断，源码未直接证明 → 【推断】。
- **机器人=30000 端口 TCP server、坐标单位米/角度弧度**：端口来自示例；单位由样例值域（±π）与字段名推断 → 端口【示例值/约定】、单位【推断】。
- **机型差异**：本 SDK 面向 X30；Lite3 走独立 `Lite3_MotionSDK` → 【推断】（依据组织仓库列表，非本仓库内容）。
- **Web 检索**：`deeprobotics.cn/.us`、GitHub 组织页均无公开的 PatrolDevice/Type 协议表；本 SDK 源码即当前唯一权威来源。README 提及《绝影 X30 Pro 应用手册》但仓库未附下载 URL，无法抓取。
