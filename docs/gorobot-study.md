# 高新兴 (Gosuncn / GoRobot) 巡逻机器人平台调研

> 调研时间:2026-07。素材:Apifox 共享文档(76 页目录,精读 32 个核心接口 + WebSocket 协议页)与
> 厂商云 管理平台实操(数据概览 / 运行监视 / 机器人视图 / 数据中心 / 配置中心)。
> 目的:**不是兼容它**,而是从一个真实量产厂商的功能面貌里提炼 Plantbot 集成层该长什么样。
> 设计结论见 [platform-model.md](platform-model.md)。

## 1. 产品形态

四个顶层模块:

- **数据概览** — 全国地图大屏 + 统计卡(巡控区域/面积/里程/设备数;日均任务/时长/里程;告警总数)。
- **运行监视** — 机器人卡片(位置/视频/路线/视图四操作)、巡检告警流(未处理/处理中)、
  今日告警分类饼图(消防/环境/安防/工业)、**机器人运行告警**(本体故障,与巡检告警分流)。
  - **机器人视图**(单机驾驶舱):主视频 + 前/后/左/右四通道切换 + 热成像窗 + 激光地图轨迹缩略
    + 实时抓拍流 + 计划进度(巡查进度/巡查异常双环)+ 告警表(确认/定位操作)+ 云台/灯光/喊话工具条。
- **数据中心** — 报表(运行统计、巡逻日报/月报、值守报告…)+ **12 种记录各一页**
  (告警、陌生人脸、已识别人脸、告警联动、截图、语音对话、录音、抓拍车辆、传感器、系统日志、异常码、人流量)+ 录像中心。
- **配置中心** — 告警配置×4 页(告警/联动/推送/语音播报)+ 设备管理×10 页
  (机器人、人脸库、车辆库、电梯、传感器、智慧空开、消防柜、巡检记录仪、区域、知识库)。

**关键结构观察:路线/计划/动作不在平台级菜单里**,入口藏在单台机器人的「配置/计划」下
(`robot-config?id=…&robotModel=F2`)。整个任务模型是 **机器人中心** 的:路线绑定
`deviceId + mapName`,地图是机器人的私产,计划是机器人的属性。多机协同、跨机复用路线在这个模型里不存在。

## 2. API 面貌(按域)

RPC 风格,全部 `/robotservice/**/*.action`;POST 参数也放 query string;鉴权为自定义 header `tk`。

### 认证
- `POST /robotservice/auth/login` — header `authorization: Basic YWRtaW46YWRtaW4=`(写死 admin:admin)
  + 账号 + **md5 密码** + `grant_type=password` → `access_token`,2h 滑动过期,需定时保活。
- iframe 嵌入方案:`…/robot-patrol-view?token=…` — **token 放 URL query**。

### 视频/音频(通道模型 ✓)
- `selectChannelList(deviceId)` → 通道表:前/高清/热成像/后/左/右/音频,H264/H265。
- `getVideoUrl(channelId, protocol)` — protocol ∈ websocket/rtsp/rtmp/hls,建议 websocket+flv.js;
  **返回的 url 10 秒内必须点播,超时重取**。
- 录像:`getVideoRecordList` / `getDeviceVideoRecordUrl`(此接口机器人 id 叫 `modelId`,通道叫 `cameraId`)。
- 对讲/监听:`getAudioStreamUrl(channelId, interactionType)`,三步协议(取 ws → 对讲 → 显式关闭)。

### 机器人
- `searchRobotList` — 分页;online、电量、工作模式(0 自动/1 手动)、taskType(patrol/watch/charge/standBy)、急停状态。
- `findRobotStatus` — **一层平铺 80+ 字段**:α/β/γ/中子射线(CPS)、CO2/SO2/硫化物/毒气(ppb)、臭氧/紫外灯/大灯/警示灯开关、
  噪声 dB、温湿度×3(下/中/上)、气压、海拔、电流/电压/功率/电池温度、里程与时长(总计+本次开机)、
  GPS 固定解(无信号/浮点解/固定解)、云台(目标距离/水平角/垂直角)、
  **四套坐标**:WGS84 lat/lon + 激光地图 x/y + 航拍图 x/y + 标定转换后坐标。
  另有 `SensorStatus` 嵌套数组自成一套(AlarmType/Name/Threshold/Unit/Value)。

### 告警
- `findAlarmStatByParam` — 筛选:类型/级别/时间/**状态(0 未处理/1 待处理/2 已关闭/3 无需处理)**/
  **复核状态(null 无需/0 待复核/1 复核中/2 复核完成)**。
  记录含:`credible`(是否可信,**由厂商客服人工确认**)、`algorithmDetectionImage`(存图用于算法训练)、
  `picUrl`、经纬度 + 激光地图 x/y + `mapName`、音频提醒配置、弹窗标志、
  来源(null=机器人,1=外部传感器)、`patrolId`(全局唯一,关联巡逻记录)。
- `confirmAlarm`(批量 id 逗号拼接 + 备注 + 图)/ `closeAlarm`(状态 2 关闭或 3 无需处理)。

### CV 算法(检测类型注册表 ✓)
- `getDetectionTypeList` — 40+ 种:人体/车辆闯入、疏散指示灯、消防通道阻塞、门窗异常开/关、消防柜物品数量、
  消火栓漏水、防火卷帘、应急照明、人员聚集、垃圾桶溢满、安全出口上锁、车辆违停/逆行、烟感、跑冒滴漏、
  表计读数异常、离岗、地面积水、屏幕挂牌作业、**大模型识别系列**(爬围墙/躺椅子/爬树/钓鱼/投喂鸽子/鸽子聚集,
  带 `promptTemplate`,如「图中是否有人在钓鱼」)、表盘风速识别(带属性上下限参数)。
- 字段:绑定告警类型、算法检测值、启用状态、**`needLargeModel`(是否需要大模型二次确认)**、
  是否需要参照图、附加参数。
- 注释明示:**「此表仅限 PDS 图片检测算法,VDS 视频流检测算法见 VdsDetectType 类」** — 图片/视频两套算法栈并行。

### 动作(巡逻点位执行单元 ✓)
- `setAction` — 动作组 → 动作单元(抓拍如「大门抓拍」、检测如「2号门窗异常关闭检测」、
  语音播报 `soundText`「请注意安全!」)。id 为 null 即新增(upsert 语义藏在字段里)。
- `getActionTypeByDeviceId` — **每台机器人**支持的动作类型。

### 导航点 / 地图 / 路线
- `addBeaconPoint(code,name,deviceId,mapName,type,x,y)` / `searchBeaconPointList`(groupId 分组)。
- `getRobotMapLinePoint(deviceId)` — 机器人的地图+路线+点位一次拉全。文档核心备注:
  **「激光地图的坐标是以地图左下角为原点(0,0),绘制显示的时候是以图片左上角为原点(0,0),
  需要用地图图片原始高度减去 y 坐标」** — 坐标翻转责任在每个消费方。
  地图 url「没有 ip 和端口,需要用户拼接」。
- 路线上传分两个接口:**手绘路径**(`robotConfigs` + `clientConfigs` **双份配置**,机器人格式与前端格式分开存)
  与**组合路径**(引用既有导航点 `originPointId` + radius)。

### 巡逻计划
- `addPatrolPlan` — lineId + deviceId + 起止时间 + 巡逻周期(秒)+ 周日历 + 执行模式(0 周期循环/1 单次)。
- `uploadPatrolLinePlans` — **「下发」动作、路线、计划到机器人**。创建与生效是两步,不原子,
  下发前平台与机器人两边状态不一致。
- 临时跑路线 `specificRoutePatrol` — **要求先切手动模式**(前置状态由调用方保证)。

### 巡逻记录
- `listPatrolTargetCapture` — 最新任务执行进度:**点位级 capture 流**(抓拍名/巡检值/检测类型/点位名/
  是否告警/巡检状态 待执行-执行中-已完成)。
- `selectAllPatrolReport` — 圈数、告警总数、人脸总数、抓拍图片总数。

### 控制
- `robotMoveControl(action, speed)` — action 0-10 方向枚举(0 停/1 前/2 后/4 左/5 左前…)。
- 云台/一键充电共用 `sendMQComandByUTF8` — **在 query 里塞一段 XML**,`unCtrlValue` 魔数
  (1 上/3 右/5 下/7 左/12 复位/13-14 升降杆/9-10 变焦/19-20 焦点/0 取消充电);
  长按需**客户端每 200ms 重发**,松开再发停止。
- `changeControl(carmode)` 切自动/手动;`voiceSoundtextSet(soundtext, broadcastPriority)` 即时喊话。

### WebSocket 推送
- `wss://…/websocket/web/{userId}`;**PushSwitch 开关式订阅**:RobotList/AlarmInfo/RobotSituation/
  PatrolCapture/FaceCapture/VehicleCapture 单位级开关;RobotStatus/LineInfo/CurrentStep 机器人级开关,
  切换机器人要先发 `DeviceChange` 再逐个重开。
- `RobotStatus` 为**增量推送**(delta,字段可缺);坐标同时给 BD09 + WGS84 + 激光地图 x/y。
- `AlarmInfo` 数字告警码(如 315 陌生人);`AlarmRunInfo` 本体故障码(如 50101 位置丢失)带原因/处置文本。

## 3. 值得吸收的领域概念

这些是真实运营长出来的形状,Plantbot 应当有对应物(以更干净的方式):

1. **通道(Channel)模型** — 视频不是「机器人的一个 url」,而是一组通道(前/后/云台/热成像/音频),
   各有编码与角色。
2. **告警生命周期 + 复核流 + 可信度** — 单条巡逻计划总告警 3746 次(平台实测数字)——
   误报洪水是常态,所以长出了:确认/关闭/无需处理、待复核→复核中→复核完成、credible 人工标注、
   `algorithmDetectionImage` 训练数据回流。**事件系统必须为「大部分事件是垃圾」设计**。
3. **检测类型注册表** — CV 算法是平台一等数据:绑定告警类型、可启停、带参数、
   **可挂大模型二次确认(promptTemplate)**、可带参照图。算法目录与机器人解耦。
4. **动作单元** — 巡逻点位上的执行语义:抓拍 / 检测 / 喊话 / 云台预置位 / 读表。任务 = 路线 × 各点动作。
5. **点位级执行进度** — 巡逻不是黑盒,每个点产生 capture(值+图+是否告警),前端能画出「巡查进度环」。
6. **巡检告警与本体故障分流** — 业务事件(algorithm)与机器人健康(fault)是两条流、两种受众。
7. **标定的存在** — 激光地图 ↔ 航拍图 ↔ GPS 的坐标转换是产品必需(他们做了,但做成了黑盒字段)。
8. **对讲会话三步协议** — 音频交互天然是会话(开→用→关),不是 getter。

## 4. 反面清单(明确不学)

| # | 缺陷 | 证据 | Plantbot 对策 |
|---|------|------|--------------|
| 1 | RPC `.action` + POST 参数放 query,控制命令是 query 里的 XML 字符串 | `sendMQComandByUTF8` | 资源化 REST + JSON body,命令语义化 |
| 2 | 命名漂移:同一概念叫 deviceId/modelId/robotId/deviceCode/robotSn;channelId/cameraId | 录像接口文档自注「跟其他接口的 deviceId 一样」 | 全局唯一 `robotId`/`serial`,一处定义 |
| 3 | 鉴权:Basic admin:admin 写死 + md5 密码 + 自定义 tk header + **iframe 把 token 放 URL** | 登录/嵌入文档 | 保持现有 HMAC cookie 会话 + scoped Bearer key,token 永不进 URL |
| 4 | `findRobotStatus` 平铺 80+ 传感器字段,新增传感器 = 改 API schema | α 射线到臭氧开关同层 | 通用 PayloadReading 信封 + metric 注册表 |
| 5 | 四套坐标混发,图片坐标翻转(height−y)责任甩给每个消费方 | 路线接口「重要备注」 | 站点世界系唯一出口,变换是服务端资源 |
| 6 | 地图靠 `mapName` 字符串当主键,url 还要客户端拼 host | `getRobotMapLinePoint` | Map 一等资源,带 id/kind/分辨率/origin/完整 url |
| 7 | 路线双份配置(robotConfigs+clientConfigs),平台与机器人各存一份真相 | 手绘路径上传 | 单一模板真相,下发即渲染(adapter 翻译) |
| 8 | 计划「创建→下发」两步不原子;临时任务要求调用方先切手动模式 | `uploadPatrolLinePlans`/`specificRoutePatrol` | Schedule→Run 由平台状态机驱动,前置条件服务端校验 |
| 9 | 视频 url 10 秒时效的隐式契约 | `getVideoUrl` 描述 | 流地址 = 显式会话资源(expiresAt/续期/撤销) |
| 10 | 长按控制靠客户端 200ms 重发,松手发停止 | 云台文档 | deadman 由服务端超时实现,客户端只表达意图 |
| 11 | 12 种记录 12 张表 12 个页面,无统一事件流;PDS/VDS 两套算法栈 | 数据中心菜单/算法文档注释 | 统一 Event 信封 + evidence 多态 |
| 12 | 有状态 WS 订阅开关,换机器人要 DeviceChange + 逐开关重开 | PushSwitch 协议 | 保持现有「连接即房间,全量推」;规模化再按 topic 声明式订阅 |
| 13 | 设备类型爆炸:电梯/空开/消防柜/记录仪各一套管理页 | 配置中心菜单 | 非机器人设备走同一 integration API(state+events),不做专属模块 |
| 14 | 机器人中心的任务模型:路线/地图/计划都挂在单机上 | 配置入口藏在 robot-config | **站点中心**:World 持有地图/航点/模板,机器人是可调度资源 |
| 15 | 离线设备页面直接空白,无降级;演示数据时间戳 2031 年 | 平台实操 | 一切实体有 offline/empty 降级态 |

## 5. 覆盖范围

已精读:auth、视频/音频通道、机器人列表/状态、告警查询/确认/关闭、检测算法列表、动作组/单元、
导航点、地图路线点位、路线上传×2、巡逻计划×2、巡逻进度/报表、移动/云台/模式/充电/喊话控制、
iframe 嵌入、WebSocket 全协议。未逐页读(按目录判断为同构 CRUD):人脸库/车辆库、传感器管理、
单位/用户管理、报表导出类接口。
