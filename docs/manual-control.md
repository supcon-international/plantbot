# Manual robot and camera control / 机器人与云台手动控制

## Operator workflow

Open **FLEET → robot → Teleoperation** for driving, or **LIVE → PTZ inspection** for camera control. An operator or administrator acquires exclusive control; viewers can only observe. A running robot task requires explicit confirmation to end it. The platform reserves the robot before ending the task and enables manual input only after the adapter confirms a stationary state.

Hold a direction button or its displayed key to move. Release it, press Space, or use Stop to stop while keeping control. Release control, switch routes/sites, hide the browser tab or move focus to another window to end the session. Another operator can request a stop without taking over the owner's input token. A stop request remains pending until the adapter confirms it; a failed or disconnected adapter does not automatically unlock the robot.

The camera panel provides pan, tilt and zoom adjustment, measured position, and **Save position as preset**. Presets feed the existing ordered patrol plans, dwell times, schedules and execution history. Arrival feedback starts dwell time. On compatible cameras, cancellation sends a stop and releases the reservation only after confirmation.

## 操作流程

机器人驾驶入口为 **FLEET → 机器人 → 遥操作**；云台入口为 **LIVE → 云台巡检**。操作员或管理员先取得独占控制权。机器人正在执行任务时，须确认结束任务；平台先预留机器人，再等待适配器确认停止，随后开放手动输入。

按住方向按钮或对应键移动，松开、按空格或点击停止后保持静止。释放控制权、切换页面/场站、隐藏标签页或窗口失焦会结束会话。其他操作员可以请求停止。适配器断连或停止失败时，平台保留占用，等待连接恢复并确认停止。

云台可调整水平、俯仰及倍率，显示回读姿态，并将当前位置保存为预置点。预置点用于巡检计划、停留时间、排程和执行记录。兼容摄像头取消巡检时，平台等待停止回执后解除占用。

## Adapter support

| Adapter | Robot driving | Camera control |
| --- | --- | --- |
| Spot | Body-frame forward/lateral/turn velocity; robot-clock command expiry | Discovered Spot CAM `mech`: bounded position steps, measured presets/patrols, verified stop |
| Gosuncn F2 | Documented direction codes with vendor speed setting 3; adapter watchdog | Reset only; directional stop opcode and absolute pose contract remain unverified |
| X30 robotserver | Navigation tasks; manual velocity not exposed by this protocol | Not exposed; Station OpenAPI is a separate, unimplemented integration |
| External adapter | Explicit `teleop` factsheet plus `pumpControl` controller | Explicit `streams[].ptz`, with `manual:'position'` only if bounded movement and stop confirmation are supported |

Spot CAM is optional hardware, not a base Spot capability. Configure a registered `SPOT_CAM_STREAM_ID` and its native stream, or provide `SPOT_CAM_STREAM_URL` for a new channel; `SPOT_CAM_PTZ` defaults to `mech`. The managed connector exposes these fields. Discovery must confirm the device and its ranges. Custom robots are never assigned a demo stream automatically. Spot port 443 uses the official root CA and Directory service authorities; `SPOT_CA_FILE` overrides the CA file. Simulator ports use plaintext, with explicit `SPOT_TLS=1|0` overrides.

F2's speed setting is a vendor grade, not m/s. Its documented interface does not establish a device-native deadman timeout: adapter/process or robot-network failure cannot guarantee a physical stop. Deployment requires the vendor's on-device safety controls and emergency stop. Browser Stop is an operational stop, not a safety-rated emergency stop. Automated tests use official-protocol simulators; they do not replace commissioning on physical hardware.

## Integration contract

Manual control is a separate ephemeral channel, never a durable motion order:

- Browser: `POST /api/sites/:siteId/robots/:robotId/control`, then `PUT /control/:id/input` with `x-control-token` and a strictly increasing sequence. `interrupt:true` confirms ending earlier navigation. Zero input renews ownership without motion.
- Adapter: `GET /api/integration/v1/robots/:serial/control` returns a frame or null. Poll about every 80 ms, subtract the full request round trip from `remainingMs`, discard old sequences and stop on expiry/disconnection. The SDK supplies these rules in `pumpControl`.
- Browser input expires after 400 ms. SDK effective input lasts at most 350 ms. Browser sends updates every 180 ms; the operator lease expires after 1500 ms (initial readiness window 5 s). A 40 ms adapter watchdog requests stop independently of HTTP polling. Native Spot velocity uses a robot-clock expiry as well.
- Adapter receipts: `ready` after initial stop, `applied` after input, `stopped` after measured stop with the current sequence, or `failed` when uncertain. Stop failures keep the reservation. Camera feedback includes degrees and zoom multiplier.
- Platform restart restores unfinished sessions as stop requests and invalidates their tokens. Axes are never persisted or replayed. A robot reservation also excludes autonomous dispatch and camera patrol commands.
- PTZ order `mode:'stop'` is available only with the manual-position capability. Stop the in-flight movement, verify position is stationary, then report `done`. A successful API acceptance is insufficient.

The TypeScript SDK and Node-RED JavaScript client export the same `pumpControl` helper. Node-RED flows must supply asynchronous vendor `start/apply/stop` methods with real confirmation; the existing order node must not be used to queue expiring manual input. Both OpenAPI specifications describe the HTTP contract.

## References and verification

- [Spot robot services](https://dev.bostondynamics.com/docs/concepts/robot_services.html): velocity commands and lease/estop behavior.
- [Spot base services](https://dev.bostondynamics.com/docs/concepts/base_services.html): TLS and authority routing.
- [Official Spot CAM PTZ proto](https://github.com/boston-dynamics/spot-sdk/blob/8577b41dffe0eb7b2913c6599794c5c135c8574e/protos/bosdyn/api/spot_cam/ptz.proto): mechanical camera supports position commands; velocity is not implemented for `mech`.
- [F2 protocol reference](vendors/gosuncn-api.md): command response shapes and direction codes.

Run SDK unit tests, `integrations` tests and `WEB_BASE=/robots/ pnpm build && node scripts/test-control-ui.mjs`. The browser test uses Chrome, a fresh database, the production subpath bundle and a real adapter connected to the protocol simulator. `scripts/test-inspection-ui.mjs` covers the remaining inspection workflows.
