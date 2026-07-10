# Boston Dynamics Spot — 官方 gRPC 协议参考

> 调研时间：2026-07-10。来源：`spot-sdk` 仓库 `master` 分支 `protos/bosdyn/api/**`（proto 权威定义，
> 已 vendored 到 [`integrations/spot/protos/`](../../integrations/spot/protos/)）＋ dev.bostondynamics.com
> 概念文档 ＋ `python/bosdyn-client` 官方客户端源码（用于确证 proto 里没有的运行期常量：keep-alive 频率、
> token header、端口）。
>
> 目的：用 Node.js/TypeScript（`@grpc/grpc-js` + `@grpc/proto-loader`）实现一对
> **simulator（模拟 Spot，实现官方 gRPC server 面）** + **adaptor（mini bosdyn-client，作 gRPC client
> 连 sim/真机，翻译到 Plantbot HTTP 集成 API）**。**必须忠实还原官方 API**。
>
> 每个结论标注出处：`proto: bosdyn/api/xxx.proto` 指 vendored proto 文件；`py: client/xxx.py` 指官方
> Python 客户端；URL 指概念文档。无法从权威源确证的点标 **UNVERIFIED**。proto 字段名保持英文原文。

---

## 0. 一句话总览

会话舞蹈 = **发现服务（Directory/RobotId）→ 认证拿 token（AuthService）→ 时间同步（TimeSyncService）→
拿租约（LeaseService.AcquireLease + 每 2s RetainLease 保活）→ 注册并持续应答急停挑战（EstopService，周期 =
timeout/3）→ 上电（PowerService PowerCommand ON_MOTORS）→ 之后才能发 RobotCommand / GraphNav 运动指令**，
全程 token 走 HTTP/2 metadata `authorization: Bearer <token>`。

---

## 1. gRPC 连接与全局约定

### 1.1 传输层

| 项 | 值 | 出处 |
|---|---|---|
| 端口 | **443**（`_DEFAULT_SECURE_CHANNEL_PORT = 443`） | py: `client/robot.py` |
| 传输 | TLS。真机用**自签名证书**，客户端用随机器人分发的 root cert 校验（`grpc.ssl_channel_credentials(root_certificates=cert)`） | py: `client/channel.py` |
| SNI / authority | 每个 service 有自己的 **authority**，client 用 `grpc.ssl_target_name_override = <authority>` 覆盖 TLS 目标名 & `:authority` header 来路由 | py: `client/channel.py` |
| token 下发 | HTTP/2 call metadata：key=`authorization`，value=`Bearer <user_token>`，每个 RPC 都带（用 `metadata_call_credentials` 插件在每次调用刷新） | py: `client/channel.py:45` |
| 本地/payload 场景 | 也支持明文 `create_insecure_channel(address, port, authority)` | py: `client/channel.py` |

**channel 拓扑**：所有 service 都指向同一个 `robot_ip:443`，但**每个 service 用各自的 authority**（一个
authority 一条 channel，`bosdyn` 内部按 authority 缓存复用）。authority 从 Directory 查得（见 §7）。

> Node 侧：`@grpc/grpc-js` 里，per-service 的 authority 用 channel option `grpc.default_authority` 设置；
> 自签名 + 名称覆盖用 `grpc.ssl_target_name_override`。给 sim 做本地联调时建议直接用
> `grpc.credentials.createInsecure()`（明文），省去证书。

### 1.2 通用 header（所有 request/response 都内嵌）

`proto: bosdyn/api/header.proto`

**RequestHeader**（每个 `*Request` 的 `header` 字段）：
- `google.protobuf.Timestamp request_timestamp = 1` — 客户端本地时钟发送时刻
- `string client_name = 2` — 客户端标识（惯例：程序名+PID）
- `bool disable_rpc_logging = 3`

**ResponseHeader**（每个 `*Response` 的 `header` 字段）：
- `RequestHeader request_header = 1` — 回显
- `google.protobuf.Timestamp request_received_timestamp = 2` / `response_timestamp = 3` — **服务器时钟**
- `CommonError error = 4` — 通用错误；**非空时 response 其余字段无效**
- `google.protobuf.Any request = 5` — 回显请求（可能被裁剪）

**CommonError.Code**（`error.code`）：`CODE_UNSPECIFIED=0`、`CODE_OK=1`、`CODE_INTERNAL_SERVER_ERROR=2`、
`CODE_INVALID_REQUEST=3`。`message` 为人读文本，`data` 为 `Any`。

> 约定：先看 `header.error.code`（传输/通用层错误），再看各 response 自己的 `status` 枚举（业务层结果）。
> 两层错误模型是 bosdyn 全 API 一致的惯例。

---

## 2. 会话舞蹈（session dance）

### 2.0 keep-alive 频率总表（实现必须照抄）

| 循环 | 官方默认频率 | 超时后果 | 出处 |
|---|---|---|---|
| **TimeSyncUpdate** | 建立后每 **60s**；未就绪时每 **5s** 轮询 | 时间同步失效，带时限的命令被拒（`STATUS_NO_TIMESYNC`） | py: `client/time_sync.py`（`DEFAULT_TIME_SYNC_INTERVAL_SEC=60`, `TIME_SYNC_SERVICE_NOT_READY_INTERVAL_SEC=5`） |
| **RetainLease** | 每 **2s**（`LeaseKeepAlive rpc_interval_seconds=2`） | 租约变 stale，可被他人 `AcquireLease` 抢走 | py: `client/lease.py:880` |
| **EstopCheckIn** | 每 **`estop_timeout/3`** 秒（endpoint 注册时设 timeout，check-in 周期 = 1/3） | 到 timeout 触发 `SETTLE_THEN_CUT`（坐下再断电）；`cut_power_timeout` 到则直接 `CUT` | py: `client/estop.py:462`；URL estop_service |

这三个循环各自开线程，运动全程持续跑。三者都独立于运动指令。

### 2.1 发现：DirectoryService / RobotIdService（无需 token）

- `RobotIdService.GetRobotId` → `RobotId{serial_number, species('spot'), version, software_release, nickname, computer_serial_number}`。**不需要认证**，用于早期发现。`proto: robot_id.proto / robot_id_service.proto`
- `DirectoryService.ListServiceEntries` → `[]ServiceEntry`；`GetServiceEntry(service_name)`。每条
  `ServiceEntry{name, type(如 "bosdyn.api.AuthService"), authority, user_token_required, permission_required, liveness_timeout_secs}`。client 据此拿到每个 service 的 **authority** 来建 channel。`proto: directory.proto`
- URL 拼法：`https://<authority>/bosdyn.api.<ServiceType>`；`user_token_required=false` 的只有
  `auth`、`robot-id`（其余全需 token）。出处：URL base_services、`proto: directory.proto`（`user_token_required`）。

### 2.2 认证：AuthService.GetAuthToken

`proto: auth.proto / auth_service.proto`

- `rpc GetAuthToken(GetAuthTokenRequest) returns (GetAuthTokenResponse)`
- **Request**：`header`、`string username=2`、`string password=3`、`string token=4`（可用旧 token 重新
  minting，免密码）。字段 5（旧 application token）已在 4.0 移除（`reserved 5`）。
- **Response**：`status`、`string token=3`（仅 `STATUS_OK` 时填）。
- **Status 枚举**：`STATUS_UNKNOWN=0`、`STATUS_OK=1`、`STATUS_INVALID_LOGIN=2`、`STATUS_INVALID_TOKEN=3`、
  `STATUS_TEMPORARILY_LOCKED_OUT=4`。
- **token 怎么带**：拿到的 token 放进之后**每个** RPC 的 HTTP/2 metadata：`authorization: Bearer <token>`
  （py: `client/channel.py:45`）。这是唯一的传递方式，**不是** proto 字段。
- token 是 JWT，**robot-specific、约 12 小时有效**（URL base_services）；快过期用 `token` 字段重新 mint。
  连续 6 次失败锁 1 分钟（URL base_services，对应 `STATUS_TEMPORARILY_LOCKED_OUT`）。

### 2.3 时间同步：TimeSyncService.TimeSyncUpdate

`proto: time_sync.proto / time_sync_service.proto`

- `rpc TimeSyncUpdate(TimeSyncUpdateRequest) returns (TimeSyncUpdateResponse)`（一元，反复调用逼近）。
- **为什么必须**：Spot 所有带时限的运动命令（RobotCommand、GraphNav）都要求 `end_time` 用**机器人时钟**
  表达，并带 `clock_identifier`；没有 time-sync，命令被 `STATUS_NO_TIMESYNC` 拒。时间同步把「网络延迟」和
  「client↔server 时钟偏差」解耦，让 client 能用自己的时钟算出准确的机器人时刻。
- **握手机制**：
  - Request：`header`、`TimeSyncRoundTrip previous_round_trip=2`、`string clock_identifier=3`（首次留空，
    server 分配后回传，之后每次回填）。
  - `TimeSyncRoundTrip{client_tx, server_rx, server_tx, client_rx}` — 一次完整往返的四个时间戳；client 在
    **下一次** request 里把上一轮的 `client_tx`（本次发送前记）、`client_rx`（上次收到时记）连同 server 回的
    `server_rx/server_tx` 一起送回，server 据此算 skew。
  - Response：`TimeSyncEstimate previous_estimate{round_trip_time, clock_skew}`、`TimeSyncState state`、
    `clock_identifier`。
  - `TimeSyncState.Status`：`STATUS_UNKNOWN=0`、`STATUS_OK=1`、`STATUS_MORE_SAMPLES_NEEDED=2`（还要几轮）、
    `STATUS_SERVICE_NOT_READY=3`。要 poll 到 `STATUS_OK` 才算建立。
  - **clock_skew 语义**：`server_clock = client_clock + clock_skew`（proto 注释原文：“Add the skew to the
    client system clock to get the server clock”）。命令 `end_time` = 期望的机器人时刻 = `now_client + skew + 时长`。

### 2.4 租约：LeaseService

`proto: lease.proto / lease_service.proto`；URL lease_service

- RPC：`AcquireLease`、`TakeLease`、`ReturnLease`、`ListLeases`、`RetainLease`（**全部一元**）。
- **资源层级**（`ResourceTree`，根 = `"body"`）：`body` 是整机；子资源含 `mobility`（腿）、`arm`、`gripper`、
  `full-arm` 等。**持有父资源 = 控制整棵子树**（URL lease_service）。多数 app 直接 acquire `"body"`。
  （py: `client/lease.py` `_RESOURCE_BODY='body'`）
- **Lease 消息**：`{resource, epoch, repeated uint32 sequence, repeated string client_names}`。`sequence` 是
  逻辑向量时钟：委派给子服务时追加一位（如 `[3]`→`[3,1]`），机器人据此判定新旧。
- **流程**：
  1. `AcquireLease{resource:"body"}` → `AcquireLeaseResponse{status, lease, lease_owner}`。
     Status：`STATUS_UNKNOWN=0`、`STATUS_OK=1`、`STATUS_RESOURCE_ALREADY_CLAIMED=2`（用 `TakeLease` 强夺）、
     `STATUS_INVALID_RESOURCE=3`、`STATUS_NOT_AUTHORITATIVE_SERVICE=4`。
  2. 拿到 lease 后**立即**起 `RetainLease` 保活（每 2s，见总表）。`RetainLeaseResponse.lease_use_result` 报结果。
  3. 每个需要控制权的命令（PowerCommand / RobotCommand / GraphNav）**把当前 lease 塞进 request 的 `lease`
     字段**；机器人回 `LeaseUseResult` 告知是否被接受。
  4. 收尾 `ReturnLease{lease}`。
- **LeaseUseResult.Status**（命令回执里判断控制权是否有效）：`STATUS_UNKNOWN=0`、`STATUS_OK=1`、
  `STATUS_INVALID_LEASE=2`、`STATUS_OLDER=3`（你的租约比当前旧，被拒）、`STATUS_REVOKED=4`（没按时保活被回收）、
  `STATUS_UNMANAGED=5`、`STATUS_WRONG_EPOCH=6`。还带 `owner / attempted_lease / latest_known_lease` 便于恢复。
- **staleness**：`LeaseResource.is_stale`（3.3 起由 Keepalive service 管理，`stale_time` 字段已 deprecated）。
  stale 租约仍可用一次（用后即不再 stale），但可被别人 Acquire。

> ⚠️ **实现坑（proto 与注释不一致）**：`lease.proto` 里 `RetainLease` 的注释提到 “bidirectional streaming
> request”，但 `lease_service.proto` 的**实际 service 定义是一元** `rpc RetainLease(RetainLeaseRequest)
> returns (RetainLeaseResponse)`。**以 service 定义为准：一元**，客户端定时轮询式调用。

### 2.5 急停：EstopService

`proto: estop.proto / estop_service.proto`；URL estop_service；py: `client/estop.py`

软件急停是**挑战/应答心跳**，证明「有个活的、负责的 client 在线」；断了就切电机电源。

- RPC：`RegisterEstopEndpoint`、`DeregisterEstopEndpoint`、`EstopCheckIn`、`GetEstopConfig`、
  `SetEstopConfig`、`GetEstopSystemStatus`。
- **EstopEndpoint**：`{role(如 "PDB_rooted"/"OCU"), name, unique_id(server 分配), Duration timeout,
  Duration cut_power_timeout}`。
- **注册**：`RegisterEstopEndpoint{target_endpoint, target_config_id, new_endpoint}` → 回填带 `unique_id`
  的 `new_endpoint`。通常先 `GetEstopConfig` 拿到 `active_config.unique_id` 作 `target_config_id`（或
  `SetEstopConfig` 新建一个含本 endpoint 的 config）。
  - Register Status：`STATUS_UNKNOWN=0`、`STATUS_SUCCESS=1`、`STATUS_ENDPOINT_MISMATCH=2`、
    `STATUS_CONFIG_MISMATCH=3`、`STATUS_INVALID_ENDPOINT=4`。
- **CheckIn（心跳）**：`EstopCheckInRequest{header, endpoint, uint64 challenge, uint64 response, stop_level}`
  → `EstopCheckInResponse{request, uint64 challenge(下一个待答), status}`。
  - **挑战/应答算法**：`response = 上一次 response 里收到的 challenge 的 uint64 按位取反（1's complement）`。
    权威实现：`response_from_challenge(challenge) = ctypes.c_ulonglong(~challenge).value`（py:
    `client/estop.py:644`）。即 Node 里 `response = (~BigInt(challenge)) & 0xFFFFFFFFFFFFFFFFn`。
  - **首次 check-in** 没有 challenge 可答 → server 回 `STATUS_INCORRECT_CHALLENGE_RESPONSE`，**可安全忽略**，
    从这次响应里取到第一个真正的 challenge，下次再答（URL estop_service；py `suppress_incorrect`）。
  - CheckIn Status：`STATUS_UNKNOWN=0`、`STATUS_OK=1`、`STATUS_ENDPOINT_UNKNOWN=2`、
    `STATUS_INCORRECT_CHALLENGE_RESPONSE=5`。答错**不刷新** timeout。
- **授予运行权（ATO）**：check-in 时把 `stop_level` 设为 `ESTOP_LEVEL_NONE`（表示「我认为可以安全运行」）。
- **EstopStopLevel**：`ESTOP_LEVEL_UNKNOWN=0`、`ESTOP_LEVEL_CUT=1`（立即断电）、
  `ESTOP_LEVEL_SETTLE_THEN_CUT=2`（先坐下再断电）、`ESTOP_LEVEL_NONE=4`（放行）。
- **超时后果**：超过 `timeout` 无有效应答 → 等效 `SETTLE_THEN_CUT`（试图停稳、坐下、再断电机电源）；
  再过 `cut_power_timeout`（不设则默认 timeout + 约 3–4s）→ 等效 `CUT` 立即断电。check-in 周期取
  `timeout/3`（总表）。

### 2.6 上电：PowerService.PowerCommand

`proto: power.proto / power_service.proto`

- RPC：`PowerCommand`、`PowerCommandFeedback`、`FanPowerCommand`、`FanPowerCommandFeedback`、
  `GetFanInformation`、`ResetSafetyStop`。
- **PowerCommandRequest**：`{header, Lease lease, Request request}`。`Request` 枚举关键值：
  `REQUEST_OFF_MOTORS=1`、`REQUEST_ON_MOTORS=2`（上电机电源，就是我们要的）、`REQUEST_OFF_ROBOT=3`、
  `REQUEST_CYCLE_ROBOT=4`、`REQUEST_OFF/ON_PAYLOAD_PORTS=5/6`、`REQUEST_OFF/ON_WIFI_RADIO=7/8`、
  `REQUEST_SOFT_REBOOT_ROBOT=9`。（`REQUEST_ON=2`/`REQUEST_OFF=1` 是 `allow_alias` 的老名，等价。）
- **PowerCommandResponse**：`{header, lease_use_result, PowerCommandStatus status, uint32 power_command_id,
  license_status, repeated SystemFault blocking_faults}`。`power_command_id` 拿去 `PowerCommandFeedback`
  轮询直到 `STATUS_SUCCESS`。
- **PowerCommandStatus**（顶层枚举，request 回执与 feedback 共用）：`STATUS_UNKNOWN=0`、`STATUS_IN_PROGRESS=1`、
  `STATUS_SUCCESS=2`、`STATUS_SHORE_POWER_CONNECTED=3`（插着市电不能上电）、`STATUS_BATTERY_MISSING=4`、
  `STATUS_COMMAND_IN_PROGRESS=5`、`STATUS_ESTOPPED=6`（急停中不能上电）、`STATUS_FAULTED=7`、
  `STATUS_INTERNAL_ERROR=8`、`STATUS_LICENSE_ERROR=9`、`INCOMPATIBLE_HARDWARE_ERROR=10`、`STATUS_OVERRIDDEN=11`、
  `STATUS_KEEPALIVE_MOTORS_OFF=12`。
- 上电**前提**：必须已 acquire lease、已注册 estop endpoint 且 check-in 放行（`ESTOP_LEVEL_NONE`），否则回
  `STATUS_ESTOPPED`。
- 下电惯例：安全下电走 `RobotCommand` 的 `SafePowerOffCommand`（先坐下再断电），或直接 `REQUEST_OFF_MOTORS`。

---

## 3. RobotStateService.GetRobotState

`proto: robot_state.proto / robot_state_service.proto`

- `rpc GetRobotState(RobotStateRequest) returns (RobotStateResponse)` → `RobotStateResponse.robot_state`。
  （另有 `GetRobotMetrics`、`GetRobotHardwareConfiguration`、`GetRobotLinkModel`；BETA 流式
  `RobotStateStreamingService.GetRobotStateStream`。）

**RobotState**（逐字段，标注我们平台关心的子树）：

- `PowerState power_state = 1`
- `repeated BatteryState battery_states = 2`
- `repeated CommsState comms_states = 3`
- `SystemFaultState system_fault_state = 4`
- `repeated EStopState estop_states = 5`
- `KinematicState kinematic_state = 6`
- `BehaviorFaultState behavior_fault_state = 7`
- `repeated FootState foot_state = 8`
- `ManipulatorState manipulator_state = 11`（仅带臂）
- `ServiceFaultState service_fault_state = 10`
- `TerrainState terrain_state = 12`、`SystemState system_state = 13`、`BehaviorState behavior_state = 14`

### 3.1 battery_states —— `BatteryState`
- `Timestamp timestamp`、`string identifier`
- `DoubleValue charge_percentage = 3` — **0–100 电量**（注意是 `google.protobuf.DoubleValue` 包装类型，见坑）
- `Duration estimated_runtime = 4`、`DoubleValue current = 5`（+充/−放，安培）、`DoubleValue voltage = 6`、
  `repeated double temperatures = 7`、`DoubleValue communications_loss_percent = 9`
- `Status status = 8`：`STATUS_UNKNOWN=0`、`STATUS_MISSING=1`、`STATUS_CHARGING=2`、`STATUS_DISCHARGING=3`、
  `STATUS_BOOTING=4`

### 3.2 power_state —— `PowerState`
- `Timestamp timestamp`
- `MotorPowerState motor_power_state = 2`（`allow_alias`，新名）：`MOTOR_POWER_STATE_UNKNOWN=0`、
  `MOTOR_POWER_STATE_OFF=1`、`MOTOR_POWER_STATE_ON=2`、`MOTOR_POWER_STATE_POWERING_ON=3`、
  `MOTOR_POWER_STATE_POWERING_OFF=4`、`MOTOR_POWER_STATE_ERROR=5`（旧名 `STATE_OFF/ON/...` 已 deprecated 但同值）
- `ShorePowerState shore_power_state = 3`：`SHORE_POWER_STATE_UNKNOWN=0/ON=1/OFF=2`
- `RobotPowerState robot_power_state = 6`、`PayloadPortsPowerState=7`、`WifiRadioPowerState=9`
- `DoubleValue locomotion_charge_percentage = 4` — 整机运动可用电量摘要（0–100）
- `Duration locomotion_estimated_runtime = 5`

### 3.3 kinematic_state —— `KinematicState`
- `repeated JointState joint_states = 2`（`name/position/velocity/acceleration/load`，都是 `DoubleValue`）
- `Timestamp acquisition_timestamp = 30`
- `FrameTreeSnapshot transforms_snapshot = 31` — **帧树快照**，含 `odom`/`vision`/`body`/`flat_body`/`gpe`/
  `feet_center` 等（见 §3.7）。机器人位姿 = 从这棵树里取 `odom_tform_body` 或 `vision_tform_body`。
- `SE3Velocity velocity_of_body_in_vision = 8` / `velocity_of_body_in_odom = 12` — 机体速度（线+角）

> 取机器人当前位姿：遍历 `transforms_snapshot.child_to_parent_edge_map`，找 `body` 的父边得到
> `<parent>_tform_body`（parent 通常是 `odom` 或 `vision`），或反查拼链。见 §3.7 帧树语义。

### 3.4 system_fault_state —— `SystemFaultState`
- `repeated SystemFault faults = 1`（当前）、`historical_faults = 2`（近 10min 已清除）、
  `map<string, SystemFault.Severity> aggregated = 3`（按 attribute 聚合最高级别，快速判断有无 "battery"/"vision" 类故障）
- `SystemFault`：`{name, onset_timestamp, duration, int32 code, string uuid, error_message,
  repeated string attributes, Severity severity, string dtc}`。
  `Severity`：`SEVERITY_UNKNOWN=0/INFO=1/WARN=2/CRITICAL=3`。

### 3.5 behavior_fault_state —— `BehaviorFaultState`
- `repeated BehaviorFault faults = 1`
- `BehaviorFault`：`{uint32 behavior_fault_id, onset_timestamp, Cause cause, Status status}`。
  `Cause`：`CAUSE_UNKNOWN=0/FALL=1/HARDWARE=2/LEASE_TIMEOUT=3`。
  `Status`：`STATUS_UNKNOWN=0/CLEARABLE=1/UNCLEARABLE=2`。
  用 `behavior_fault_id` 调 `RobotCommandService.ClearBehaviorFault` 清除（见 §4）。

### 3.6 estop_states —— `repeated EStopState`
- `EStopState`：`{timestamp, string name, Type type, State state, string state_description}`。
  `Type`：`TYPE_UNKNOWN=0/HARDWARE=1/SOFTWARE=2`。
  `State`：`STATE_UNKNOWN=0/ESTOPPED=1/NOT_ESTOPPED=2`。
  **一台机器人有多个 estop，全部 `NOT_ESTOPPED` 才能跑**（proto 注释原文）。

### 3.7 帧树语义（`FrameTreeSnapshot`，`proto: geometry.proto`）
- 结构：`map<string, ParentEdge> child_to_parent_edge_map`，`ParentEdge{parent_frame_name,
  SE3Pose parent_tform_child}`。单根树；N 帧只存 N 条边，其余靠**求逆**（`a_tform_b = b_tform_a.inverse()`）
  和**串接**（`body_tform_hand = body_tform_shoulder * shoulder_tform_hand`）得到。
- 服务默认至少含 `vision`、`body`、`odom` 三帧。语义（`proto: robot_state.proto` KinematicState 注释）：
  - **`odom`**：惯性系，仅靠运动学里程计估计开机点的固定位置——**会漂移**，但短期平滑。
  - **`vision`**：惯性系，融合里程计+视觉估计固定世界位置——**长期更准**，但可能有跳变。
  - **`body`**：机体系，原点在髋部几何中心，x 轴指向前髋中点。
  - **`flat_body`**：`body` 的重力对齐版（x/y 躺平在 `odom` 的 x-y 平面）。**速度命令的 frame** 只能用
    `vision`/`odom`/`flat_body`。
  - 另有 `gpe`（地平面估计）、`feet_center`。轨迹命令的 frame 只能用 `vision`/`odom`/`body`（见 §4）。

---

## 4. RobotCommandService

`proto: robot_command.proto / robot_command_service.proto` + `basic_command.proto` +
`mobility_command.proto` + `synchronized_command.proto` + `full_body_command.proto`

- RPC：`RobotCommand`、`RobotCommandFeedback`、`ClearBehaviorFault`（另有 BETA 流式
  `RobotCommandStreamingService.JointControlStream`）。

### 4.1 命令封装结构（三层 oneof）

```
RobotCommandRequest{ header, Lease lease, RobotCommand command, string clock_identifier }
  RobotCommand.command  oneof:
    ├─ FullBodyCommand.Request full_body_command   # 整机独占（stop/selfright/safe_power_off/battery_change...）
    └─ SynchronizedCommand.Request synchronized_command   # 分部/整机（推荐路径）
         SynchronizedCommand.Request:
           ├─ ArmCommand.Request      arm_command      # 带臂才有
           ├─ MobilityCommand.Request mobility_command # 底盘运动 ← 我们主要用这个
           └─ GripperCommand.Request  gripper_command
             MobilityCommand.Request.command  oneof:
               ├─ SE2TrajectoryCommand.Request se2_trajectory_request  # goto 点
               ├─ SE2VelocityCommand.Request   se2_velocity_request    # 速度
               ├─ SitCommand.Request           sit_request
               ├─ StandCommand.Request         stand_request
               ├─ StanceCommand / StopCommand / FollowArmCommand / FreezeCommand ...
```

> 注意：4.0 起 `RobotCommand` 只有 `full_body_command` 和 `synchronized_command` 两个 oneof 分支（旧的顶层
> `mobility_command` 已 `reserved 2`，改走 `synchronized_command.mobility_command`）。`proto: robot_command.proto`

- **RobotCommandRequest** 必带 `clock_identifier`（来自 time-sync，§2.3），否则 `STATUS_NO_TIMESYNC`。
- **RobotCommandResponse**：`{header, lease_use_result, Status status, string message, uint32 robot_command_id}`。
  拿 `robot_command_id` 去 `RobotCommandFeedback` 轮询。
  **Status**：`STATUS_UNKNOWN=0`、`STATUS_OK=1`、`STATUS_INVALID_REQUEST=2`、`STATUS_UNSUPPORTED=3`、
  `STATUS_NO_TIMESYNC=4`、`STATUS_EXPIRED=5`（end_time 已过）、`STATUS_TOO_DISTANT=6`（end_time 太远）、
  `STATUS_NOT_POWERED_ON=7`、`STATUS_UNKNOWN_FRAME=8`、`STATUS_BEHAVIOR_FAULT=9`、`STATUS_DOCKED=10`。

### 4.2 goto 点：SE2TrajectoryCommand
`proto: basic_command.proto` + `trajectory.proto` + `geometry.proto`
- **Request**：
  - `Timestamp end_time = 1`（**必填**，机器人时钟；防跑飞——超时机器人自动停）
  - `string se2_frame_name = 3`（**只能 `vision`/`odom`/`body`**，须重力对齐帧）
  - `SE2Trajectory trajectory = 2`
- `SE2Trajectory{ repeated SE2TrajectoryPoint points, Timestamp reference_time, PositionalInterpolation
  interpolation }`；`SE2TrajectoryPoint{ SE2Pose pose, Duration time_since_reference }`。
- `SE2Pose{ Vec2 position(x,y 米), double angle(弧度) }`。单点 goto = 一个 point。
- **Feedback**（`SE2TrajectoryCommand.Feedback`）：
  - `Status status`（`option allow_alias`！）：`STATUS_UNKNOWN=0`、`STATUS_STOPPED=1`、`STATUS_IN_PROGRESS=2`、
    `STATUS_STOPPING=3`。**别名**：`STATUS_AT_GOAL=1`（=STOPPED）、`STATUS_GOING_TO_GOAL=2`（=IN_PROGRESS）、
    `STATUS_NEAR_GOAL=3`（=STOPPING）——后三个是 deprecated 老名，**同值**（见 §8 enum 坑）。
  - `BodyMovementStatus body_movement_status`：`BODY_STATUS_UNKNOWN=0/MOVING=1/SETTLED=2`。
  - `FinalGoalStatus final_goal_status = 5`：`..._UNKNOWN=0/IN_PROGRESS=1/ACHIEVABLE=2/BLOCKED=3`。
  - 判「到达」= `status==STATUS_STOPPED(1)` 且 `body_movement_status==BODY_STATUS_SETTLED(2)`。

### 4.3 速度：SE2VelocityCommand
- **Request**：`Timestamp end_time=1`（**必填，兼作 deadman**——到点即停，持续运动要滚动刷新 end_time 反复发）、
  `string se2_frame_name=5`（**只能 `vision`/`odom`/`flat_body`**）、`SE2Velocity velocity=2`
  （`{Vec2 linear(m/s), double angular(rad/s)}`）、`SE2Velocity slew_rate_limit=4`（限制速度变化率/加速度，非负）。
- **Feedback**：只有 `request_information`（回显目标速度），无到达语义——靠 end_time 控制时长。

### 4.4 stand / sit（`BasicCommand`）
- `StandCommand.Request{}`（无参）；Feedback `Status`：`STATUS_UNKNOWN=0/IS_STANDING=1/IN_PROGRESS=2`，
  另有 `StandingState`：`STANDING_UNKNOWN=0/CONTROLLED=1/FROZEN=2`。
- `SitCommand.Request{}`；Feedback `Status`：`STATUS_UNKNOWN=0/IS_SITTING=1/IN_PROGRESS=2`。

### 4.5 各命令共享的整体状态字段
`MobilityCommand.Feedback`（及 FullBody）末尾都带 `RobotCommandFeedbackStatus.Status status = 100`：
`STATUS_UNKNOWN=0`、`STATUS_PROCESSING=1`（正在执行）、`STATUS_COMMAND_OVERRIDDEN=2`（被新命令替换）、
`STATUS_COMMAND_TIMED_OUT=3`、`STATUS_ROBOT_FROZEN=4`、`STATUS_INCOMPATIBLE_HARDWARE=5`。
读 feedback 时**先看这个 status==PROCESSING**，再看具体子命令的 status。`proto: basic_command.proto`

### 4.6 清障：ClearBehaviorFault
`ClearBehaviorFaultRequest{header, lease, uint32 behavior_fault_id}` →
`ClearBehaviorFaultResponse{status: STATUS_UNKNOWN=0/CLEARED=1/NOT_CLEARED=2, behavior_fault,
blocking_system_faults}`。behavior_fault_id 来自 §3.5。

---

## 5. GraphNavService（地图导航）

`proto: graph_nav/graph_nav_service.proto` + `graph_nav/graph_nav.proto` + `graph_nav/nav.proto`

waypoint/edge 模型一句话：地图是**图**，节点=`Waypoint`、边=`Edge`（带 `Edge.Id`）；机器人先定位到某
waypoint，再沿图规划路径。定位状态 = `Localization{waypoint_id, SE3Pose waypoint_tform_body,
SE3Pose seed_tform_body, timestamp}`（`proto: nav.proto`）。

### 5.1 NavigateToAnchor（**可用**，我们主用）
在 **anchoring / seed 坐标系**里给一个连续目标点，GraphNav 自己选最近可达 waypoint 并规划直达。
`proto: graph_nav/graph_nav.proto`（message `NavigateToAnchorRequest`，`rpc NavigateToAnchor` 定义在
`graph_nav_service.proto`）。

**NavigateToAnchorRequest** 全字段：
- `header`
- `repeated Lease leases = 2` — **注意是 repeated**：要同时带**机器人 lease 和 graph lease**
- `oneof goal`：
  - `SE3Pose seed_tform_goal = 3` — 目标在 seed 帧的位姿（z 用于选 waypoint，最终高度随地形）
  - `GPSNavigationParams gps_navigation_params = 11` — 或给 GPS 目标（`goal_llh`、`goal_yaw`、`max_distance_from_map`）
- `Vec3 goal_waypoint_rt_seed_ewrt_seed_tolerance = 4` — 选目标 waypoint 的 x/y/z 容差（负/太小则用默认）
- `RouteGenParams route_params = 6`、`TravelParams travel_params = 7`（见 §5.4）
- `Timestamp end_time = 8`（机器人时钟，命令有效期）、`string clock_identifier = 9`（time-sync）
- `RouteFollowingParams.RouteBlockedBehavior route_blocked_behavior = 12`
- `uint32 command_id = 10` — 0=新命令；非 0=续命令（续命令时其余参数被忽略，沿用旧参数）

**NavigateToAnchorResponse**：`{header, repeated lease_use_results, Status status, impaired_state,
uint32 command_id, repeated error_waypoint_ids, area_callback_error, GPSStatus gps_status}`。
**Status**：`STATUS_UNKNOWN=0/OK=1/NO_TIMESYNC=2/EXPIRED=3/TOO_DISTANT=4/ROBOT_IMPAIRED=5/RECORDING=6/
NO_ANCHORING=7/NO_PATH=8/FEATURE_DESERT=10/LOST=11/COULD_NOT_UPDATE_ROUTE=12/NOT_LOCALIZED_TO_MAP=13/
STUCK=14/UNRECOGNIZED_COMMAND=15/INVALID_POSE=16/AREA_CALLBACK_ERROR=17/INVALID_GPS_COMMAND=18`。

### 5.2 NavigateTo（去指定 waypoint）
`NavigateToRequest`：`{header, repeated Lease leases, string destination_waypoint_id=3, RouteGenParams
route_params, TravelParams travel_params, Timestamp end_time, string clock_identifier,
SE2Pose destination_waypoint_tform_body_goal=8（可选，在目标 waypoint 上再加 SE2 偏移）, uint32 command_id,
RouteBlockedBehavior route_blocked_behavior}`。Response.Status 与 §5.1 类似（多 `UNKNOWN_WAYPOINT=7`）。

### 5.3 定位查询/设置
- `GetLocalizationState(GetLocalizationStateRequest{header, string waypoint_id, request_live_*...})` →
  `GetLocalizationStateResponse{header, Localization localization, KinematicState robot_kinematics,
  remote_cloud_status, live_data, LostDetectorState lost_detector_state, gps}`。
- `SetLocalization(SetLocalizationRequest{header, Localization initial_guess, SE3Pose ko_tform_body,
  double max_distance, double max_yaw, FiducialInit fiducial_init, int32 use_fiducial_id, ...})` →
  `SetLocalizationResponse{..., Status(STATUS_OK=1/ROBOT_IMPAIRED=2/UNKNOWN_WAYPOINT=3/.../NO_MAP_LOADED=12),
  Localization localization}`。通常用 fiducial（AprilTag）做首次定位。

### 5.4 TravelParams（导航行为参数，NavigateTo/Anchor 共用）
`{ oneof{double max_distance | OrientedBox2 box_region}（到达判定区域）, double max_yaw, SE2VelocityLimit
velocity_limit（限速，省略则机器人自选）, bool ignore_final_yaw, double max_corridor_distance（允许偏离录制边
的最大距离）, FeatureQualityTolerance feature_quality_tolerance, Duration blocked_path_wait_time,
LostDetectorStrictness lost_detector_strictness, PathPlannerMode planner_mode, ... }`。

### 5.5 进度反馈：NavigationFeedback
`NavigationFeedback(NavigationFeedbackRequest{header, uint32 command_id})` →
`NavigationFeedbackResponse`。**Status**：`STATUS_UNKNOWN=0`、`STATUS_FOLLOWING_ROUTE=1`、
`STATUS_REACHED_GOAL=2`、`STATUS_NO_ROUTE=3`、`STATUS_NO_LOCALIZATION=4`、`STATUS_LOST=5`、`STATUS_STUCK=6`、
`STATUS_COMMAND_TIMED_OUT=7`、`STATUS_ROBOT_IMPAIRED=8`、`STATUS_CONSTRAINT_FAULT=11`、
`STATUS_COMMAND_OVERRIDDEN=12`、`STATUS_NOT_LOCALIZED_TO_ROUTE=13`、`STATUS_LEASE_ERROR=14`、
`STATUS_AREA_CALLBACK_ERROR=15`。另带 `remaining_route`、`completed_route`、`remaining_route_length`、
`last_ko_tform_goal`、`GoalStatus goal_status`、`BlockageStatus`、`StuckReason` 等。判「到达」=
`STATUS_REACHED_GOAL(2)`。

> GraphNav 命令都是**异步立即返回**：RPC 返回只代表被接受，之后须周期调 `NavigationFeedback(command_id)`
> 直到 `REACHED_GOAL`。新命令覆盖旧命令。这与 RobotCommand 的 feedback 模式一致。

---

## 6. ImageService

`proto: image.proto / image_service.proto`；URL get_image example

- RPC：`ListImageSources(ListImageSourcesRequest) → ListImageSourcesResponse{repeated ImageSource
  image_sources, FrameTreeSnapshot transforms_snapshot}`；`GetImage(GetImageRequest) → GetImageResponse`。
- **GetImageRequest**：`{header, repeated ImageRequest image_requests}`（一次可批量取多源）。
- **ImageRequest**：`{ string image_source_name=1, double quality_percent=2（0–100，JPEG）,
  Image.Format image_format=3, double resize_ratio=4, Image.PixelFormat pixel_format=5,
  repeated Image.PixelFormat fallback_formats=7, DictParam custom_params=6 }`。
- **ImageResponse**：`{ ImageCapture shot, ImageSource source, Status status, custom_param_error }`（顺序对应
  请求顺序）。`Status`：`STATUS_UNKNOWN=0/OK=1/UNKNOWN_CAMERA=2/SOURCE_DATA_ERROR=3/IMAGE_DATA_ERROR=4/
  UNSUPPORTED_IMAGE_FORMAT_REQUESTED=5/UNSUPPORTED_PIXEL_FORMAT_REQUESTED=6/UNSUPPORTED_RESIZE_RATIO_REQUESTED=7/
  CUSTOM_PARAMS_ERROR=8`。
- **ImageCapture**：`{ Timestamp acquisition_time=30, FrameTreeSnapshot transforms_snapshot=31,
  string frame_name_image_sensor=5, Image image=3, CaptureParameters capture_params=4 }`。
- **Image**：`{ int32 cols=2, int32 rows=3, bytes data=4, Format format=5, PixelFormat pixel_format=6 }`。
  `Format`：`FORMAT_UNKNOWN=0/JPEG=1/RAW=2/RLE=3`。
  `PixelFormat`：`PIXEL_FORMAT_UNKNOWN=0/GREYSCALE_U8=1/RGB_U8=3/RGBA_U8=4/DEPTH_U16=5/GREYSCALE_U16=6`。
- **ImageSource**：`{ string name=2, int32 cols=4, int32 rows=5, double depth_scale=6, oneof camera_models
  {pinhole|pinhole_brown_conrady|kannala_brandt}, ImageType image_type=9(VISUAL=1/DEPTH=2),
  repeated pixel_formats, repeated image_formats }`。

**Spot 机身相机源名**（`image` 服务，共 5 目鱼眼 + 5 深度，出处：get_image example）：
```
frontleft_fisheye_image   frontright_fisheye_image   left_fisheye_image
right_fisheye_image        back_fisheye_image
frontleft_depth            frontright_depth           left_depth   right_depth   back_depth
frontleft_depth_in_visual_frame  frontright_depth_in_visual_frame  back_depth_in_visual_frame
left_depth_in_visual_frame       right_depth_in_visual_frame
```
带臂另有 `hand_color_image` / `hand_depth` / `hand_depth_in_hand_color_frame`（**UNVERIFIED**：手部源名来自
常见文档，本次未从 proto/示例逐字确证）。JPEG 帧在 `Image.data`（`bytes`）。

---

## 7. DirectoryService / RobotIdService（服务发现）

`proto: directory.proto / directory_service.proto / robot_id.proto / robot_id_service.proto`

- `DirectoryService.ListServiceEntries` / `GetServiceEntry(service_name)`。
- **ServiceEntry**：`{ string name=1, oneof{string type=2}, string authority=3, Timestamp last_update=4,
  bool user_token_required=5, string permission_required=7, double liveness_timeout_secs=8,
  string host_payload_guid=9 }`。
  - `name`：用户友好唯一名（如 `power`、`robot-state`）。
  - `type`：gRPC 接口全名（如 `bosdyn.api.PowerService`）。
  - `authority`：路由用（如 `power.spot.robot` 或短标签 `power`）→ 决定 channel 的 `:authority`/SNI。
  - `user_token_required`：除 `auth`、`robot-id` 外基本都为 true。
- `RobotIdService.GetRobotId`（**无需 token**）→ `RobotId{serial_number, species, version,
  RobotSoftwareRelease software_release, nickname, computer_serial_number}`；
  `RobotSoftwareRelease{SoftwareVersion version{major,minor,patch}, name, type, changeset_date, changeset,
  string api_version, ...}`。

**:authority 的用法**：client 对每个 service 建 channel 时，把该 service 的 `authority` 设为 gRPC
`:authority` header（grpc-js: channel option `grpc.default_authority`；真机自签名还要
`grpc.ssl_target_name_override`）。同一 `ip:443`，靠 authority 分流到不同 service。

---

## 8. Node/proto-loader 实现坑（影响 sim 与 adaptor）

1. **`keepCase: true` 必开**。bosdyn 全用 snake_case 字段名（`se2_frame_name`、`clock_identifier`…）。
   proto-loader 默认 camelCase，会导致字段对不上。开 `keepCase` 保持原名。
2. **uint64 → 字符串（`longs: String`），estop challenge 必须用 BigInt**。`EstopCheckIn` 的 `challenge`/
   `response` 是 `uint64`，proto-loader 默认 `longs:'String'` 会给字符串（`longs:Number` 有精度风险，challenge
   用满 64 位）。计算应答：`response = ((~BigInt(challenge)) & 0xFFFFFFFFFFFFFFFFn).toString()`，再作字符串塞回。
   这是**最容易翻车**的一处。
3. **enum `allow_alias` + 别名 → 用数字比较，别用字符串**。`SE2TrajectoryCommand.Feedback.Status`（STOPPED=1
   与 AT_GOAL=1 同值）、`PowerState.MotorPowerState`、`PowerCommandRequest.Request` 等都是 `allow_alias`。
   protobuf.js 的 number→name 反查每个数字只保留**一个**名字（先声明者胜），所以解出来的字符串名可能不是你以为
   的那个。**建议 `enums: Number`**，用数字常量比较（如 `=== 1`），避免歧义。
4. **`google.protobuf.Any` 不自动打解包**。`ResponseHeader.request/data`、`MobilityCommand.Request.params`
   （field 100）、`FullBodyCommand.Request.params` 都是 `Any`。proto-loader 不会自动 pack/unpack——需手动填
   `{type_url, value(bytes)}` 或解码。**sim 可留空**这些 Any 字段；adaptor 一般也用不到（除非发厂商私有参数）。
5. **oneof 判活分支**：开 `oneofs: true`，proto-loader 给每个 oneof 加一个虚拟字段（值=当前被设置的分支名），
   比逐个判 `!= null` 省事。`RobotCommand.command`、`MobilityCommand.Request.command`、
   `NavigateToAnchorRequest.goal` 都是 oneof。
6. **Timestamp/Duration 是 message，不自动转**。`{seconds, nanos}` 手动构造/解析。命令 `end_time` 必须是
   **机器人时钟**：`end_time = now_client + clock_skew + 时长`（skew 来自 time-sync，§2.3）。
7. **`bytes` → Buffer**：`Image.data`、`DataChunk.data` 解出来是 Node `Buffer`，直接可用。
8. **`google.protobuf.*Value` 包装类型**：`BatteryState.charge_percentage` 等是 `DoubleValue`（`{value}`），
   不是裸 `double`——用于区分「未设置」与「0」。读时取 `.value`，注意可能整个字段缺失。
9. **`google/protobuf/*` 不用 vendoring**：proto-loader 自带这 6 个标准类型（见 protos/README）。
10. **service 名与 loadPackageDefinition**：加载后按 `bosdyn.api.<Service>` 取；GraphNav 在
    `bosdyn.api.graph_nav.GraphNavService`（注意子包 `graph_nav`）。

---

## 9. 实现要点：sim 最小 server 面 & adaptor client 状态机

### 9.1 simulator 要实现的最小 gRPC server 面

按「一个 Spot 至少要能跑通会话舞蹈 + 基本运动/状态/图像」列，**每个 service 用同一个 grpc-js Server 挂载即可**
（本地明文，authority 用 `grpc.default_authority` 或干脆忽略）：

| Service | 必须实现的 RPC | sim 行为要点 |
|---|---|---|
| `RobotIdService` | `GetRobotId` | 返回固定身份，**不校验 token** |
| `DirectoryService` | `ListServiceEntries`/`GetServiceEntry` | 列出自身所有 service 的 name/type/authority（authority 可都填同一个本地名） |
| `AuthService` | `GetAuthToken` | user/pass 校验→发一个假 JWT 字符串；**不校验 token 的其余 service 只需认「非空 Bearer」** |
| `TimeSyncService` | `TimeSyncUpdate` | 回填 `server_rx/server_tx`，几轮后 `STATUS_OK`，分配 `clock_identifier`；skew 可恒 0 |
| `LeaseService` | `AcquireLease`/`RetainLease`/`ReturnLease`/`ListLeases` | 维护 `body` 资源单一 owner + `sequence`；`RetainLease` 刷新 stale 计时 |
| `EstopService` | `RegisterEstopEndpoint`/`GetEstopConfig`/`SetEstopConfig`/`EstopCheckIn`/`GetEstopSystemStatus` | check-in 校验 `response==~challenge`（uint64），发新 challenge；断 check-in 则把 stop_level 拉到 SETTLE_THEN_CUT |
| `PowerService` | `PowerCommand`/`PowerCommandFeedback` | `ON_MOTORS`→几百 ms 后 `STATUS_SUCCESS`，翻 `PowerState.motor_power_state=ON`；要求 lease+estop 放行 |
| `RobotStateService` | `GetRobotState` | 由 sim 内部运动模型持续更新 battery/power/kinematic(`odom_tform_body`)/estop/faults |
| `RobotCommandService` | `RobotCommand`/`RobotCommandFeedback`/`ClearBehaviorFault` | 认 `synchronized_command.mobility_command` 的 se2_trajectory/velocity/stand/sit；驱动内部位姿，feedback 报 PROCESSING→STOPPED |
| `ImageService` | `ListImageSources`/`GetImage` | 用固定几个 source 名（frontleft_fisheye_image…）回 JPEG bytes（可复用平台现有媒体帧） |
| `GraphNavService`（可选） | `GetLocalizationState`/`SetLocalization`/`NavigateToAnchor`/`NavigationFeedback` | 若要演地图导航：维护一个假 localization，NavigateToAnchor 驱动到 seed 目标，feedback 报 FOLLOWING_ROUTE→REACHED_GOAL |

sim 校验强度按需：至少要让 adaptor 的状态机能过——即 lease 单一 owner、estop 挑战/应答、power 需前两者就绪。

### 9.2 adaptor（mini bosdyn-client）client 状态机

```
[connect]  建 channel(ip:443, TLS+authority 或本地明文)，先 GetRobotId 探活
   ↓
[auth]     GetAuthToken(user,pass) → token；此后所有 channel 挂 authorization: Bearer token
   ↓
[timesync] 起线程：反复 TimeSyncUpdate 直到 STATUS_OK；缓存 clock_skew + clock_identifier；此后每 60s 一次
   ↓
[lease]    AcquireLease("body") → 起线程每 2s RetainLease；保存当前 lease
   ↓
[estop]    (GetEstopConfig →) RegisterEstopEndpoint → 起线程每 timeout/3 秒 EstopCheckIn(NONE)，
           首次忽略 INCORRECT_CHALLENGE_RESPONSE，之后 response=~challenge(uint64)
   ↓
[power]    PowerCommand(ON_MOTORS, lease) → 轮询 PowerCommandFeedback 到 STATUS_SUCCESS
   ↓
[ready]    ── 稳态：三个 keep-alive 线程常驻 ──
           • 状态推送：定时 GetRobotState → 映射到平台 ingestState（电量/位姿/故障）
           • 视频：ListImageSources + 定时 GetImage → 平台快照/流
           • 运动：平台下发 goto → RobotCommand(synchronized.mobility.se2_trajectory_request,
                    frame=odom/vision, end_time=now+skew+Δ, lease, clock_identifier) → 轮询 feedback
             或走 GraphNavService.NavigateToAnchor（带 robot+graph 两个 lease）→ NavigationFeedback
   ↓
[teardown] 停 keep-alive → (可选 SafePowerOff) → ReturnLease → DeregisterEstopEndpoint → 关 channel
```

映射到 Plantbot 集成层（对照 `docs/platform-model.md` 六域，与 `server/src/gosim.ts` 的 in-process 厂商
adapter 走同一套 World 入口）：
- **Robot State → 站点/机队**：`RobotState.power_state.locomotion_charge_percentage`→电量；
  `kinematic_state.transforms_snapshot` 里 `odom_tform_body`→位姿；`system/behavior/estop_states`→故障与在线态。
- **Image → 视频域 Channel**：每个 image source 当一个 camera channel；GetImage 帧喂快照抓帧源。
- **RobotCommand / GraphNav → 控制域 Command**：平台的「goto/巡逻」语义命令翻成 SE2Trajectory 或
  NavigateToAnchor；lease/estop/timesync 是 adaptor 内部细节，不上浮到平台 API。

---

## 附：本次已 vendored 的 proto 闭包

59 个文件、约 446 KiB，覆盖上述全部 service 及其 import 闭包（含 `header/geometry/trajectory/lease/estop/
power/robot_state/robot_command/basic_command/mobility_command/synchronized_command/full_body_command/
arm_command/gripper_command/image/graph_nav/*/nav/time_sync/auth/directory/robot_id/service_fault/
data_chunk/...`）。完整清单、加载方式与许可见
[`integrations/spot/protos/README.md`](../../integrations/spot/protos/README.md)。

**权威出处索引**：proto 字段 = `integrations/spot/protos/bosdyn/api/*.proto`（spot-sdk master）；运行期常量 =
`python/bosdyn-client/src/bosdyn/client/{estop,lease,time_sync,auth,channel,robot}.py`；概念 =
dev.bostondynamics.com（base_services、estop_service、lease_service、get_image example）。
