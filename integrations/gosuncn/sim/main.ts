// GoRobot（高新兴）云平台仿真 · 线协议层。
// 按 docs/vendors/gosuncn-api.md 逐字段还原 server 面：
//   - RPC 风格 `/robotservice/**/*.action`，POST 参数也在 query string
//   - 登录 Basic admin:admin + md5 密码 + multipart form，Token 自定义 header，2h 滑动过期
//   - WS /websocket/web/{userId}：PushSwitch 订阅开关 + DeviceChange + RobotStatus 增量推送
//   - getVideoUrl 返回 10 秒时效的取流地址
// 怪癖（POST-in-query、selectLineInfo 无前缀、XML 控制命令）全部原样保留 —— adapter
// 面对的必须是真实世界的形状。

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { WebSocketServer, WebSocket } from 'ws'
import { createHash, randomUUID } from 'node:crypto'
import { makeLog } from '../../shared/log.js'
import { GoRobotFleet, MAP, LINES, BEACON_POINTS, DETECTION_REGISTRY, type SimRobot } from './model.js'

const log = makeLog('gosuncn-sim')
const PORT = Number(process.env.GOSUNCN_SIM_PORT ?? 9101)
const ACCOUNT = process.env.GOSUNCN_SIM_USER ?? 'campus01'
const PASSWORD_MD5 = createHash('md5')
  .update(process.env.GOSUNCN_SIM_PASS ?? 'gorobot@2025')
  .digest('hex')

const fleet = new GoRobotFleet()

// ---------- token 池（2h 滑动过期，携带即顺延） ----------
const TOKEN_TTL = 2 * 3600_000
const tokens = new Map<string, { userId: number; expiresAt: number }>()
let userSeq = 14

const wrap = (data: unknown, msg = '操作成功') => ({ ret: 1, code: '1000', msg, data })
const fail = (msg: string) => ({ ret: -1, code: '500', msg, data: null })
const oper = (ok: boolean, msg: string) => ({ successful: ok, msg, ret: ok ? 1 : -1 })

// ---------- 10 秒时效的取流地址 ----------
const videoNonces = new Map<string, { channelId: string; expiresAt: number }>()

const app = Fastify({ logger: false })
await app.register(multipart, { attachFieldsToBody: 'keyValues' })

type Q = Record<string, string | undefined>

/** Token 校验（除登录外所有 .action）；有效则滑动续期 */
function auth(req: { headers: Record<string, unknown> }): { userId: number } | null {
  const tk = String(req.headers.token ?? '')
  const rec = tokens.get(tk)
  if (!rec || rec.expiresAt < Date.now()) return null
  rec.expiresAt = Date.now() + TOKEN_TTL
  return { userId: rec.userId }
}

app.post('/robotservice/auth/login', async (req, reply) => {
  // 文档原样：Authorization 固定 Basic YWRtaW46YWRtaW4=（admin:admin）
  if (req.headers.authorization !== 'Basic YWRtaW46YWRtaW4=') return reply.send(fail('client 认证失败'))
  const b = (req.body ?? {}) as Record<string, string>
  if (b.grant_type !== 'password') return reply.send(fail('grant_type 必须为 password'))
  if (b.username !== ACCOUNT || (b.password ?? '').toLowerCase() !== PASSWORD_MD5)
    return reply.send(fail('账号或密码错误'))
  const token = randomUUID().replace(/-/g, '')
  tokens.set(token, { userId: userSeq, expiresAt: Date.now() + TOKEN_TTL })
  return wrap({ access_token: token, token_type: 'bearer', expires_in: 7200, userId: userSeq })
})

app.get('/robotservice/user/keepTokenConnection.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  return { ret: 1, code: '1000', msg: '延长token时间成功', data: null }
})

app.get('/robotservice/device/searchRobotList.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const kw = q.robotNameOrCode ?? ''
  const rows = fleet.robots
    .filter((r) => !kw || r.robotName.includes(kw) || r.robotSn.includes(kw))
    .map((r) => ({
      deviceId: r.deviceId,
      robotName: r.robotName,
      robotSn: r.robotSn,
      online: r.online,
      companyName: r.companyName,
      companyCode: r.companyCode,
      deviceType: 'robot',
      electricity: String(Math.round(r.electricity)),
      workStatus: r.workStatus,
      taskType: r.taskType,
      stopStatus: String(r.stopStatus),
    }))
  return wrap({ currentPage: Number(q.page ?? 1), total: rows.length, pageSize: Number(q.pageSize ?? 10), rows })
})

app.get('/robotservice/device/findRobotStatus.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = q.robotSn ? fleet.bySn(q.robotSn) : fleet.byDeviceId(Number(q.deviceId))
  if (!r) return reply.send(fail('机器人不存在'))
  return wrap(fleet.statusOf(r))
})

const CHANNELS: Record<number, { channelId: string; videoCode: string; camIconUrl: string; name: string }[]> = {
  591: [
    { channelId: '1958', videoCode: 'H264', camIconUrl: '/robotservice/file/defaultimg/cam_front.png', name: '前' },
    { channelId: '1959', videoCode: 'H265', camIconUrl: '/robotservice/file/defaultimg/cam_thermal.png', name: '热成像' },
    { channelId: '1960', videoCode: 'H264', camIconUrl: '/robotservice/file/defaultimg/cam_rear.png', name: '后' },
    { channelId: '1961', videoCode: 'H264', camIconUrl: '/robotservice/file/defaultimg/cam_audio.png', name: '音频' },
  ],
  592: [
    { channelId: '2058', videoCode: 'H264', camIconUrl: '/robotservice/file/defaultimg/cam_front.png', name: '前' },
    { channelId: '2059', videoCode: 'H264', camIconUrl: '/robotservice/file/defaultimg/cam_rear.png', name: '后' },
  ],
}

app.get('/robotservice/device/selectChannelList.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  return wrap(CHANNELS[Number(q.deviceId)] ?? [])
})

app.get('/robotservice/device/getVideoUrl.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const channelId = q.channelId ?? ''
  if (!Object.values(CHANNELS).flat().some((c) => c.channelId === channelId))
    return reply.send(fail('通道不存在'))
  // 「获取到的url，需要在10秒内点播，超时需要重新获取」
  const nonce = randomUUID().slice(0, 8)
  videoNonces.set(nonce, { channelId, expiresAt: Date.now() + 10_000 })
  return wrap({ cameraid: Number(channelId), url: `ws://127.0.0.1:${PORT}/videostream/${nonce}` })
})

app.get('/robotservice/device/findAlarmStatByParam.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  let rows = fleet.alarms.slice()
  if (q.deviceId) rows = rows.filter((a) => a.deviceId === Number(q.deviceId))
  if (q.deviceSn) rows = rows.filter((a) => a.deviceSn === q.deviceSn)
  if (q.alarmStatus !== undefined && q.alarmStatus !== '') rows = rows.filter((a) => a.alarmStatus === Number(q.alarmStatus))
  if (q.alarmStatusStr) {
    const set = new Set(q.alarmStatusStr.split(',').map(Number))
    rows = rows.filter((a) => set.has(a.alarmStatus))
  }
  const page = Number(q.page ?? 1)
  const pageSize = Number(q.pageSize ?? 10)
  return wrap({
    currentPage: page,
    pageSize,
    total: rows.length,
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
  })
})

app.post('/robotservice/device/confirmAlarm.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const ids = (q.alarmId ?? '').split(',').map(Number)
  let n = 0
  for (const a of fleet.alarms)
    if (ids.includes(a.id)) {
      a.alarmStatus = 1
      a.confirmComment = q.confirmComment
      a.confirmTime = new Date().toISOString()
      n++
    }
  return n ? wrap(null, '确认成功') : fail('告警不存在')
})

app.post('/robotservice/device/closeAlarm.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const a = fleet.alarms.find((x) => x.id === Number(q.id))
  if (!a) return fail('告警不存在')
  a.alarmStatus = q.alarmStatus === '3' ? 3 : 2
  a.closeComment = q.closeComment
  a.closeTime = new Date().toISOString()
  return wrap(null, '关闭成功')
})

app.get('/robotservice/device/selectDetectionAlgorithmList.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const rows = q.enableStatus !== undefined && q.enableStatus !== ''
    ? DETECTION_REGISTRY.filter((d) => d.enableStatus === Number(q.enableStatus))
    : DETECTION_REGISTRY
  return wrap(rows)
})

app.post('/robotservice/device/voiceSoundtextSet.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = fleet.byDeviceId(Number(q.deviceId))
  if (!r || !r.online) return { successful: false, msg: '机器人不在线', ret: -1 }
  if (!q.soundtext) return { successful: false, msg: 'soundtext 必填', ret: -1 }
  log.info(`${r.robotName} 播报: 「${q.soundtext}」 (priority=${q.broadcastPriority ?? 0})`)
  return { device: null, id: r.deviceId, msg: '下发成功', otherInfo: '', ret: 1, successful: true }
})

app.post('/robotservice/qpid/robotMoveControl.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = fleet.byDeviceId(Number(q.deviceId))
  if (!r || !r.online) return oper(false, '机器人不在线')
  const ok = fleet.moveControl(r, Number(q.action), Number(q.speed ?? 3))
  return oper(ok, ok ? '下发成功' : '需要手动模式')
})

app.post('/robotservice/qpid/sendMQComandByUTF8.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = fleet.byDeviceId(Number(q.deviceId))
  if (!r || !r.online) return oper(false, '机器人不在线')
  const xml = q.content ?? ''
  const cmdType = /<CmdType>([^<]+)<\/CmdType>/.exec(xml)?.[1]
  const ctrlValue = Number(/<unCtrlValue>(-?\d+)<\/unCtrlValue>/.exec(xml)?.[1] ?? NaN)
  if (cmdType === 'RC_Robot_PTZ_Ctrl') {
    const value = Number(/<Value>(-?\d+)<\/Value>/.exec(xml)?.[1] ?? 50)
    if (Number.isNaN(ctrlValue)) return oper(false, '命令解析失败')
    fleet.ptzControl(r, ctrlValue, value)
    return oper(true, '下发成功')
  }
  if (cmdType === 'RC_Robot_Ctrl') {
    const ctrlType = Number(/<unCtrlType>(\d+)<\/unCtrlType>/.exec(xml)?.[1] ?? NaN)
    if (ctrlType === 2) {
      fleet.oneKeyCharge(r, ctrlValue !== 0)
      return oper(true, ctrlValue !== 0 ? '一键充电已下发' : '取消充电已下发')
    }
  }
  return oper(false, '命令解析失败')
})

app.post('/robotservice/qpid/changeControl.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = fleet.byDeviceId(Number(q.deviceId))
  if (!r || !r.online) return fail('机器人不在线')
  r.workStatus = Number(q.carmode) === 1 ? 1 : 0
  if (r.workStatus === 1) r.taskType = 'standBy'
  else if (r.taskType === 'standBy') r.taskType = 'patrol'
  return wrap(null, '切换成功')
})

app.post('/robotservice/qpid/pauseTask.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const r = fleet.byDeviceId(Number((req.query as Q).deviceId))
  if (!r || !r.online) return oper(false, '机器人不在线')
  r.isPatrolStop = 1
  return oper(true, '暂停成功')
})

app.post('/robotservice/qpid/resumeTask.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const r = fleet.byDeviceId(Number((req.query as Q).deviceId))
  if (!r || !r.online) return oper(false, '机器人不在线')
  r.isPatrolStop = 0
  return oper(true, '恢复成功')
})

app.post('/robotservice/qpid/specificRoutePatrol.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = q.deviceCode ? fleet.bySn(q.deviceCode) : undefined // 此接口用 SN（文档原样）
  if (!r || !r.online) return oper(false, '机器人不在线')
  if (r.workStatus !== 1) return oper(false, '请先切换手动模式') // 前置条件由调用方保证（文档原样）
  const line = LINES.find((l) => l.lineNo === q.lineCode)
  if (!line) return oper(false, '路线不存在')
  r.line = line
  r.leg = 0
  r.isPatrolStop = 0
  r.taskType = 'patrol'
  r.navTask = { X: line.points[0].X, Y: line.points[0].Y }
  return oper(true, '下发成功')
})

app.post('/robotservice/patrol/navigateToPoint.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = fleet.byDeviceId(Number(q.deviceId))
  if (!r || !r.online) return oper(false, '机器人不在线')
  if (q.mapName !== MAP.mapName) return oper(false, '地图不匹配')
  const X = Number(q.posX)
  const Y = Number(q.posY)
  if (!Number.isFinite(X) || !Number.isFinite(Y)) return oper(false, '坐标非法')
  const ok = fleet.navigateToPoint(r, X, Y, q.actionId ? Number(q.actionId) : undefined)
  return oper(ok, ok ? '下发成功' : '机器人急停中')
})

app.get('/robotservice/patrol/searchPatrolLineAndPoints.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = fleet.byDeviceId(Number(q.deviceId))
  if (!r) return reply.send(fail('机器人不存在'))
  return wrap([
    {
      picWidth: MAP.picWidth,
      picHeight: MAP.picHeight,
      patrolLineInfo: LINES.map((l) => ({
        pointRelas: l.points,
        code: r.robotSn,
        mapPicWidth: MAP.picWidth,
        mapPicHeight: MAP.picHeight,
        lineName: l.lineName,
        mapPicUrl: `/robotservice/minioservice/robotv2/map/${MAP.mapName}.png`, // 无 host，需调用方拼接（文档原样）
        lineNo: l.lineNo,
        name: r.robotName,
        mapId: String(MAP.mapId),
        id: l.id,
        mapName: MAP.mapName,
      })),
      beaconPointInfo: BEACON_POINTS,
      mapPicUrl: `/robotservice/minioservice/robotv2/map/${MAP.mapName}.png`,
      deviceId: r.deviceId,
      id: MAP.mapId,
      mapName: MAP.mapName,
    },
  ])
})

// 注意：此接口路径不带 /robotservice 前缀（文档原样）
app.get('/selectLineInfo.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const q = req.query as Q
  const r = q.deviceId ? fleet.byDeviceId(Number(q.deviceId)) : fleet.robots[0]
  return wrap(
    LINES.map((l) => ({
      lineCode: l.lineNo,
      line_code: l.lineNo,
      device_id: r?.deviceId ?? 0,
      map_name: MAP.mapName,
      lineId: l.id,
      lineName: l.lineName,
      line_name: l.lineName,
      mapName: MAP.mapName,
      id: l.id,
    })),
  )
})

app.get('/robotservice/patrol/listPatrolTargetCapture.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const r = fleet.byDeviceId(Number((req.query as Q).deviceId))
  if (!r) return reply.send(fail('机器人不存在'))
  return wrap({
    captureList: r.captures,
    planName: r.planName,
    alarmList: fleet.alarms.filter((a) => a.deviceId === r.deviceId).slice(0, 5).map((a) => ({
      picUrl: a.picUrl,
      captureName: a.alarmName,
      detectValue: a.alarmName,
      detectType: a.alarmName,
      captureTime: a.alarmBeginTime,
      pointName: '途中检测',
      alarm: '1',
      status: '2',
    })),
    beginTime: r.captures.at(-1)?.captureTime ?? '',
    deviceName: r.robotName,
  })
})

const plans: Record<string, unknown>[] = []
app.post('/robotservice/patrol/addPatrolPlan.action', async (req, reply) => {
  if (!auth(req)) return reply.send(fail('token无效或已过期'))
  const b = (req.body ?? {}) as Record<string, string>
  if (!b.lineId || !b.deviceId || !b.planName) return fail('lineId、deviceId、planName 必填')
  const plan = {
    id: 1200 + plans.length,
    deviceId: Number(b.deviceId),
    patrolNum: 0,
    planName: b.planName,
    beginTime: b.beginTime ?? '',
    endTime: b.endTime ?? '',
    timeInterval: Number(b.timeInterval ?? 600),
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    state: 1,
    groupId: null,
    weekly: b.weekly ?? '1,2,3,4,5,6,7',
    singleExecution: Number(b.singleExecution ?? 0),
    interactiveSupport: 0,
    runningStatus: 0,
    runningRobot: null,
    runningRobotId: null,
    lineCode: null,
    mapName: null,
  }
  plans.push(plan)
  return wrap(plan)
})

// ---------- WebSocket：/websocket/web/{userId} ----------

interface ConnState {
  ws: WebSocket
  userId: number
  switches: Record<string, unknown>
  currentDeviceId: number
  lastStatus: Map<number, Record<string, unknown>>
}

const conns = new Set<ConnState>()
const wssPush = new WebSocketServer({ noServer: true })
const wssVideo = new WebSocketServer({ noServer: true })

const on = (c: ConnState, k: string) => c.switches[k] === 1 || c.switches[k] === '1'

function send(c: ConnState, frame: Record<string, unknown>) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(frame))
}

function robotListFrame() {
  return fleet.robots.map((r) => ({
    addTime: '2024-01-17 09:00:00',
    control: 14,
    deviceId: r.deviceId,
    language: 3,
    modelName: 'F2',
    modelPic: '/robotservice/file/defaultimg/img_robot-F2.png',
    online: r.online,
    pointPathName: r.line.lineName,
    robotName: r.robotName,
    mapName: MAP.mapName,
    planId: r.patrolPlanId,
    latitude: 31.302,
    longitude: 121.5,
    robotSn: r.robotSn,
    taskType: r.online ? r.taskType : 'offline',
  }))
}

function situationFrame() {
  const t = fleet.robots
  return {
    chargeNum: t.filter((r) => r.taskType === 'charge').length,
    offlineNum: t.filter((r) => !r.online).length,
    standByNum: t.filter((r) => r.online && r.taskType === 'standBy').length,
    total: t.length,
    workingNum: t.filter((r) => r.online && (r.taskType === 'patrol' || r.taskType === 'watch')).length,
  }
}

wssPush.on('connection', (ws, req) => {
  const userId = Number(/\/websocket\/web\/(\d+)/.exec(req.url ?? '')?.[1] ?? 0)
  const c: ConnState = { ws, userId, switches: {}, currentDeviceId: fleet.robots[0].deviceId, lastStatus: new Map() }
  conns.add(c)
  log.info(`WS 接入 userId=${userId}（当前 ${conns.size} 连接）`)
  ws.on('message', (raw) => {
    let msg: { type?: string; data?: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'PushSwitch' && msg.data && typeof msg.data === 'object') {
      const prev = { ...c.switches }
      Object.assign(c.switches, msg.data)
      // 非增量开关开启 → 先回一条初始化消息（文档语义）
      const turnedOn = (k: string) => on(c, k) && !(prev[k] === 1 || prev[k] === '1')
      if (turnedOn('RobotListPushSwitch'))
        send(c, { data: robotListFrame(), sessionId: randomUUID(), type: 'RobotList', deviceId: c.currentDeviceId })
      if (turnedOn('RobotSituationPushSwitch'))
        send(c, { data: situationFrame(), sessionId: randomUUID(), type: 'RobotSituation', deviceId: c.currentDeviceId })
      if (turnedOn('AlarmInfoPushSwitch'))
        send(c, { data: fleet.alarms.filter((a) => a.alarmStatus === 0).slice(0, 20), sessionId: randomUUID(), type: 'AlarmInfo', deviceId: c.currentDeviceId })
      if (turnedOn('RobotStatusPushSwitch')) {
        const r = fleet.byDeviceId(c.currentDeviceId)
        if (r) {
          const full = fleet.wsStatusOf(r)
          c.lastStatus.set(r.deviceId, full)
          send(c, { data: full, type: 'RobotStatus' })
        }
      }
      // 增量开关（AlarmInfoIncrementPushSwitch 等）开启不回初始化消息（文档语义）
    } else if (msg.type === 'DeviceChange' && typeof msg.data === 'number') {
      c.currentDeviceId = msg.data
      const r = fleet.byDeviceId(msg.data)
      if (r && on(c, 'RobotStatusPushSwitch')) {
        const full = fleet.wsStatusOf(r)
        c.lastStatus.set(r.deviceId, full)
        send(c, { data: full, type: 'RobotStatus' })
      }
    }
  })
  ws.on('close', () => conns.delete(c))
})

// RobotStatus 增量推送：「不是全量推，后台有变化才推」——对比上次快照只发差异字段
setInterval(() => {
  for (const c of conns) {
    if (!(on(c, 'RobotStatusPushSwitch'))) continue
    const r = fleet.byDeviceId(c.currentDeviceId)
    if (!r) continue
    const full = fleet.wsStatusOf(r)
    const last = c.lastStatus.get(r.deviceId) ?? {}
    const delta: Record<string, unknown> = { robotSn: r.robotSn }
    let changed = false
    for (const [k, v] of Object.entries(full))
      if (JSON.stringify(v) !== JSON.stringify(last[k])) {
        delta[k] = v
        changed = true
      }
    if (changed) {
      c.lastStatus.set(r.deviceId, full)
      send(c, { data: delta, type: 'RobotStatus' })
    }
  }
}, 1000)

fleet.onAlarm = (a) => {
  for (const c of conns)
    if (on(c, 'AlarmInfoPushSwitch') || on(c, 'AlarmInfoIncrementPushSwitch'))
      send(c, { data: [a], sessionId: randomUUID(), type: 'AlarmInfo', deviceId: a.deviceId })
}
fleet.onRunAlarm = (a) => {
  for (const c of conns)
    if (on(c, 'AlarmRunInfoPushSwitch'))
      send(c, { data: [a], sessionId: randomUUID(), type: 'AlarmRunInfo', deviceId: a.deviceId })
}
fleet.onCapture = (r, cap) => {
  for (const c of conns)
    if (on(c, 'PatrolCapturePushSwitch') || on(c, 'PatrolCaptureIncrementPushSwitch'))
      send(c, {
        data: [
          {
            actionUnitId: 43000 + Math.floor(Math.random() * 999),
            algorithmDetectionImage: cap.picUrl,
            beaconPointCode: cap.pointName,
            createTime: cap.captureTime,
            detectionType: 0,
            deviceCode: cap.deviceCode,
            deviceId: cap.deviceId,
            deviceName: r.robotName,
            eCode: 'campus',
            id: Math.floor(Math.random() * 1e7),
            lineCode: r.line.lineNo,
            patrolTime: cap.captureTime,
            picName: cap.captureName,
            picUrl: cap.picUrl,
            uuid: randomUUID(),
          },
        ],
        type: 'PatrolCaptureInfo',
      })
}

// 假 FLV 取流端点：仅验证「10 秒内点播、过期重取」的会话语义
wssVideo.on('connection', (ws) => {
  ws.send(Buffer.from([0x46, 0x4c, 0x56, 0x01])) // 'FLV\x01'
  const t = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(Buffer.alloc(64)), 500)
  ws.on('close', () => clearInterval(t))
})

app.server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? ''
  if (url.startsWith('/websocket/web/')) {
    wssPush.handleUpgrade(req, socket, head, (ws) => wssPush.emit('connection', ws, req))
  } else if (url.startsWith('/videostream/')) {
    const nonce = url.slice('/videostream/'.length).split('?')[0]
    const rec = videoNonces.get(nonce)
    if (!rec || rec.expiresAt < Date.now()) {
      socket.write('HTTP/1.1 410 Gone\r\n\r\n')
      socket.destroy()
      return
    }
    videoNonces.delete(nonce) // 一次性点播
    wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

await app.listen({ port: PORT, host: '127.0.0.1' })
log.info(`GoRobot 云仿真就绪 :${PORT} · 账户 ${ACCOUNT} · ${fleet.robots.length} 台 F2 · 地图 ${MAP.mapName} ${MAP.picWidth}×${MAP.picHeight}px`)
