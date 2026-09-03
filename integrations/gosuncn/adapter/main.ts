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
import { waitForSite, streamsToFactsheet, reportFault, pumpOrders, runWaypointMission, customProfileFromEnv, makeBackoff, type MissionRun } from '../../shared/bridge.js'

const log = makeLog('gosuncn-adp')

const GOSUNCN_BASE = (process.env.GOSUNCN_BASE ?? 'http://127.0.0.1:9101').replace(/\/$/, '')
const GOSUNCN_USER = process.env.GOSUNCN_USER ?? 'campus01'
const GOSUNCN_PASS = process.env.GOSUNCN_PASS ?? 'gorobot@2025'
const STREAM_BASE = (process.env.STREAM_BASE ?? '/media').replace(/\/$/, '')
// 单站多机：一个 adapter 驱动 campus 全部 F2（与 spot/deeprobotics 的
// 「单机多站 profile」相反），场站 key 只有一个兜底
const SITE_KEY = process.env.PLANTBOT_KEY ?? 'pbk_dev_campuseast'

const plantbot = new PlantbotClient({ key: SITE_KEY, log })

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
  /** the motion order currently in flight (goto or mission) — the pump's
   *  preempt hook and the operator `abort` set its `aborted`; navAndWait watches
   *  it. One robot body, one motion at a time (enforced by the SDK pump). */
  active?: { aborted: boolean }
}

const CUSTOM = customProfileFromEnv()
const UNITS: Unit[] = CUSTOM
  ? [
      // managed-connector mode: one connector drives ONE F2 — the vendor SN
      // (PB_GS_SN) maps the GoRobot cloud robot to this Plantbot identity
      {
        sn: process.env.PB_GS_SN ?? CUSTOM.serial,
        serial: CUSTOM.serial,
        callsign: CUSTOM.callsign,
        level: 'dispatchable',
        streams: CUSTOM.streams as Unit['streams'],
        evidenceStream: CUSTOM.streams[0]?.id ?? '',
      },
    ]
  : [
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

interface Waypoint {
  id: string
  x: number
  z: number
}
let waypoints: Waypoint[] = []

/** 导航前置：切手动模式（carmode=1）。厂商语义——导航/临时路线类接口需手动模式，
 *  且手动模式下机器人到点后**驻留**（taskType→standBy），不像自动模式那样到点即恢复
 *  自主巡逻（那会让「到点」窗口一闪而过、平台采不到）。只在当前不是手动时切，避免刷指令。
 *  changeControl 回 ResultWrapper（ret=1 成功），非 {successful} 三元组。 */
async function ensureManual(u: Unit): Promise<void> {
  if (u.status?.workModel === 1) return
  const res = await action<any>('/robotservice/qpid/changeControl.action', { deviceId: u.deviceId, carmode: 1 }, 'POST')
  if (res?.ret === 1) {
    log.info(`${u.callsign} → 手动模式（导航前置，到点后驻留）`)
    if (u.status) u.status.workModel = 1
  } else {
    log.warn(`${u.callsign} changeControl 切手动失败: ${res?.msg}`)
  }
}

const ARRIVE_PX = 10 // 到点阈值 ≈0.5 m（20 px/m）；e2e assertArrives 断言世界系 < 0.8 m

async function navAndWait(u: Unit, x: number, z: number, timeoutMs = 90_000): Promise<boolean> {
  const px = worldToPx(x, z)
  await ensureManual(u)
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
  // 自采样 250–300 ms 轮询 findRobotStatus（不靠 1 Hz 的 u.status——0.85 m/s 穿 0.5 m 窗
  // 仅 ~0.6 s，1 Hz 极易漏采）。到点判定 = 「最近逼近锁存」：记录到目标最小像素距，
  // 一旦落入阈值即成功；辅以厂商信号（手动 standBy 且已停在目标附近）。
  const t0 = Date.now()
  let minDist = Infinity
  for (;;) {
    await new Promise((r) => setTimeout(r, 280))
    if (u.active?.aborted) return false
    if (Date.now() - t0 > timeoutMs) {
      log.warn(`${u.callsign} 导航超时（最近逼近 ${Number.isFinite(minDist) ? minDist.toFixed(0) : '?'} px）`)
      return false
    }
    const s = (await action<any>('/robotservice/device/findRobotStatus.action', { deviceId: u.deviceId }))?.data
    if (!s) continue
    u.status = s // 让 1 Hz mode 映射拿到最新（含 workModel/speed）
    const d = Math.hypot(Number(s.xPosition) - px.X, Number(s.yPosition) - px.Y)
    if (Number.isFinite(d)) minDist = Math.min(minDist, d)
    if (minDist <= ARRIVE_PX) return true
    if (s.workModel === 1 && s.taskType === 'standBy' && Number(s.speed) < 0.05 && d <= ARRIVE_PX * 2) return true
  }
}

/** 返回 runWaypointMission 的 Promise（不再 fire-and-forget）——SDK 订单泵靠它
 *  纳入运动类串行/抢占（否则 exec 立即返回，泵会以为任务瞬时完成、放行下一单）。 */
function runMission(u: Unit, order: PlantbotOrder): Promise<void> {
  const run: MissionRun = { orderId: order.id, missionId: order.payload.missionId, aborted: false, paused: false }
  u.mission = run
  u.active = run // mission run 即当前在飞运动控制
  log.info(`${u.callsign} 开始任务「${order.payload.name}」· ${order.payload.steps?.length ?? 0} 步`)
  return runWaypointMission({
    pb: plantbot,
    order,
    run,
    waypoints,
    // 点位动作以动作时长驻留（抓拍/热扫由机器人本体完成）——runner 统一处理
    navTo: async (x, z) => ({ ok: await navAndWait(u, x, z) }),
    doneNote: (n) => `${n} waypoints inspected · captures uploaded`,
    onSettled: () => {
      u.mission = undefined
      if (u.active === run) u.active = undefined
    },
  })
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
      // 抢占进行中的运动由 SDK 泵的 preempt 钩子承担（串行后此处不会有并发在飞任务）
      const ctl = { aborted: false }
      u.active = ctl
      try {
        const ok = await navAndWait(u, x, z, 120_000)
        await plantbot.orderStatus(
          order.id,
          ok ? 'done' : 'failed',
          ok ? 'Arrived · 360° capture complete' : ctl.aborted ? 'preempted by newer order' : 'navigation stalled',
        )
      } finally {
        if (u.active === ctl) u.active = undefined
      }
      return
    }
    case 'mission':
      return runMission(u, order)
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
      if (u.active) u.active.aborted = true // 中止在飞运动（goto 或 mission）
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
  const site = await waitForSite(plantbot)
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
      streams: streamsToFactsheet(u.streams, STREAM_BASE),
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
      // 我们把机器人钉在手动模式跑派单（到点驻留），故 workModel===1 不再等于 teleop。
      // 语义化：在飞订单 → 动=navigating/停=executing（点位抓拍）；否则手动 standBy /
      // 暂停 → idle；自动巡逻 → 动=navigating/停=executing（巡逻点位驻留）。
      const inFlight = !!u.active
      const moving = Number(s.speed) > 0.05
      const charging = s.chargeConnectMode === 1 || s.ifChargeTask === 1
      const mode =
        charging ? 'charging'
        : inFlight ? (moving ? 'navigating' : 'executing')
        : s.isPatrolStop === 1 ? 'idle'
        : s.workModel === 1 && s.taskType === 'standBy' ? 'idle'
        : moving ? 'navigating'
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
      if (u.level === 'dispatchable')
        await pumpOrders(plantbot, u.serial, rep, (o) => execOrder(u, o), {
          preempt: () => {
            if (u.active) u.active.aborted = true // 抢占：取消在飞运动，泵等其结束再发新单
          },
          log,
        })
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

const wsBackoff = makeBackoff() // 1 s→30 s 指数退避，连上即重置

function connectWs() {
  const url = `${GOSUNCN_BASE.replace(/^http/, 'ws')}/websocket/web/${userId}?remark=plantbot-adapter&lang=zh-cn`
  const ws = new WebSocket(url)
  ws.on('open', () => {
    wsBackoff.reset()
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
        // 真云 AlarmInfo 样本只有 lat/long，无激光 px x/y；仅当 x/y 为有限数才带坐标，
        // 否则省略（平台回落到机器人当前位置），不要下发 NaN/null。
        const ax = Number(a.x)
        const ay = Number(a.y)
        const pos = Number.isFinite(ax) && Number.isFinite(ay) ? pxToWorld(ax, ay) : undefined
        await plantbot.event({
          type,
          robotSerial: u.serial,
          detail: `${a.alarmName}${a.alarmValue && a.alarmValue !== '0.0' ? ` · 检测值 ${a.alarmValue}` : ''} · GoRobot #${a.id}`,
          severity: a.alarmLevel === 1 ? 'high' : undefined,
          ...(pos ? { x: +pos.x.toFixed(2), z: +pos.z.toFixed(2) } : {}),
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
        reportFault(plantbot, u.serial, `${a.code} ${a.name} · ${String(a.describe ?? '').split('。')[0]}`)
        log.info(`本体故障上报 ${a.code} ${a.name}`)
      }
    }
    // PatrolCaptureInfo：点位抓拍流仅记录（平台侧任务进度由 mission 引擎自理）
  })
  ws.on('close', () => {
    const { delay, changed } = wsBackoff.next()
    if (changed) log.warn(`GoRobot WS 断开，${Math.round(delay / 1000)}s 后重连`)
    setTimeout(connectWs, delay)
  })
  ws.on('error', () => ws.close())
}

/** 事件证据：厂商 picUrl 在其内网不可达 → 用平台的证据抓帧服务从已登记帧源出图 */
function snapshotFor(u: Unit): Promise<string | undefined> {
  return plantbot.snapshot(u.evidenceStream)
}

void main()
