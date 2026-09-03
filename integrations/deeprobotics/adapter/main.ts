// 云深处 robotserver → Plantbot 适配器（plant-12 · 绝影 X30）。
// 南向：完整复刻官方 SDK 的 client 面（TCP + 16B 帧 + XML；同步 1002/1004/1007
// 各 3s 超时；1003 异步终态回调 + 我方自加任务级超时兜底——官方 SDK 此处会永久
// 泄漏，见 vendors 文档 §5.4）。北向：Plantbot 集成 API。
// 协议没有的能力如实上报「failed: unsupported」——announce/ptz/pause 都不存在于
// robotserver 协议；abort 映射 1004；dock 映射「导航去充电桩」（桩位是集成方配置）。

import net from 'node:net'
import { makeLog } from '../../shared/log.js'
import { PlantbotClient, type PlantbotOrder } from '../../shared/plantbot.js'
import { waitForSite, streamsToFactsheet, reportFault, pumpOrders, pickProfile, customProfileFromEnv, worldTransformFromEnv, makeBackoff, type VendorProfile } from '../../shared/bridge.js'
import {
  FrameParser, encodeFrame, TYPE, ERROR_STATUS,
  buildRealtimeReq, buildCancelReq, buildQueryReq, buildNavTaskReq, defaultNavPoint,
  parseRealtimeResp, parseCancelResp, parseQueryResp, parseNavTaskResp,
  type NavPoint, type RealtimeStatus,
} from '../protocol.js'

const log = makeLog('deepro-adp')

const DR_HOST = process.env.DR_HOST ?? '127.0.0.1'
const DR_PORT = Number(process.env.DR_PORT ?? 30000)
const STREAM_BASE = (process.env.STREAM_BASE ?? '/media').replace(/\/$/, '')
// One X30 adapter per site — DR_PROFILE selects identity + channels + key + dock.
// dock（充电桩，世界系）由集成方标定，必须与该实例 sim 的 DR_SIM_HOME_* 同点。
const DR_PROFILES: Record<string, VendorProfile> = {
  plant12: {
    serial: 'X30-JY-2024-0007',
    callsign: 'X30·HB',
    key: 'pbk_dev_plant12',
    dock: { x: -11, z: -6 },
    streams: [
      { id: 'x30hb-optical', name: 'Front optical', kind: 'camera', file: 'substation.mp4' },
      { id: 'x30hb-therm', name: 'Thermal', kind: 'thermal', file: 'thermal.mp4' },
    ],
  },
  campus: {
    serial: 'X30-JY-2024-0031',
    callsign: 'X30·CE',
    key: 'pbk_dev_campuseast',
    dock: { x: 0, z: -9 },
    streams: [
      { id: 'x30ce-optical', name: 'Front optical', kind: 'camera', file: 'night_walkway.mp4' },
      { id: 'x30ce-therm', name: 'Thermal', kind: 'thermal', file: 'thermal.mp4' },
    ],
  },
}
// managed-connector mode (PB_SERIAL set) overrides the built-in demo profiles;
// its dock comes from PB_DOCK_X/Z (required in the connector form)
const DR_PROFILE = customProfileFromEnv() ?? pickProfile(DR_PROFILES, process.env.DR_PROFILE, 'plant12')
const SERIAL = DR_PROFILE.serial
const DOCK = DR_PROFILE.dock ?? { x: 0, z: 0 }

const plantbot = new PlantbotClient({ key: process.env.PLANTBOT_KEY ?? DR_PROFILE.key, log })

// 机器人地图系（x 东, y 北, yaw 弧度）↔ 站点世界系（x 东, z 南）。
// 真机的 SLAM 原点未必是场站原点——PB_TF_*（CALIB 页解出）做相似变换精修。
const TF = worldTransformFromEnv()
const toWorld = (s: { PosX: number; PosY: number }) => TF.fwd(s.PosX, -s.PosY)
const toMap = (x: number, z: number) => {
  const p = TF.inv(x, z)
  return { x: p.x, y: -p.z }
}

// ---------- robotserver TCP client（mini SDK） ----------

type Pending = { type: number; resolve: (body: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

class RobotServerClient {
  private sock: net.Socket | null = null
  private parser = new FrameParser()
  private seq = 0
  private pending = new Map<number, Pending>()
  private navWaiters = new Map<number, { resolve: (r: { value: number; errorCode: number; errorStatus: number }) => void; timer: NodeJS.Timeout }>()
  private backoff = makeBackoff() // 1 s→30 s 指数退避，连上即重置
  connected = false
  onConnect?: () => void

  constructor() {
    this.dial()
  }

  private dial() {
    const sock = net.connect({ host: DR_HOST, port: DR_PORT })
    this.sock = sock
    const connTimer = setTimeout(() => sock.destroy(new Error('connect timeout')), 5000) // SDK 默认 5s
    sock.on('connect', () => {
      clearTimeout(connTimer)
      this.connected = true
      this.backoff.reset()
      log.info(`robot_server 已连接 tcp://${DR_HOST}:${DR_PORT}（无握手，直接可用）`)
      this.onConnect?.()
    })
    sock.on('data', (chunk: Buffer) => {
      for (const f of this.parser.push(chunk)) this.route(f.seq, f.type, f.body)
    })
    const drop = () => {
      clearTimeout(connTimer)
      this.connected = false
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('connection lost'))
      }
      this.pending.clear()
      for (const [, w] of this.navWaiters) {
        clearTimeout(w.timer)
        w.resolve({ value: 0, errorCode: 1, errorStatus: 41802 }) // 上位机连接断开
      }
      this.navWaiters.clear()
      const { delay, changed } = this.backoff.next()
      if (changed) log.warn(`robot_server 连接断开，${Math.round(delay / 1000)}s 后重连`)
      setTimeout(() => this.dial(), delay)
    }
    sock.on('close', drop)
    sock.on('error', () => sock.destroy())
  }

  private route(seq: number, type: number, body: string) {
    const p = this.pending.get(seq)
    if (p && p.type === type) {
      this.pending.delete(seq)
      clearTimeout(p.timer)
      p.resolve(body)
      return
    }
    if (type === TYPE.NAV_TASK) {
      const w = this.navWaiters.get(seq)
      if (w) {
        this.navWaiters.delete(seq)
        clearTimeout(w.timer)
        w.resolve(parseNavTaskResp(body))
        return
      }
    }
    log.warn(`丢弃无主响应 seq=${seq} type=${type}`)
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff
    return this.seq
  }

  /** 同步类请求（1002/1004/1007）：3s 超时（SDK 默认 requestTimeout） */
  private request(type: number, xml: string, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.sock) return reject(new Error('not connected'))
      const seq = this.nextSeq()
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`type ${type} timeout`))
      }, timeoutMs)
      this.pending.set(seq, { type, resolve, reject, timer })
      this.sock.write(encodeFrame(seq, xml))
    })
  }

  async realtime(): Promise<RealtimeStatus | null> {
    try {
      return parseRealtimeResp(await this.request(TYPE.REALTIME, buildRealtimeReq()))
    } catch {
      return null
    }
  }

  async query(): Promise<{ value: number; status: number } | null> {
    try {
      return parseQueryResp(await this.request(TYPE.QUERY, buildQueryReq()))
    } catch {
      return null
    }
  }

  async cancel(): Promise<boolean> {
    try {
      return parseCancelResp(await this.request(TYPE.CANCEL, buildCancelReq())).errorCode === 0
    } catch {
      return false
    }
  }

  /** 1003：立即返回 Promise，终态帧（或超时兜底）时结算 */
  startNavTask(points: NavPoint[], taskTimeoutMs: number): Promise<{ value: number; errorCode: number; errorStatus: number }> {
    return new Promise((resolve) => {
      if (!this.connected || !this.sock) return resolve({ value: 0, errorCode: 1, errorStatus: 41746 })
      const seq = this.nextSeq()
      const timer = setTimeout(() => {
        this.navWaiters.delete(seq)
        log.warn(`导航任务 seq=${seq} 超时兜底（官方 SDK 无此保护）`)
        resolve({ value: 0, errorCode: 1, errorStatus: 0 })
      }, taskTimeoutMs)
      this.navWaiters.set(seq, { resolve, timer })
      this.sock.write(encodeFrame(seq, buildNavTaskReq(points)))
    })
  }
}

// ---------- 平台桥 ----------

const rs = new RobotServerClient()
let waypoints: { id: string; x: number; z: number }[] = []
let lastLocation = 0
let sdkTaskActive = false // 我们下发的任务在跑（区别于机器人本体排程任务）

const statusText = (code: number) => ERROR_STATUS[code] ?? `code ${code}`

async function ensureIdle(): Promise<void> {
  // 下发前若导航栈被占（本体排程任务/上一单）→ 1004 取消（真实 SDK 使用姿势：
  // 41793「当前正在执行任务」的标准处理就是先 cancel）
  const q = await rs.query()
  if (q?.status === 1) {
    log.info('导航栈占用中 → 先 1004 取消（本体排程任务让位平台派单）')
    await rs.cancel()
    await new Promise((r) => setTimeout(r, 400))
  }
}

async function runNav(points: NavPoint[], label: string): Promise<{ ok: boolean; note: string }> {
  await ensureIdle()
  sdkTaskActive = true
  const timeout = 30_000 + points.length * 90_000
  const res = await rs.startNavTask(points, timeout)
  sdkTaskActive = false
  if (res.errorCode === 0) return { ok: true, note: `${label} · ${statusText(res.errorStatus)}` }
  if (res.errorCode === 2) return { ok: false, note: `cancelled · ${statusText(res.errorStatus)}` }
  // 失败终态 → 同时作为本体故障事件上报
  reportFault(plantbot, SERIAL, `navigation task failed · ErrorStatus ${res.errorStatus} ${statusText(res.errorStatus)}`)
  return { ok: false, note: statusText(res.errorStatus) }
}

async function execOrder(order: PlantbotOrder) {
  switch (order.kind) {
    case 'goto': {
      const { x, z, dock } = order.payload
      const tx = dock ? DOCK.x : x
      const tz = dock ? DOCK.z : z
      if (typeof tx !== 'number' || typeof tz !== 'number') return void plantbot.orderStatus(order.id, 'failed', 'x,z required')
      const m = toMap(tx, tz)
      const r = await runNav([defaultNavPoint(1, m.x, m.y)], dock ? 'Return-to-pile (X30 self-charges on dock)' : 'Point goal reached')
      await plantbot.orderStatus(order.id, r.ok ? 'done' : 'failed', r.note)
      return
    }
    case 'mission': {
      const steps = order.payload.steps ?? []
      const pts: NavPoint[] = []
      for (const [i, s] of steps.entries()) {
        const wp = waypoints.find((w) => w.id === s.waypointId)
        if (!wp) continue
        const m = toMap(wp.x, wp.z)
        pts.push(defaultNavPoint(i + 1, m.x, m.y))
      }
      if (!pts.length) return void plantbot.orderStatus(order.id, 'failed', 'no resolvable waypoints')
      // robotserver 的 1003 原生就是多点任务 —— 平台 mission 一单一任务，最优雅的映射
      log.info(`任务「${order.payload.name}」→ 单次 1003 · ${pts.length} 点`)
      const r = await runNav(pts, `${pts.length} waypoints inspected`)
      await plantbot.orderStatus(order.id, r.ok ? 'done' : 'failed', r.note)
      return
    }
    case 'abort': {
      const ok = await rs.cancel()
      await plantbot.orderStatus(order.id, ok ? 'done' : 'failed', ok ? '1004 cancelled' : 'cancel rejected')
      return
    }
    case 'pause':
    case 'resume':
      // robotserver 协议没有暂停/恢复 —— 能力矩阵如实上报
      await plantbot.orderStatus(order.id, 'failed', 'robotserver protocol has no pause/resume (Type 1002/1003/1004/1007 only)')
      return
    case 'announce':
    case 'ptz':
      await plantbot.orderStatus(order.id, 'failed', `${order.kind} unsupported by robotserver protocol`)
      return
  }
}

async function main() {
  // 等第一帧 1002 成功再注册（拿真实位姿作 home）
  let first: RealtimeStatus | null = null
  for (;;) {
    first = await rs.realtime()
    if (first) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const site = await waitForSite(plantbot)
  waypoints = site.waypoints.map((w) => ({ id: w.id, x: w.x, z: w.z }))

  await plantbot.registerUntilUp({
    serial: SERIAL,
    model: 'Jueying X30',
    vendor: 'DeepRobotics 云深处',
    callsign: DR_PROFILE.callsign,
    family: 'quadruped',
    level: 'dispatchable',
    protocol: 'robotserver_sdk wire (TCP EB90 + PatrolDevice XML)',
    home: toWorld(first),
    streams: streamsToFactsheet(DR_PROFILE.streams, STREAM_BASE),
  })
  log.info(`${DR_PROFILE.callsign}（${SERIAL}）已注册 · robotserver 无 payload 读数面`)

  // 1 Hz：1002 轮询 → state（robotserver 无推送，轮询即官方姿势）
  setInterval(async () => {
    const s = await rs.realtime()
    if (!s) return // 连接断开 → 心跳停 → 平台 20s 判 OFFLINE
    const pos = toWorld(s)
    const mode =
      s.ChargeState === 1 ? 'charging'
      : s.MotionState === 1 ? (sdkTaskActive ? 'executing' : 'navigating')
      : 'idle'
    const rep = await plantbot.state(SERIAL, {
      x: +pos.x.toFixed(2),
      z: +pos.z.toFixed(2),
      heading: +s.Yaw.toFixed(3),
      speed: s.Speed,
      battery: s.Electricity,
      mode,
      errors: s.Location === 1 ? ['LOCATION_LOST'] : undefined,
    })
    // 定位丢失沿触发 → 本体故障事件（协议无事件面，从状态位导出）
    if (s.Location === 1 && lastLocation === 0) {
      reportFault(plantbot, SERIAL, 'localization lost (Location=1) · laser does not match environment, manual position init required')
      log.warn('上报定位丢失故障事件')
    }
    lastLocation = s.Location
    // 运动类订单由 SDK 泵串行；抢占 = 1004 取消在飞 1003（其 startNavTask 收到取消终态帧
    // 后即结算 failed，泵随后发新单）。串行后 runNav 内的 ensureIdle 只会在「机器人本体
    // 排程任务占用导航栈」时取消，不会误取消我方刚发的任务（那时还没发出）。
    await pumpOrders(plantbot, SERIAL, rep, execOrder, { preempt: () => void rs.cancel(), log })
  }, 1000)
}

void main()
