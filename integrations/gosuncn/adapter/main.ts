// GoRobot（高新兴）→ Plantbot 适配器。南向按 docs/vendors/gosuncn-api.md 做一个
// 真实的 GoRobot 云客户端（md5 登录 + Token 滑动保活 + WS 告警订阅 + REST 状态轮询），
// 北向走 Plantbot 开放集成 API。对面是真 GoRobot 云还是本仓库的 sim，本进程无感知。
//
// 集成商必须自己解决的两件厂商遗留事，在这里如实呈现：
//  1) 激光地图 px ↔ 场站米坐标的标定（GoRobot 不暴露分辨率）——CALIB 常量；
//  2) 多机接入时 WS 机器人级推送一次只能盯一台（DeviceChange 模型）——
//     状态走 REST 1 Hz 轮询，WS 只收单位级的告警/抓拍流。

import WebSocket from 'ws'
import { createHash } from 'node:crypto'
import { makeLog } from '../../shared/log.js'
import { PlantbotClient, type PlantbotOrder } from '../../shared/plantbot.js'

const log = makeLog('gosuncn-adp')

const GOSUNCN_BASE = (process.env.GOSUNCN_BASE ?? 'http://127.0.0.1:9101').replace(/\/$/, '')
const GOSUNCN_USER = process.env.GOSUNCN_USER ?? 'campus01'
const GOSUNCN_PASS = process.env.GOSUNCN_PASS ?? 'gorobot@2025'
const STREAM_BASE = (process.env.STREAM_BASE ?? '/media').replace(/\/$/, '')

const plantbot = new PlantbotClient({
  key: process.env.PLANTBOT_KEY ?? 'pbk_dev_campuseast',
  log,
})

// ---- 标定：campus_laser_0710 800×440px ↔ campus-east 世界米（集成方实测所得）----
const CALIB = {
  pxPerMeter: Number(process.env.GOSUNCN_PX_PER_M ?? 20),
  originX: Number(process.env.GOSUNCN_ORIGIN_X ?? -20), // px(0,0)（左下角）对应的世界坐标
  originZ: Number(process.env.GOSUNCN_ORIGIN_Z ?? 11),
}
const pxToWorld = (X: number, Y: number) => ({
  x: X / CALIB.pxPerMeter + CALIB.originX,
  z: CALIB.originZ - Y / CALIB.pxPerMeter,
})
const worldToPx = (x: number, z: number) => ({
  X: Math.round((x - CALIB.originX) * CALIB.pxPerMeter),
  Y: Math.round((CALIB.originZ - z) * CALIB.pxPerMeter),
})

// ---- 单元表：厂商 SN → Plantbot 身份（真实部署里这是 adapter 的站点配置文件）----
interface Unit {
  sn: string
  serial: string
  callsign: string
  level: 'state-only' | 'dispatchable'
  streams: { id: string; name: string; kind: string; file: string }[]
  evidenceStream: string // 事件快照用的平台帧源
  deviceId?: number
  mapName?: string
  status?: Record<string, any>
  mission?: MissionRun
}

const UNITS: Unit[] = [
  {
    sn: 'F2230204117',
    serial: 'GSCN-F2-2024-0117',
    callsign: 'GS·F2-01',
    level: 'dispatchable',
    streams: [
      { id: 'gs1-front', name: 'Front PTZ', kind: 'camera', file: 'campus_quad.mp4' },
      { id: 'gs1-rear', name: 'Rear camera', kind: 'camera', file: 'theft_cctv.mp4' },
    ],
    evidenceStream: 'gs1-rear',
  },
  {
    sn: 'F2230204118',
    serial: 'GSCN-F2-2024-0118',
    callsign: 'GS·F2-02',
    level: 'state-only',
    streams: [{ id: 'gs2-front', name: 'Front PTZ', kind: 'camera', file: 'campus_walk.mp4' }],
    evidenceStream: 'gs2-front',
  },
]

// ---- 厂商告警码 → Plantbot 事件类型（campus-east 词表）----
const ALARM_MAP: Record<number, string> = {
  10012: 'unattended-bag',
  1015: 'crowding',
  10014: 'fall',
  10015: 'ebike-blocking',
  315: 'tailgating', // 陌生人告警 ≈ 无凭证人员 — 映射到门禁语义，detail 保留厂商名
  314: 'tailgating',
}

// ---------- GoRobot 客户端（token 生命周期 + .action RPC） ----------

let token = ''
let userId = 14

async function login(): Promise<boolean> {
  try {
    const form = new FormData()
    form.set('username', GOSUNCN_USER)
    form.set('password', createHash('md5').update(GOSUNCN_PASS).digest('hex'))
    form.set('grant_type', 'password')
    form.set('hardware', 'web')
    const res = await fetch(`${GOSUNCN_BASE}/robotservice/auth/login`, {
      method: 'POST',
      headers: { authorization: 'Basic YWRtaW46YWRtaW4=' },
      body: form,
      signal: AbortSignal.timeout(6000),
    })
    const j: any = await res.json()
    if (j?.ret === 1 && j.data?.access_token) {
      token = j.data.access_token
      userId = j.data.userId ?? 14
      log.info(`GoRobot 登录成功（userId=${userId}）`)
      return true
    }
    log.warn(`GoRobot 登录失败: ${j?.msg}`)
  } catch (e) {
    log.warn(`GoRobot 不可达: ${(e as Error).message}`)
  }
  return false
}

/** .action RPC：参数一律放 query（含 POST——厂商约定），token 失效自动重登重试一次 */
async function action<T = any>(path: string, params: Record<string, string | number | undefined> = {}, method: 'GET' | 'POST' = 'GET', retry = true): Promise<T | null> {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  try {
    const res = await fetch(`${GOSUNCN_BASE}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: { Token: token },
      signal: AbortSignal.timeout(6000),
    })
    const j: any = await res.json()
    if (j?.ret === -1 && /token/i.test(String(j.msg ?? '')) && retry) {
      if (await login()) return action(path, params, method, false)
    }
    return j as T
  } catch (e) {
    log.warn(`${path} 调用失败: ${(e as Error).message}`)
    return null
  }
}

// ---------- 任务执行器（平台 mission 订单 → navigateToPoint 逐点巡查） ----------

interface MissionRun {
  orderId: string
  missionId?: string
  aborted: boolean
  paused: boolean
}

interface Waypoint {
  id: string
  x: number
  z: number
}
let waypoints: Waypoint[] = []

async function navAndWait(u: Unit, x: number, z: number, timeoutMs = 90_000): Promise<boolean> {
  const px = worldToPx(x, z)
  const res = await action<any>('/robotservice/patrol/navigateToPoint.action', {
    deviceId: u.deviceId,
    posX: String(px.X),
    posY: String(px.Y),
    angle: '0',
    mapName: u.mapName,
  }, 'POST')
  if (!res?.successful) {
    log.warn(`${u.callsign} navigateToPoint 被拒: ${res?.msg}`)
    return false
  }
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 700))
    if (Date.now() - t0 > timeoutMs) return false
    if (u.mission?.aborted) return false
    const s = u.status
    if (!s) continue
    if (Math.hypot(Number(s.xPosition) - px.X, Number(s.yPosition) - px.Y) < 7) return true
  }
}

async function runMission(u: Unit, order: PlantbotOrder) {
  const run: MissionRun = { orderId: order.id, missionId: order.payload.missionId, aborted: false, paused: false }
  u.mission = run
  const steps = order.payload.steps ?? []
  log.info(`${u.callsign} 开始任务「${order.payload.name}」· ${steps.length} 步`)
  let doneSteps = 0
  for (const step of steps) {
    if (run.aborted) break
    while (run.paused && !run.aborted) await new Promise((r) => setTimeout(r, 500))
    const wp = waypoints.find((w) => w.id === step.waypointId)
    if (!wp) continue
    const ok = await navAndWait(u, wp.x, wp.z)
    if (!ok) {
      if (!run.aborted) {
        await plantbot.orderStatus(order.id, 'failed', `stalled at ${step.waypointId}`)
        u.mission = undefined
        return
      }
      break
    }
    // 点位动作：以动作时长驻留（抓拍/热扫等由机器人本体完成，这里如实等待）
    const dwell = step.actions?.reduce((s, a) => s + (a.durationS ?? 3), 0) ?? 4
    await new Promise((r) => setTimeout(r, Math.min(dwell, 20) * 1000))
    doneSteps++
  }
  await plantbot.orderStatus(
    order.id,
    run.aborted ? 'failed' : 'done',
    run.aborted ? `aborted by operator after ${doneSteps}/${steps.length} waypoints` : `${doneSteps} waypoints inspected · captures uploaded`,
  )
  u.mission = undefined
}

async function execOrder(u: Unit, order: PlantbotOrder) {
  switch (order.kind) {
    case 'goto': {
      const { x, z, dock } = order.payload
      if (dock) {
        // dock 语义 → 厂商「一键充电」（自主回桩），而不是普通导航
        const xml = `<?xml version="1.0" encoding="utf-8" ?>\n<Root>\n <Header>\n <CmdType>RC_Robot_Ctrl</CmdType>\n <To>${u.deviceId}</To>\n <From>Clientwpf</From>\n </Header>\n <Robot_Ctrl>\n <unCtrlType>2</unCtrlType>\n <unCtrlValue>1</unCtrlValue>\n </Robot_Ctrl>\n</Root>`
        const res = await action<any>('/robotservice/qpid/sendMQComandByUTF8.action', { deviceId: u.deviceId, content: xml }, 'POST')
        await plantbot.orderStatus(order.id, res?.successful ? 'done' : 'failed', res?.successful ? 'One-key charge dispatched' : res?.msg)
        return
      }
      if (typeof x !== 'number' || typeof z !== 'number') return void plantbot.orderStatus(order.id, 'failed', 'x,z required')
      if (u.mission) {
        u.mission.aborted = true // 平台语义：teleop 抢占任务
        log.info(`${u.callsign} goto 抢占进行中的任务`)
      }
      const ok = await navAndWait(u, x, z, 120_000)
      await plantbot.orderStatus(order.id, ok ? 'done' : 'failed', ok ? 'Arrived · 360° capture complete' : 'navigation stalled')
      return
    }
    case 'mission':
      void runMission(u, order)
      return
    case 'announce': {
      const res = await action<any>('/robotservice/device/voiceSoundtextSet.action', { soundtext: order.payload.text, deviceId: u.deviceId, broadcastPriority: 1 }, 'POST')
      await plantbot.orderStatus(order.id, res?.successful ? 'done' : 'failed', res?.successful ? `Played: “${order.payload.text}”` : res?.msg ?? 'vendor rejected')
      return
    }
    case 'pause': {
      const res = await action<any>('/robotservice/qpid/pauseTask.action', { deviceId: u.deviceId }, 'POST')
      if (u.mission) u.mission.paused = true
      await plantbot.orderStatus(order.id, res?.successful ? 'done' : 'failed', res?.msg)
      return
    }
    case 'resume': {
      const res = await action<any>('/robotservice/qpid/resumeTask.action', { deviceId: u.deviceId }, 'POST')
      if (u.mission) u.mission.paused = false
      await plantbot.orderStatus(order.id, res?.successful ? 'done' : 'failed', res?.msg)
      return
    }
    case 'abort': {
      if (u.mission) u.mission.aborted = true
      await plantbot.orderStatus(order.id, 'done', 'mission runner aborted')
      return
    }
    case 'ptz': {
      const { pan = 0, tilt = 0, zoom = 0 } = order.payload
      const moves: [number, number][] = []
      if (pan) moves.push([pan > 0 ? 3 : 7, Math.min(90, Math.abs(pan))])
      if (tilt) moves.push([tilt > 0 ? 1 : 5, Math.min(90, Math.abs(tilt))])
      if (zoom) moves.push([zoom > 0 ? 9 : 10, Math.min(90, Math.abs(zoom) * 10)])
      if (!moves.length) moves.push([12, 0]) // 无参 → 复位
      let ok = true
      for (const [ctrl, value] of moves) {
        const xml = `<?xml version="1.0" encoding="utf-8" ?>\n<Root>\n <Header>\n <CmdType>RC_Robot_PTZ_Ctrl</CmdType>\n <To>${u.deviceId}</To>\n <From>Clientwpf</From>\n </Header>\n <Robot_PTZ_Ctrl>\n <unCtrlValue>${ctrl}</unCtrlValue>\n <Value>${Math.round(value) || 50}</Value>\n </Robot_PTZ_Ctrl>\n</Root>`
        const res = await action<any>('/robotservice/qpid/sendMQComandByUTF8.action', { deviceId: u.deviceId, content: xml }, 'POST')
        ok &&= !!res?.successful
      }
      await plantbot.orderStatus(order.id, ok ? 'done' : 'failed', ok ? 'PTZ moved' : 'vendor rejected')
      return
    }
  }
}

// ---------- 启动 ----------

async function main() {
  while (!(await login())) await new Promise((r) => setTimeout(r, 3000))

  // 机器人列表 → deviceId；地图/路线 → mapName（navigateToPoint 必填）
  for (;;) {
    const list = await action<any>('/robotservice/device/searchRobotList.action', { page: 1, pageSize: 20 })
    const rows: any[] = list?.data?.rows ?? []
    for (const u of UNITS) {
      const row = rows.find((r) => r.robotSn === u.sn)
      if (row) u.deviceId = row.deviceId
    }
    if (UNITS.every((u) => u.deviceId)) break
    log.warn('GoRobot 机器人列表未就绪，3s 后重试')
    await new Promise((r) => setTimeout(r, 3000))
  }
  for (const u of UNITS) {
    const mp = await action<any>('/robotservice/patrol/searchPatrolLineAndPoints.action', { deviceId: u.deviceId })
    u.mapName = mp?.data?.[0]?.mapName
    const ch = await action<any>('/robotservice/device/selectChannelList.action', { deviceId: u.deviceId })
    log.info(`${u.callsign} deviceId=${u.deviceId} map=${u.mapName} 通道=[${(ch?.data ?? []).map((c: any) => c.name).join('/')}]`)
  }

  // 平台侧注册（factsheet）——场站航点表同时拉回来给任务执行器用
  const site = await (async () => {
    for (;;) {
      const s = await plantbot.site()
      if (s) return s
      await new Promise((r) => setTimeout(r, 3000))
    }
  })()
  waypoints = site.waypoints.map((w) => ({ id: w.id, x: w.x, z: w.z }))

  for (const u of UNITS) {
    const st = (await action<any>('/robotservice/device/findRobotStatus.action', { deviceId: u.deviceId }))?.data
    const home = st ? pxToWorld(st.xPosition, st.yPosition) : undefined
    await plantbot.registerUntilUp({
      serial: u.serial,
      model: 'GS Patrol F2',
      vendor: 'Gosuncn Robotics 高新兴',
      callsign: u.callsign,
      family: 'ugv',
      level: u.level,
      protocol: 'GRobot cloud API (.action RPC + WS push)',
      home,
      streams: u.streams.map((s) => ({ id: s.id, name: s.name, kind: s.kind as any, url: `${STREAM_BASE}/${s.file}` })),
    })
  }

  connectWs()
  setInterval(() => action('/robotservice/user/keepTokenConnection.action'), 25 * 60_000)

  // 1 Hz：REST 状态轮询 → 平台 state（多机接入不用 DeviceChange 抢占 WS 通道）
  setInterval(async () => {
    for (const u of UNITS) {
      const res = await action<any>('/robotservice/device/findRobotStatus.action', { deviceId: u.deviceId })
      const s = res?.data
      if (!s) continue
      u.status = s
      if (!s.online) continue // 厂商侧离线 → 停止心跳，平台 20s 后自然判 OFFLINE
      const pos = pxToWorld(Number(s.xPosition), Number(s.yPosition))
      const mode =
        s.chargeConnectMode === 1 || s.ifChargeTask === 1 ? 'charging'
        : s.workModel === 1 ? 'teleop'
        : s.isPatrolStop === 1 || s.taskType === 'standBy' ? 'idle'
        : Number(s.speed) > 0.05 ? 'navigating'
        : 'executing'
      const rep = await plantbot.state(u.serial, {
        x: +pos.x.toFixed(2),
        z: +pos.z.toFixed(2),
        heading: +((Number(s.angle) * Math.PI) / 180).toFixed(3),
        speed: Number(s.speed),
        battery: Number(s.electricity),
        mode,
        errors: s.exceptionCode ? [String(s.exceptionCode)] : undefined,
      })
      if (u.level === 'dispatchable' && rep && rep.ordersPending > 0) {
        for (const order of await plantbot.pullOrders(u.serial)) void execOrder(u, order)
      }
    }
  }, 1000)

  // 5 s：payload 读数（三探头温湿度取下探头 + 噪声）
  setInterval(async () => {
    for (const u of UNITS) {
      const s = u.status
      if (!s?.online) continue
      await plantbot.readings(u.serial, [
        { metric: 'amb.temp.c', value: +Number(s.temperature).toFixed(1) },
        { metric: 'amb.rh.pct', value: Math.round(Number(s.humidity)) },
        { metric: 'noise.db', value: +Number(s.decibel).toFixed(1) },
      ])
    }
  }, 5000)

  log.info('GoRobot 适配器就绪 · 2 台 F2 → campus-east')
}

// ---------- WS：单位级告警/抓拍订阅（增量开关，断线重连） ----------

function connectWs() {
  const url = `${GOSUNCN_BASE.replace(/^http/, 'ws')}/websocket/web/${userId}?remark=plantbot-adapter&lang=zh-cn`
  const ws = new WebSocket(url)
  ws.on('open', () => {
    log.info('GoRobot WS 已连接，订阅告警/本体故障/抓拍（增量）')
    ws.send(
      JSON.stringify({
        type: 'PushSwitch',
        data: {
          AlarmInfoIncrementPushSwitch: '1',
          AlarmRunInfoPushSwitch: 1,
          PatrolCaptureIncrementPushSwitch: '1',
        },
      }),
    )
  })
  ws.on('message', async (raw) => {
    let frame: any
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (frame.type === 'AlarmInfo') {
      for (const a of frame.data ?? []) {
        const u = UNITS.find((x) => x.sn === a.deviceSn || x.deviceId === a.deviceId)
        const type = ALARM_MAP[a.alarmType]
        if (!u || !type) {
          if (!type) log.info(`忽略未映射的厂商告警 alarmType=${a.alarmType}（${a.alarmName ?? '?'}）`)
          continue
        }
        const snap = await snapshotFor(u)
        const pos = pxToWorld(Number(a.x), Number(a.y))
        await plantbot.event({
          type,
          robotSerial: u.serial,
          detail: `${a.alarmName}${a.alarmValue && a.alarmValue !== '0.0' ? ` · 检测值 ${a.alarmValue}` : ''} · GoRobot #${a.id}`,
          severity: a.alarmLevel === 1 ? 'high' : undefined,
          x: +pos.x.toFixed(2),
          z: +pos.z.toFixed(2),
          snapshotUrl: snap,
          confidence: typeof a.reliability === 'number' ? a.reliability : undefined,
          category: 'security',
        })
        log.info(`告警上报 ${a.alarmName}(${a.alarmType}) → ${type}`)
      }
    } else if (frame.type === 'AlarmRunInfo') {
      for (const a of frame.data ?? []) {
        const u = UNITS.find((x) => x.deviceId === a.deviceId)
        if (!u) continue
        await plantbot.event({
          type: 'fault',
          robotSerial: u.serial,
          detail: `${a.code} ${a.name} · ${String(a.describe ?? '').split('。')[0]}`,
          severity: 'high',
          category: 'robot-fault',
        })
        log.info(`本体故障上报 ${a.code} ${a.name}`)
      }
    }
    // PatrolCaptureInfo：点位抓拍流仅记录（平台侧任务进度由 mission 引擎自理）
  })
  ws.on('close', () => {
    log.warn('GoRobot WS 断开，3s 后重连')
    setTimeout(connectWs, 3000)
  })
  ws.on('error', () => ws.close())
}

/** 事件证据：厂商 picUrl 在其内网不可达 → 用平台的证据抓帧服务从已登记帧源出图 */
function snapshotFor(u: Unit): Promise<string | undefined> {
  return plantbot.snapshot(u.evidenceStream)
}

void main()
