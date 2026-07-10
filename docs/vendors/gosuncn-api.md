# 高新兴 GoRobot 平台 API — 实现级参考（逐字段）

> 抓取自官方 Apifox 共享文档（项目 1212035，2026-07-10 经 llms.txt → 各接口 .md 同源抓取），
> 用于实现 `integrations/gosuncn/{sim,adapter}`。**sim 必须按本文档还原 server 面；adapter 按本文档实现 client 面。**
> 设计级调研（领域概念/反面清单）见 [gorobot-study.md](gorobot-study.md)。

## 0. 全局约定

- 所有 HTTP 接口挂在 `/robotservice/**/*.action`（RPC 风格）；**POST 的参数也放 query string**（仅登录、添加巡逻计划用 multipart form body）。
- 鉴权：自定义 header `Token: <access_token>`（**不是** Authorization Bearer）。
- 统一响应信封 `ResultWrapper`：

```json
{ "ret": 1, "code": "1000", "msg": "操作成功", "data": … }
// ret: 1 成功 / -1 失败；code“暂不使用，预留字段”；控制类接口另有 { successful, msg, ret } 三元组
```

- 命名漂移（文档原样，需忠实还原）：机器人主键在不同接口叫 `deviceId`（数据库 id）/ `robotSn`·`deviceSn`·`deviceCode`（SN 码）/ `modelId`；通道叫 `channelId` 或 `cameraId`。
- 生产平台域名示例：`ab.gorobotop.com`（视频流走 `wss://ab.gorobotop.com:42001/...`）。

## 1. 认证

### POST `/robotservice/auth/login` — 获取 token
- Header：`Authorization: Basic YWRtaW46YWRtaW4=`（**写死 admin:admin**）
- Body（multipart/form-data）：

| 字段 | 必填 | 说明 |
|---|---|---|
| username | ✓ | 用户账号（例 dllg01） |
| password | ✓ | **md5 加密后的密码** |
| grant_type | ✓ | 固定 `password` |
| hardware | | 网页为 `web`，app 为硬件信息（信任设备 7 天免验证码） |
| verifyCode / verifyId | | 验证码及其 id |

- 响应 `data` 内含 `access_token`；**token 最长有效期 2 小时，每次携带请求自动顺延 2h**。

### GET `/robotservice/user/keepTokenConnection.action` — 心跳保活
- Header `Token`。响应示例：`{ret:1, code:"1000", msg:"延长token时间成功", data:null}`。

## 2. 机器人

### GET `/robotservice/device/searchRobotList.action`
- Query：`robotNameOrCode`（可选筛选）、`page`（必填，默认 1）、`pageSize`（必填，默认 10）；Header `Token`。
- `data`：`{ currentPage, total, pageSize, rows: RobotRow[] }`

| RobotRow 字段 | 类型 | 说明 |
|---|---|---|
| deviceId | int | 数据库记录主键 id |
| robotName | string | 机器人名称 |
| robotSn | string | 身份唯一标识码 |
| online | int | 1 在线 / 0 离线 |
| companyName / companyCode | string | 所属单位 |
| deviceType | string | `robot` 代表机器人 |
| electricity | string | 电量 |
| workStatus | int | 0 自动模式 / 1 手动模式 |
| taskType | string | `patrol` 巡逻 / `watch` 定点值守 / `charge` 充电 / `standBy` 空闲待机 |
| stopStatus | string | 急停按钮：1 按下 / 0 松开 |

### GET `/robotservice/device/findRobotStatus.action`
- Query：`robotSn` 或 `deviceId`（二选一）。
- `data` = `RobotStatus`（一层平铺 70+ 字段，全表照录）：

| 字段 | 类型 | 说明 |
|---|---|---|
| alarmLightStatus | int32 | 警示灯（0 关 / 非 0 开） |
| alphaRay / alphaRay2 / betaRay / betaRay2 / gammaRay / neutronRay | string | 射线，单位 CPS |
| angle | float | 机器人角度 |
| atmPressure | string | 大气压强 Kpa |
| batteryTemp | float | 电池温度 ℃ |
| camera | CameraBean | `{cameraFocus: float, cameraZoom: float}` |
| cameraLightStatus | int32 | |
| chargeConnectMode | int32 | 0 未充电 / 1 自动充电 / 2 手动连接充电 |
| co2 / sH2S / sSO2 / poisonGas | string | ppb |
| current / voltage / power | float | A / V / W |
| currentDuration / duration | int32 | 本次开机 / 总运行时长（分钟） |
| currentMileage / mileage | int32 | 本次开机 / 总里程（米） |
| decibel | string | dB |
| electricity | int32 | 电量 % |
| exceptionCode | string | 本体异常码 |
| frequency | string | kHz |
| gpsGixedSolution | string | 0 无 GPS 信号 / 1 rtk 浮点解 / 2 rtk 固定解（字段名原文如此，Gixed） |
| headLightStatus | int32 | 大灯 0 关 / 1 开 |
| humidity / humidityMid / humidityUp | string | 湿度 %（下/中/上三探头） |
| ifChargeTask | int32 | 是否执行「一键充电」任务 1/0 |
| isPatrolStop | int32 | 1 暂停状态 / 0 巡逻状态 |
| isTalking | int32 | 对讲中 1/0 |
| latitude / longitude | double | GPS 传感器坐标 |
| latitudeWGS84 / longitudeWGS84 | double | WGS84 坐标 |
| lift | LiftStatusBean | `{height: float, robotCode}` 升降杆 |
| lineCode | string | 最新线路 ID |
| mapName | string | 激光地图名 |
| model | string | 机器人型号，例：F1、F2、M1 |
| nASL | float | 海拔（米） |
| name | string | |
| online | int32 | 1 在线 / 0 离线 |
| orientation | float | 方向（弧度），单位标注「度」（文档自相矛盾，按 WS 示例 angle 为度） |
| ozoneSwitch / uvSwitch | int32 | 臭氧 / 紫外灯开关 |
| patrolPlanId | int64 | 巡逻计划 id |
| patrolStatus | int32 | 1 巡逻中 / 0 巡逻结束 |
| planName | string | 巡逻计划名称 |
| pm10 / pm25 | string | |
| pointName | string | 当前点位名称 |
| powerAnomaly | int32 | 0 正常 / 1 电池通信异常 / 2 电源管理与主控通信异常 |
| ptz | PtzStatusBean | `{distance: string 目标距离, hangle: float 水平角, vangle: float 垂直角, robotCode}` |
| robotSn | string | |
| sensorData | string | 嵌套 JSON 字符串：`{"SensorStatus":[{"Data":[{"AlarmType":201,"Name":"温度","Threshold":0.0,"Type":1,"Unit":"℃","Value":0.0}],"Index":2},…]}` |
| speed | float | m/s |
| stopStatus | int32 | 急停 |
| taskType | string | patrol / watch / charge |
| temperature / temperatureMid / temperatureUp | string | ℃ 三探头 |
| useLaserToAerial / useLaserToGPS | bool | 是否已标定（激光→航拍 / 激光→GPS） |
| workModel | int32 | 0 自动 / 1 手动（注意此处叫 workModel，列表接口叫 workStatus） |
| xPosition / yPosition | int32 | **激光地图（巡逻图片）坐标** |
| xPositionAerial / yPositionAerial | double | 航拍图坐标 |

## 3. 视频通道

### GET `/robotservice/device/selectChannelList.action`
- Query：`deviceId`；Header `Token`。
- `data`（数组）：`{ channelId: string, videoCode: "H264"|"H265", camIconUrl: string, name: string }`
  - name 取值：前、高清、热成像、后、左、右、音频。

### GET `/robotservice/device/getVideoUrl.action`
- Query：`channelId`（摄像头 id）、`protocol` ∈ `websocket|rtsp|rtmp|hls`（建议 websocket + flv.js 播放）。
- 响应示例：`{ret:1, code:"1000", msg:"操作成功", data:{cameraid:3304, url:"wss://ab.gorobotop.com:42001/2153_183.6.189.130"}}`
- **获取到的 url 需要在 10 秒内点播，超时需要重新获取**。

## 4. 告警

### GET `/robotservice/device/findAlarmStatByParam.action`
- Query 筛选：`deviceId / deviceSn / deviceName / alarmType / startTime / stopTime / alarmLevel / alarmStatus / alarmStatusStr（逗号多值）/ alarmReviewStatus / page / pageSize`
  - alarmStatus：0 未处理 / 1 待处理 / 2 已关闭 / 3 无需处理
  - alarmReviewStatus：null 无需复核 / 0 待复核 / 1 复核中 / 2 复核完成
- `data` = `Page«AlarmRecordDTO»`：`{currentPage, pageSize, total, rows: AlarmRecordDTO[]}`

AlarmRecordDTO 关键字段（全表）：
`address, alarmBeginTime(date-time), alarmEndTime, alarmLevel(int), alarmName, alarmRank, alarmStatus(int; 注释「只需推送为0的状态」), alarmType(int 告警类型值), alarmValue(string), algorithmResult(string 算法识别结果·用于算法训练), area(绘制区域名), assigneeId/assigneeName, audioRemind(0/1)+audioRemindFileUrl, channelNum, closeComment/closePicUrl/closeTime/closeUsername, confirmComment/confirmPicUrl/confirmTime/confirmUsername, credible(bool 由客服确认), deviceId(int64), deviceName, deviceSn, deviceType(robot|car|uav|dog), deviceTypeName, eCode, id(int64), latitude/longitude(double), mapName, picUrl, rankUpgrade, reliability(float 可信度), remindType(0 不弹窗/1 弹窗), reviewAlarm, reviewId, source(null=机器人, 1=外部传感器), updateTime, uuid(全局唯一·关联巡逻/值守记录), vdsInfo, videoUrl, x(int 激光地图x), y(int 激光地图y)`

### POST `/robotservice/device/confirmAlarm.action`
- Query：`userId`、`alarmId`（**多 id 用逗号拼接** `"6,7,8"`，必填）、`confirmComment`（必填）、`picUrl`。

### POST `/robotservice/device/closeAlarm.action`
- Query：`id`（单个主键，必填）、`closeComment`、`picUrl`（多图逗号分隔）、`alarmStatus` ∈ `2 关闭 | 3 无需处理`。

## 5. 检测算法注册表

### GET `/robotservice/device/selectDetectionAlgorithmList.action`
- Query：`enableStatus`（可选）。`data` 为数组，字段：

| 字段 | 说明 |
|---|---|
| id / detectionType | 主键 / 检测类型值 |
| detectionTypeName | 检测类型名 |
| alarmType | 绑定告警类型（int 告警码） |
| algorithmDetectType | 算法检测值（绑定算法；大模型类为 null） |
| detectionCategory | 检测领域类别值（1 消防 / 3 环境 / 4 安防 / 5 表计，据样本归纳 UNVERIFIED） |
| enableStatus | 0 关 / 1 开 |
| needConsult | 是否需要参照图（样本值 0/1/2/3/4） |
| needConfirm | 1 需要大模型确认 / 0 不需要 |
| promptTemplate | 大模型问题模板，如「图中是否有人在爬围墙」 |
| extraParameter | 附加参数 JSON 字符串，如 `{"number":5}`（人员聚集阈值） |

真实样本 40 条（节选，含真实告警码）：人体闯入(1→102)、车辆闯入(2→460)、疏散指示灯(5→1002)、消防通道阻塞(6→1009)、门窗异常关/开(7/8→1005)、消防柜物品数量(11→1006)、消火栓漏水(12→1007)、人员聚集(18→1015, extraParameter number:5)、垃圾桶溢满(19→1008)、车辆违停(24→310)、烟感异常(25→1020)、跑冒滴漏(28→2003)、表计读数异常(29→2001)、离岗(30→322, prompt「图中没有人吗」)、大模型爬围墙(34→314)、躺椅子(35→10003)、爬树(36→10004)、钓鱼(37→10005)、表盘风速识别(38→3000, extraParameter 为上下限参数数组)、车辆逆行(42→10007)、地面积水(46→427)、投喂鸽子(48→10010)、鸽子聚集30只(49→10011)。
备注原文：「此表仅限 PDS 图片检测算法，VDS 视频流检测算法见 VdsDetectType 类」。

## 6. 控制

### POST `/robotservice/device/voiceSoundtextSet.action` — 即时喊话
- Query：`soundtext`（必填）、`deviceId`（必填）、`broadcastPriority`（优先级）。
- 响应 `OperResult`：`{device: Device, id, msg, otherInfo, ret, successful}`。

### POST `/robotservice/qpid/robotMoveControl.action` — 本体运动
- Query：`deviceId`、`action`、`speed`（默认 3）。
- action 枚举：`0 停止 / 1 向前 / 2 向后 / 4 向左 / 5 左前 / 6 左后 / 8 向右 / 9 右前 / 10 右后`（无 3/7 档）。

### POST `/robotservice/qpid/sendMQComandByUTF8.action` — 云台 / 一键充电（XML in query）
- Query：`deviceId`、`content`（XML 字符串）；Header `Token`。
- 云台 XML（`To` = deviceId）：

```xml
<?xml version="1.0" encoding="utf-8" ?>
<Root>
  <Header><CmdType>RC_Robot_PTZ_Ctrl</CmdType><To>591</To><From>Clientwpf</From></Header>
  <Robot_PTZ_Ctrl><unCtrlValue>3</unCtrlValue><Value>50</Value></Robot_PTZ_Ctrl>
</Root>
```

- unCtrlValue：`1 上 / 3 右 / 5 下 / 7 左 / 12 复位 / 13 升降杆升 / 14 升降杆降 / 9 镜头放大 / 10 镜头缩小 / 19 焦点前调 / 20 焦点后调`。
- **长按需每 200ms 重发一次；松开发停止**。
- 一键充电 XML：`CmdType=RC_Robot_Ctrl`，`<Robot_Ctrl><unCtrlType>2</unCtrlType><unCtrlValue>1</unCtrlValue></Robot_Ctrl>`；`unCtrlValue=0` 取消充电。
- 响应：`{successful: true, msg: "下发成功", ret: 1}` / 失败 `{successful: false, msg: "机器人不在线", ret: -1}`。

### POST `/robotservice/qpid/changeControl.action` — 切换模式
- Query：`deviceId`、`carmode` ∈ `0 自动 / 1 手动`。

### POST `/robotservice/qpid/pauseTask.action` / `resumeTask.action` — 暂停/恢复巡逻
- Query：`deviceId`。响应三元组 `{successful,msg,ret}`。

### POST `/robotservice/qpid/specificRoutePatrol.action` — 临时跑路线
- Query：`deviceCode`（**这里用 SN**，如 M220221240YF）、`lineCode`（来自路线列表接口）。
- **此接口需要在手动模式下调用**（前置条件由调用方保证）。

### POST `/robotservice/patrol/navigateToPoint.action` — 一键到达坐标点
- Query：`deviceId`、`posX`/`posY`（**激光地图坐标，原点 (0,0) 在左下角**，string）、`angle`（0-360，可选）、`mapName`（必填）、`actionId`（动作组 id，可选——到点后执行动作）、`longitudeWGS84`/`latitudeWGS84`（需标定，误差大，不建议）。
- 响应三元组。

## 7. 地图 / 路线 / 点位 / 计划 / 进度

### GET `/robotservice/patrol/searchPatrolLineAndPoints.action` — 地图+路线+点位一次拉全
- Query：`deviceId`。`data` 为**按地图分组**的数组：

```
{ picWidth, picHeight, mapPicUrl(无 ip 和端口，需用户拼接), deviceId, id(地图id), mapName,
  patrolLineInfo: [{ id(路线id), lineNo(路线编号), lineName, code(=robotSn), name(机器人名),
                     mapId, mapName, mapPicWidth, mapPicHeight,
                     pointRelas: [{ X, Y, id(点位id), radius(标题「点位角度」) }] }],
  beaconPointInfo: [{ name, x, y, id, mapName, type }] }
```

- **重要备注（原文）**：激光地图的坐标以地图**左下角**为原点 (0,0)；绘制显示时以图片**左上角**为原点，需要用地图图片原始高度减去 y 坐标。

### GET `/selectLineInfo.action` — 巡逻路线列表（注意：此接口路径**不带** /robotservice 前缀，文档原样）
- Query：`deviceId`。`data` 数组同时含 camelCase 与 snake_case 孪生字段（原样）：
  `{ lineCode, line_code, device_id, map_name, lineId, lineName, line_name, mapName, id }`

### GET `/robotservice/patrol/listPatrolTargetCapture.action` — 最新巡逻任务执行进度
- Query：`deviceId`。`data`：

```json
{ "captureList": [{ "picUrl": "/robotservice/minioservice/robotv2/snapPictureAnnotation/…jpg",
    "captureName": "温度", "detectValue": "", "captureTime": "2025-09-30 19:53:29",
    "detectType": "电池测温", "pointName": "电池测温", "alarm": "0", "status": "2" }],
  "planName": "机房巡检",
  "alarmList": [{ …同构, "alarm": "1" }],
  "beginTime": "2025-09-30 19:49:47", "deviceName": "南方基地机房巡检机器人" }
// alarm: 0 非告警 / 1 告警；status: 0 待执行 / 1 执行中 / 2 已完成
```

### POST `/robotservice/patrol/addPatrolPlan.action` — 添加巡逻计划
- Header `Token`；Body（multipart/form-data）：
  `lineId`（必填）、`deviceId`（必填）、`planName`（必填）、`beginTime`/`endTime`、
  `timeInterval`（巡逻周期秒，如 600）、`weekly`（周日历 `"1,2,3,4,5,6,7"`）、`singleExecution`（0 周期循环 / 1 单次）。
- 返回计划对象含 `state / runningStatus / runningRobot / lineCode / mapName` 等。
- 配套：`uploadPatrolLinePlans`（**下发**动作/路线/计划到机器人——创建与生效两步）、启停切换、增删改查（同构 CRUD，未逐页抄录）。

## 8. WebSocket 推送协议

- 连接：`wss://<host>/websocket/web/{userId}?remark=…&lang=zh-cn`（`web` 为客户端类型，`{userId}` 为登录用户 id）。
- 连接成功后需发送订阅开关；**客户端需自行实现断线重连**。

### 订阅（client → server）

```json
{ "type": "PushSwitch", "data": { "RobotSituationPushSwitch": 1, "RobotListPushSwitch": 0,
  "AlarmInfoPushSwitch": 1, "LineInfoPushSwitch": 1, "FaceCapturePushSwitch": 0, "RobotStatusPushSwitch": 1 } }
```

- 机器人级开关：`RobotStatusPushSwitch / LineInfoPushSwitch / CurrentStepPushSwitch`；
  单位级开关：`RobotListPushSwitch / AlarmInfoPushSwitch / PatrolCapturePushSwitch / FaceCapturePushSwitch / VehicleCapturePushSwitch / RobotSituationPushSwitch`。
- 开关项数目非固定；同类型新数据覆盖旧数据；**开启后服务器先回一条初始化消息**。
- 增量开关：`AlarmInfoIncrementPushSwitch`（string "1"）等——发送后**不推初始化消息**；命名规律 `XxxPushSwitch → XxxIncrementPushSwitch`（适用于全部单位级开关）。
- 指定机器人过滤：`"PatrolCaptureInfoByRobot": {"enable": true, "deviceId": 591}`、`"AlarmInfoByRobot": {…}`。
- 切换机器人：`{ "data": 49, "type": "DeviceChange" }` → 将收到该机器人 RobotStatus/LineInfo/CurrentStep 三类初始消息，此后其更新实时推送。

### 推送（server → client）帧样本（逐字段照录）

1. **RobotSituation**（概览统计）：`{"data":{"chargeNum":1,"offlineNum":4,"standByNum":0,"total":5,"workingNum":0},"sessionId":"…","type":"RobotSituation","deviceId":62}`
2. **RobotList**：`{"data":[{"addTime":"2022-07-19 20:47:58","control":14,"deviceId":63,"language":3,"modelName":"F1","modelPic":"/robotservice/file/defaultimg/img_robot-F1.png","online":0,"pointPathName":"点位名称","robotName":"七楼204","mapName":"地图名称","planId":29,"latitude":0.006,"longitude":0.0065,"robotSn":"F1200303005","taskType":"offline"}],"sessionId":"…","type":"RobotList","deviceId":63}`
   - taskType 此处多一个 `offline` 值。
3. **TodayPatrolStat**：`{"data":[{"patrolCount":0,"alarmCount":8,"pointCount":4,"captureFinishRate":0.0,"planName":"123","planId":29,"deviceId":62,"deviceName":"…","deviceSn":"F2CRRZ"}],…,"type":"TodayPatrolStat"}`
4. **AlarmInfo**（数组）：`{"data":[{"alarmBeginTime":"2022-07-26 09:36:22","alarmEndTime":"…","alarmLevel":2,"alarmName":"陌生人告警","alarmStatus":0,"alarmType":315,"alarmValue":"0.0","credible":true,"deviceName":"…","deviceSn":"F2CRRZ","eCode":"gxx","id":75771,"latitude":0.006,"longitude":0.0065,"mapName":"7050712","picUrl":"/robotservice/minioservice/robotv2/messy/….jpeg","address":"地址"}],…,"type":"AlarmInfo","deviceId":63}`
   - 告警码样本：315 = 陌生人告警。
5. **AlarmRunInfo**（本体故障）：`{"data":[{"deviceId":62,"addTime":"2022-07-29 09:34:19","code":"50101","name":"位置丢失","describe":"原因分析：1、机器人激光不匹配环境，无法确认自己的位置。解决方案：1、手动初始化机器人位置。","exceType":"导航","position":"{'x':'605','y':'535','mapName':'0722'}","modelPic":"/robotservice/file/defaultimg/img_robot-X1.png","deviceName":"…"}],…,"type":"AlarmRunInfo","deviceId":66}`
   - 故障码样本：50101 = 位置丢失（导航类）；`position` 是**单引号伪 JSON 字符串**（原样）。
6. **RobotStatus**（**增量 delta 推送**——「不是全量推，后台有变化才推，接收解析时需要判断是否有该字段」）：

```json
{ "data": { "angle": -87.5, "latitude": 39.920886, "longitude": 116.318542, "mapName": "yytxb06131",
  "robotSn": "F2230204203", "speed": 0, "xPosition": 1769, "yPosition": 162, "ifChargeTask": 0,
  "charge": "正在充电", "electricity": 100, "voltage": 49.69, "batteryTemp": 37,
  "longitudeWGS84": 116.30597932616666, "latitudeWGS84": 39.91366923166667, "stopStatus": 0,
  "mileage": 236143, "currentMileage": 0, "duration": 46834, "currentDuration": 2,
  "isPatrolStop": 1, "planName": "111", "patrolPlanId": 1201,
  "temperature": "33.50", "humidity": "44.90" }, "type": "RobotStatus" }
```

  - 注意：帧内经纬度注释为 **BD09**，同时带 WGS84 字段；顶层无 sessionId/deviceId（以 robotSn 定位）。
7. **PatrolCaptureInfo**：`{"data":[{"actionUnitId":43762,"algorithmDetectionImage":"/robotservice/minioservice/robotv2/patrolSnap/….jpeg","beaconPointCode":"207","createTime":"2025-06-17 16:41:45","detectionType":0,"deviceCode":"F2230203115L","deviceId":723,"deviceName":"xx广场","eCode":"abxahb","id":17505780,"lineCode":"2","patrolTime":"2025-06-17 16:41:44","picName":"周界安全","picUrl":"/robotservice/minioservice/robotv2/patrolSnap/….jpeg","uuid":"…"}],"type":"PatrolCaptureInfo"}`

## 9. sim / adapter 实现面划分

**sim（伪 GoRobot 云 + 机器人行为模型）必须提供：**
- HTTP：login（Basic + md5 + multipart）、keepTokenConnection、searchRobotList、findRobotStatus、selectChannelList、getVideoUrl（10s 时效 token 化 url）、findAlarmStatByParam、confirmAlarm、closeAlarm、selectDetectionAlgorithmList、voiceSoundtextSet、robotMoveControl、sendMQComandByUTF8（解析 XML：PTZ + 充电）、changeControl、pauseTask、resumeTask、specificRoutePatrol（校验手动模式，否则 `{successful:false,msg:"…",ret:-1}`）、navigateToPoint、searchPatrolLineAndPoints、selectLineInfo（无前缀路径）、listPatrolTargetCapture、addPatrolPlan。
- WS：`/websocket/web/{userId}`，PushSwitch/DeviceChange 语义（含初始化消息、增量开关不发初始化、DeviceChange 重定向机器人级推送），推 RobotStatus（**delta**）、AlarmInfo、AlarmRunInfo、PatrolCaptureInfo、RobotSituation、RobotList。
- 行为模型：激光地图坐标系（左下角原点，px 单位）驱动 F2 巡逻环 + 点位停顿抓拍 + 告警产生（含大模型类 alarmType）+ 电量/里程/充电状态机 + 急停/暂停/手自动模式。

**adapter（GoRobot client → Plantbot integration v1）映射：**
- login + keepalive 循环（2h 滑动，提前续）；WS 订阅 RobotStatus/AlarmInfo/AlarmRunInfo/PatrolCaptureInfo + 断线重连 + REST 兜底轮询。
- RobotStatus.delta → 合并缓存 → `POST /robots/:serial/state`（激光 px → 场站米坐标做线性变换；angle 度→弧度）。
- AlarmInfo → `POST /events`（alarmType→事件类型映射表；picUrl 拼 host 成完整 url 作 snapshotUrl；credible/reliability→confidence）。
- AlarmRunInfo → `POST /events`（category: robot-fault）。
- findRobotStatus 温湿度/噪声/气体 → `POST /robots/:serial/readings`（amb.temp.c/amb.rh.pct/noise.db…）。
- selectChannelList + getVideoUrl → 注册 streams（10s 时效意味着 adapter 不能预取——注册占位 url 或按需刷新）。
- 平台 order goto → `navigateToPoint`（米→激光 px 逆变换）；order mission → `specificRoutePatrol`（先 `changeControl(1)` 切手动——忠实还原它的前置条件）；order announce → `voiceSoundtextSet`。
- 平台 command dock → sendMQComandByUTF8 一键充电 XML；pause/resume → pauseTask/resumeTask。
