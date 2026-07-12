# Plantbot 开放集成 API（v1）

把任意品牌的巡检机器人/外部检测系统接入 Plantbot 场站。设计对齐业界既有标准,而不是再发明一套:

## 两种接入模式

| 模式 | 适用 | 操作 |
| --- | --- | --- |
| **托管连接器（Managed）** | 平台部署在厂内、能直连机器人网络;型号为内置三种(Spot / X30 / GS F2) | INTEG 面板 → MANAGED CONNECTORS → 选厂商填地址/凭证/机器人相机 rtsp:// → 创建即接入。平台把官方 adapter 作为**受监督子进程**代跑(崩溃退避重启、日志面板可查、随平台启停),北向经回环集成 API + 每次启动重签的内部密钥。 |
| **外部 adapter（External）** | 跨网部署(平台在云、机器人在厂内)、内置之外的任意型号、或想用自己的运行时 | 签发场站 API Key → 用下述 HTTP 契约自建 adapter。SDK 两种形态:**TypeScript**(`sdk/adapter-sdk-ts`,零依赖 `@plantbot/adapter-sdk`)与 **Node-RED**(`sdk/node-red-contrib-plantbot`,四个节点拖出一个 adapter,南向随意用 Modbus/MQTT/OPC UA 节点)。 |

两种模式落到同一套集成 API——托管只是平台替你跑进程,协议契约完全一致。机器人原生相机以 `rtsp://user:pass@…` 直接写进 factsheet `streams[]`:平台经 go2rtc 中继播放、ffmpeg 抓证据帧,**含凭证的 URL 只对该站 admin 回传**(公开面 fleet/channels/WS 一律剥除)。

| 借鉴 | 用在哪里 |
| --- | --- |
| **VDA 5050**(factsheet / state / order / instantAction 语义) | 注册消息=factsheet;`state` 上报;`orders` 拉取执行 |
| **MassRobotics AMR Interop**(最小状态互通集) | `state-only` 接入级别的字段选型 |
| **Open-RMF fleet adapter**(混合控制级别) | `level: state-only \| dispatchable` 两级接入 |
| **ROS map_server**(`image + resolution + origin`) | 占据栅格地图上传约定 |
| NEA/TC35《变电站巡检机器人系统交互接口》(HTTP+JSON 三类接口) | 传输选型:HTTP + WebSocket,JSON/UTF-8 |

传输为 HTTP(+ 平台自身的 WS 遥测下发),不依赖 MQTT broker;生产部署可在适配器侧桥接 MQTT/VDA5050 原生栈。

## 认证

管理面(Web/REST `/api/sites/...` 写操作)用**账户会话**(角色:`viewer < operator < admin`,按场站授权;匿名=viewer 只读)。
集成面(`/api/integration/v1/...`)用**场站 API Key**:管理员在 *Integrations* 面板签发,请求头携带:

```
Authorization: Bearer pbk_xxxxxxxx…
```

Key 与场站一一绑定——同一套端点,不同 Key 自动落到各自场站。

秘钥交接:生产在 *Integrations* 面板签发,或 `PB_SEED_KEYS="plant-07=pbk_…,campus-east=pbk_…"` 由部署环境注入;
开发时根 `pnpm dev` 自带 `PB_DEV_KEYS=1`,播种确定性 `pbk_dev_<site>`(内置 sim 适配器的默认值,零配置互认)。

> 三个**参考适配器**(Boston Dynamics Spot·gRPC / 云深处 X30·TCP / 高新兴 F2·云 REST+WS)连同各自的
> 机器人仿真器随仓库提供于 `integrations/`,架构与厂商映射见 [adapter-sim-architecture.md](adapter-sim-architecture.md)。

## 端点总览

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/integration/v1/site` | 场站 factsheet:边界、航点、区域、事件类型词表 |
| POST | `/api/integration/v1/robots` | 注册/更新外部机器人(factsheet) |
| DELETE | `/api/integration/v1/robots/:serial` | 注销 |
| POST | `/api/integration/v1/robots/:serial/state` | 状态上报(兼作心跳;>20s 无上报判 offline) |
| GET | `/api/integration/v1/robots/:serial/orders` | 拉取待执行订单(取走即置 `acked`) |
| POST | `/api/integration/v1/orders/:id/status` | 回报订单结果 `done \| failed` |
| POST | `/api/integration/v1/events` | 推送自定义事件(类型需先注册;支持 evidence/category/runId) |
| POST | `/api/integration/v1/robots/:serial/readings` | 批量上报 payload 读数(稳定信封) |
| POST | `/api/integration/v1/snapshot` | 证据抓帧:`{stream}` → `{url}`,平台从已登记帧源出快照托管 |
| POST | `/api/integration/v1/maps` | 上传占据栅格地图(ROS 约定) |

## 1. 注册机器人(factsheet)

```bash
curl -X POST $BASE/api/integration/v1/robots \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "serial": "ACME-0007",            # 必填,幂等键
  "model": "Jueying X30",           # 命中集成目录(Spot/Jueying X30/GS Patrol F2)时带出 3D 孪生/参数
  "level": "dispatchable",          # state-only | dispatchable
  "callsign": "ACME·07",
  "family": "quadruped",
  "home": {"x": -6, "z": -4},
  "streams": [{"id":"acme-front","name":"Front cam","kind":"camera","url":"https://…/front.m3u8"}]
}'
```

`level` 语义(Open-RMF 混合控制级别):
- **state-only** — 平台只显示你的状态/事件,不会向你派单;
- **dispatchable** — 操作员可对你 tap-to-dispatch、指派任务;订单进入队列由适配器拉取执行。

注册后机器人立即出现在该场站 FLEET/地图上(标记 `EXTERNAL`)。

## 2. 状态上报(≈1 Hz,兼作心跳)

```bash
curl -X POST $BASE/api/integration/v1/robots/ACME-0007/state \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"x":-5.5,"z":-3.8,"heading":1.2,"speed":0.6,"battery":81,"mode":"navigating"}'
```

字段全部可选,给多少更新多少。`mode ∈ idle|navigating|executing|teleop|charging`。响应携带 `ordersPending` 计数,便于适配器决定何时拉单。超过 20 秒未上报,平台侧显示 `OFFLINE`。

## 3. 订单(dispatchable)

```bash
curl $BASE/api/integration/v1/robots/ACME-0007/orders -H "authorization: Bearer $KEY"
# → {"orders":[{"id":"OR-0001","kind":"goto","payload":{"x":3,"z":2},…},
#              {"id":"OR-0002","kind":"mission","payload":{"missionId":"M-107","name":"…","steps":[…]}}]}

curl -X POST $BASE/api/integration/v1/orders/OR-0002/status \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"status":"done","note":"3 waypoints inspected"}'
```

订单共七类(适配器按厂商能力如实执行或回 `failed: unsupported`):

| kind | payload | 语义 |
| --- | --- | --- |
| `goto` | `{x, z, dock?}` | 地图 tap-to-dispatch;`dock: true` 表示这是回桩命令——适配器可换用厂商自己的回充例程(如高新兴一键充电) |
| `mission` | `{missionId, name, steps[]}` | 操作员显式指派的完整任务;**只有 mission 订单的完结会结算平台侧任务状态** |
| `announce` | `{text}` | 语音播报 |
| `pause` / `resume` / `abort` | `{missionId}` | 操作员对进行中外部任务的干预(missionId 仅作引用) |
| `ptz` | `{channelId, pan?, tilt?, zoom?}` | 云台意图 |

平台不会把 `auto` 任务自动派给外部机器人——只派显式点名的(排程也可用 `assign: {kind:'robot'}` 钉死外部单元,机器人未注册时任务留队,注册后自动派发)。

## 4. 自定义事件

先在 *Integrations* 面板(或 `POST /api/sites/:siteId/event-types`,admin)注册类型:

```json
{ "id": "valve-leak", "label": "Valve micro-leak", "severity": "high", "detail": "Acoustic + OGI fusion" }
```

之后即可推送(未注册类型返回 400——保持事件词表受控):

```bash
curl -X POST $BASE/api/integration/v1/events \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "type": "valve-leak",
  "robotSerial": "ACME-0007",      # 可选:挂到机器人当前位置
  "detail": "CH4 8ppm at flange B-12",
  "severity": "high",              # 可选,默认取类型注册值
  "x": 3.2, "z": -1.4,             # 可选:显式坐标
  "snapshotUrl": "https://…/frame.jpg",
  "confidence": 0.83
}'
```

事件进入统一事件流:看板/表格/地图钉/toast/生命周期(ack→resolve|dismiss)全部生效;自定义类型同样可用于规则引擎(NEW RULE 的模型下拉里)。可选扩展字段:
`category ∈ security|fire|env|equipment|robot-fault`(分流到对应看板筛选)、
`evidence: [{kind:'image'|'reading', url?, reading?:{metric,value,unit}}]`、
`runId`(关联任务执行)。

## 4b. 读数上报(payload 数据的稳定信封)

传感器数据不进事件流、不改 schema——按 metric 批量上报:

```bash
curl -X POST $BASE/api/integration/v1/robots/ACME-0007/readings \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "readings": [
    {"metric": "ch4.ppm", "value": 2.4, "ts": 1783600000000},
    {"metric": "dt.max.c", "value": 8.1}
  ]
}'
# → {"accepted":2,"skipped":0,"metrics":["ch4.ppm","h2s.ppm",…]}   # 注册表内的 metric 才收
```

读数出现在机器人详情页 Payload Telemetry 时序里;站点侧 threshold 检测器(`kind:'threshold'`,
`metric/op/bound`)可基于它们自动产生事件。metric 注册表见 `GET /api/sites/:siteId/metrics`。

## 5. 地图上传(ROS map_server 约定)

```bash
curl -X POST $BASE/api/integration/v1/maps \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "name": "slam_toolbox 2026-07-10",
  "resolution": 0.05,               # 米/像素,来自 map.yaml
  "origin": [-16, -9],              # 图像左上角像素的场景坐标 [x, z]
  "image": "data:image/png;base64,…"  # PNG(PGM 请先转 PNG),≤8MB
}'
```

坐标系:场景 x→东(图像向右),z→南(图像向下)。从 ROS `map.yaml`(origin 为左下角、y 向上)换算:`originX 不变`,`originZ = -(origin_y + height × resolution)`。

上传即生效:持久化存储、广播到所有在线客户端,3D 作业地图立即以半透明底图渲染(OPS MAP 地面层)。

## 参考适配器(20 行跑通)

```python
import requests, time, math
B, K = 'https://your-host/robots/api/integration/v1', {'authorization': 'Bearer pbk_…'}
requests.post(f'{B}/robots', headers=K, json={'serial':'PY-01','model':'GS Patrol F2','level':'dispatchable','home':{'x':0,'z':0}})
x = z = 0.0; target = None
while True:
    for o in requests.get(f'{B}/robots/PY-01/orders', headers=K).json()['orders']:
        if o['kind'] == 'goto': target = (o['payload']['x'], o['payload']['z'], o['id'])
    if target:
        dx, dz = target[0]-x, target[1]-z; d = math.hypot(dx, dz)
        if d < 0.2: requests.post(f"{B}/orders/{target[2]}/status", headers=K, json={'status':'done'}); target = None
        else: x += dx/d*0.5; z += dz/d*0.5
    requests.post(f'{B}/robots/PY-01/state', headers=K, json={'x':x,'z':z,'speed':0.5 if target else 0,'battery':88,'mode':'navigating' if target else 'idle'})
    time.sleep(1)
```

## SDK（两种形态）

同一套契约的两个官方封装,都在 `sdk/`:

**TypeScript — `@plantbot/adapter-sdk`**（`sdk/adapter-sdk-ts`,Node ≥18 零依赖;仓库内 `workspace:*`,体外 `npm i <repo>/sdk/adapter-sdk-ts`）。传输错误永不 throw(adapter 必须活过平台重启):

```ts
import { PlantbotClient, waitForSite, pumpOrders } from '@plantbot/adapter-sdk'
const pb = new PlantbotClient({ base: 'http://plantbot:8787', key: process.env.PLANTBOT_KEY! })
await waitForSite(pb)
await pb.registerUntilUp({ serial: 'MY-01', model: 'My Robot X1', level: 'dispatchable',
  streams: [{ id: 'front', name: 'Front', url: 'rtsp://user:pw@10.0.0.9:554/ch1' }] })
setInterval(async () => {
  const rep = await pb.state('MY-01', { x: 0, z: 0, battery: 80, mode: 'idle' })
  await pumpOrders(pb, 'MY-01', rep, async (o) => pb.orderStatus(o.id, 'done'))
}, 1000)
```

仓库内置的三个厂商 adapter 就 import 这个包(`integrations/shared` 是薄 re-export)——SDK 源码即平台自跑的客户端,永不漂移。

**Node-RED — `node-red-contrib-plantbot`**（`sdk/node-red-contrib-plantbot`,Node-RED ≥3.0）:

```bash
cd ~/.node-red && npm i <repo>/sdk/node-red-contrib-plantbot   # 重启 Node-RED
```

四个节点:`plantbot-config`(站点+密钥,凭证存 Node-RED credential store 不随 flow 导出) /
`plantbot-robot`(部署即注册,输入=1Hz 状态上报,输出=ordersPending) /
`plantbot-orders`(订单泵:输出每单一条 msg、`msg.topic`=kind,用 switch 节点路由——那就是你的能力矩阵;输入 `{orderId,status,note}` 回报) /
`plantbot-event`(事件上报,`snapshotStream` 自动经平台证据服务抓帧)。
示例流 `examples/minimal-adapter-flow.json`:inject 1Hz → function(读你的机器人) → robot → orders → switch(kind) → 执行 → 回报。
