// Spot → Plantbot 适配器（plant-07）。一个 TypeScript 版 mini bosdyn-client：
// 完整会话舞蹈（GetRobotId 探活 → GetAuthToken → TimeSync 到 STATUS_OK → AcquireLease
// + 2s RetainLease → estop 注册 + timeout/3 challenge/response → PowerCommand ON_MOTORS）
// 三个 keep-alive 常驻；任何一环断裂 → 停止心跳（平台判 OFFLINE）→ 整套舞蹈重来。
// 运动走 GraphNavService.NavigateToAnchor（seed 帧 ≡ 站点世界系，y = -z）。
// lease/estop/timesync 是 adapter 内部细节，不上浮到平台 API。

import grpc from '@grpc/grpc-js'
import { readFileSync } from 'node:fs'
import { api, graphNav, spotCam, ts, estopResponse, quatToYaw } from '../loader.js'
import { SpotCamera } from './camera.js'
import { makeLog } from '../../shared/log.js'
import { PlantbotClient, pumpControl, type ControlFrame, type PlantbotOrder } from '../../shared/plantbot.js'
import {
  waitForSite, streamsToFactsheet, reportFault, pumpOrders, runWaypointMission,
  pickProfile, customProfileFromEnv, worldTransformFromEnv, makeBackoff, type VendorProfile, type MissionRun,
} from '../../shared/bridge.js'

const log = makeLog('spot-adp')

const HOST = `${process.env.SPOT_HOST ?? '127.0.0.1'}:${process.env.SPOT_PORT ?? 9103}`
const USER = process.env.SPOT_USER ?? 'admin'
const PASS = process.env.SPOT_PASS ?? 'spotdev2026'
const STREAM_BASE = (process.env.STREAM_BASE ?? '/media').replace(/\/$/, '')
const ESTOP_TIMEOUT_S = 9

// One Spot adapter per site — SPOT_PROFILE selects the identity + channel set +
// platform key, so the same code drives plant-07's Spot and campus's Spot.
const PROFILES: Record<string, VendorProfile> = {
  plant07: {
    serial: 'BD-91250107',
    callsign: 'SPOT·A',
    key: 'pbk_dev_plant07',
    streams: [
      { id: 'spot07-front', name: 'Fisheye front', kind: 'camera', file: 'switchgear.mp4' },
      { id: 'spot07-therm', name: 'Spot CAM IR', kind: 'thermal', file: 'thermal.mp4' },
    ],
  },
  campus: {
    serial: 'BD-91250203',
    callsign: 'SPOT·CE',
    key: 'pbk_dev_campuseast',
    streams: [
      { id: 'spotce-front', name: 'Fisheye front', kind: 'camera', file: 'campus_gate.mp4' },
      { id: 'spotce-therm', name: 'Spot CAM IR', kind: 'thermal', file: 'night_walkway.mp4' },
    ],
  },
}
// managed-connector mode (PB_SERIAL set) overrides the built-in demo profiles
const PROFILE = customProfileFromEnv() ?? pickProfile(PROFILES, process.env.SPOT_PROFILE, 'plant07')
const SERIAL = PROFILE.serial

const plantbot = new PlantbotClient({ key: process.env.PLANTBOT_KEY ?? PROFILE.key, log })

// seed 帧（x 东 y 北）↔ 世界系（x 东 z 南）。真机的 GraphNav seed 原点未必是
// 场站原点——PB_TF_*（CALIB 页解出）做相似变换精修。
const TF = worldTransformFromEnv()
const toWorld = (p: { x?: number; y?: number }) => TF.fwd(p.x ?? 0, -(p.y ?? 0))
const toSeed = (x: number, z: number) => {
  const q = TF.inv(x, z)
  return { x: q.x, y: -q.z }
}

// Port 443 uses the official root CA and Directory authorities. Plaintext is
// reserved for explicitly configured simulator ports (SPOT_TLS=0 overrides).
const tls = process.env.SPOT_TLS === '1' || (process.env.SPOT_TLS !== '0' && HOST.endsWith(':443'))
const creds = tls ? grpc.credentials.createSsl(readFileSync(process.env.SPOT_CA_FILE || new URL('../protos/robot.pem', import.meta.url))) : grpc.credentials.createInsecure()
const definitions: Record<string, { service: any; name: string; authority?: string }> = {
  robotId: { service: api.RobotIdService, name: 'robot-id', authority: 'id.spot.robot' },
  auth: { service: api.AuthService, name: 'auth', authority: 'auth.spot.robot' },
  directory: { service: api.DirectoryService, name: 'directory', authority: 'api.spot.robot' },
  timeSync: { service: api.TimeSyncService, name: 'time-sync' },
  lease: { service: api.LeaseService, name: 'lease' },
  estop: { service: api.EstopService, name: 'estop' },
  power: { service: api.PowerService, name: 'power' },
  state: { service: api.RobotStateService, name: 'robot-state' },
  command: { service: api.RobotCommandService, name: 'robot-command' },
  image: { service: api.ImageService, name: 'image' },
  graphNav: { service: graphNav.GraphNavService, name: 'graph-nav-service' },
  ptz: { service: spotCam.PtzService, name: 'spot-cam-ptz' },
}
const mk = (service: any, authority?: string) => new service(HOST, creds, tls && authority ? { 'grpc.ssl_target_name_override': authority, 'grpc.default_authority': authority } : {})
const clients: Record<string, any> = Object.fromEntries(Object.entries(definitions).map(([key, d]) => [key, mk(d.service, d.authority)]))

// grpc callback → promise，统一 8s deadline
function call<T = any>(client: any, method: string, req: unknown, md?: grpc.Metadata, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](req, md ?? new grpc.Metadata(), { deadline: Date.now() + timeoutMs }, (err: Error | null, res: T) =>
      err ? reject(err) : resolve(res),
    )
  })
}

// ---------- 会话（session dance）----------

const session = {
  token: '',
  clockId: '',
  skewMs: 0,
  lease: null as null | { resource: string; epoch: string; sequence: number[]; client_names: string[] },
  estopEndpoint: null as null | { unique_id: string; name: string; role: string },
  challenge: null as null | string,
  ready: false,
  timers: [] as NodeJS.Timeout[],
}

const md = () => {
  const m = new grpc.Metadata()
  if (session.token) m.set('authorization', `Bearer ${session.token}`)
  return m
}
const header = () => ({ request_timestamp: ts(), client_name: 'plantbot-adapter' })
const robotNow = () => Date.now() + session.skewMs
const endTime = (ms: number) => ts(robotNow() + ms)

const danceBackoff = makeBackoff() // 1 s→30 s 指数退避，会话就绪即重置
/** 排程重新起舞：退避 + 只在档位变化时打日志（会话反复拆除时不刷屏） */
function scheduleDance(reason: string) {
  const { delay, changed } = danceBackoff.next()
  if (changed) log.warn(`Spot 会话重连（${reason}）→ ${Math.round(delay / 1000)}s 后重试`)
  setTimeout(() => void dance(), delay)
}

function teardown(reason: string) {
  if (!session.ready && !session.timers.length) return
  for (const t of session.timers) clearInterval(t)
  session.timers = []
  session.ready = false
  session.lease = null
  session.estopEndpoint = null
  session.challenge = null
  scheduleDance(reason)
}

async function dance(): Promise<void> {
  try {
    // 0) 探活（无需 token）
    const id = await call(clients.robotId, 'GetRobotId', { header: header() })
    log.info(`发现机器人 ${id.robot_id?.serial_number}（${id.robot_id?.species} · ${id.robot_id?.nickname}）`)

    // 1) 认证
    const auth = await call(clients.auth, 'GetAuthToken', { header: header(), username: USER, password: PASS })
    if (auth.status !== 1) throw new Error(`auth status ${auth.status}`)
    session.token = auth.token
    log.info('GetAuthToken OK（JWT 挂 authorization metadata）')

    // 2) 服务发现（authority 表——对 sim 单地址无实际路由作用，忠实走一遍）
    const dir = await call(clients.directory, 'ListServiceEntries', { header: header() }, md())
    log.info(`Directory ${dir.service_entries?.length ?? 0} 个 service`)
    if (tls) for (const [key, definition] of Object.entries(definitions)) {
      if (definition.authority) continue
      const entry = dir.service_entries?.find((e: any) => e.name === definition.name)
      if (entry?.authority) { clients[key].close(); clients[key] = mk(definition.service, entry.authority) }
      else if (key !== 'ptz') throw new Error(`Spot service unavailable: ${definition.name}`)
    }

    // 3) time-sync 轮到 STATUS_OK（skew 用于把 end_time 换算到机器人时钟）
    for (let i = 0; i < 20; i++) {
      const r = await call(clients.timeSync, 'TimeSyncUpdate', { header: header(), clock_identifier: session.clockId }, md())
      session.clockId = r.clock_identifier
      if (r.state?.status === 1) {
        const skew = r.state.best_estimate?.clock_skew
        session.skewMs = Number(skew?.seconds ?? 0) * 1000 + Math.round((skew?.nanos ?? 0) / 1e6)
        break
      }
      await new Promise((r2) => setTimeout(r2, 300))
    }
    if (!session.clockId) throw new Error('timesync failed')
    log.info(`time-sync OK · clock=${session.clockId} · skew=${session.skewMs}ms`)

    // 4) lease[body] + 2s RetainLease；撞上自己残留的租约 → TakeLease 强取（官方姿势）
    let acq = await call(clients.lease, 'AcquireLease', { header: header(), resource: 'body' }, md())
    if (acq.status === 2) {
      log.info(`lease 被占（owner=${acq.lease_owner?.client_name}）→ TakeLease 强取`)
      acq = await call(clients.lease, 'TakeLease', { header: header(), resource: 'body' }, md())
    }
    if (acq.status !== 1) throw new Error(`AcquireLease status ${acq.status}（owner=${acq.lease_owner?.client_name}）`)
    session.lease = acq.lease
    session.timers.push(
      setInterval(async () => {
        try {
          const r = await call(clients.lease, 'RetainLease', { header: header(), lease: session.lease }, md())
          if (r.lease_use_result?.status !== 1) teardown(`lease 保活被拒 status=${r.lease_use_result?.status}`)
        } catch (e) {
          teardown(`RetainLease: ${(e as Error).message}`)
        }
      }, 2000),
    )
    log.info(`lease[body] seq=[${session.lease!.sequence}] · RetainLease @2s`)

    // 5) estop：注册 endpoint + timeout/3 challenge/response（uint64 取反）
    const cfg = await call(clients.estop, 'GetEstopConfig', { header: header() }, md())
    const reg = await call(
      clients.estop,
      'RegisterEstopEndpoint',
      {
        header: header(),
        target_config_id: cfg.active_config?.unique_id,
        new_endpoint: { role: 'PDB_rooted', name: 'plantbot-adapter', timeout: { seconds: String(ESTOP_TIMEOUT_S), nanos: 0 } },
      },
      md(),
    )
    if (reg.status !== 1) throw new Error(`estop register status ${reg.status}`)
    session.estopEndpoint = reg.new_endpoint
    // 首次 check-in 无题可答 → 忽略 INCORRECT，取第一道 challenge；随即补一次
    // 有效应答（官方 keepalive 启动即 check-in），否则 stop_level 仍未放行、上电必被拒
    const first = await call(clients.estop, 'EstopCheckIn', { header: header(), endpoint: session.estopEndpoint, challenge: '0', response: '0', stop_level: 4 }, md())
    session.challenge = first.challenge
    const second = await call(
      clients.estop,
      'EstopCheckIn',
      { header: header(), endpoint: session.estopEndpoint, challenge: session.challenge, response: estopResponse(session.challenge!), stop_level: 4 },
      md(),
    )
    session.challenge = second.challenge
    session.timers.push(
      setInterval(async () => {
        try {
          const r = await call(
            clients.estop,
            'EstopCheckIn',
            { header: header(), endpoint: session.estopEndpoint, challenge: session.challenge, response: estopResponse(session.challenge!), stop_level: 4 },
            md(),
          )
          session.challenge = r.challenge
          if (r.status !== 1 && r.status !== 5) teardown(`estop check-in status=${r.status}`)
        } catch (e) {
          teardown(`EstopCheckIn: ${(e as Error).message}`)
        }
      }, (ESTOP_TIMEOUT_S / 3) * 1000),
    )
    log.info(`estop endpoint ${session.estopEndpoint!.unique_id} · check-in @${ESTOP_TIMEOUT_S / 3}s（放行 ESTOP_LEVEL_NONE）`)

    // 6) 上电：PowerCommand(ON_MOTORS) → feedback 轮询到 SUCCESS
    const pc = await call(clients.power, 'PowerCommand', { header: header(), lease: session.lease, request: 2 }, md())
    if (pc.status !== 1 && pc.status !== 2) throw new Error(`PowerCommand status ${pc.status}`)
    for (let i = 0; i < 20; i++) {
      const fb = await call(clients.power, 'PowerCommandFeedback', { header: header(), power_command_id: pc.power_command_id }, md())
      if (fb.status === 2) break
      await new Promise((r) => setTimeout(r, 300))
    }
    log.info('电机上电 SUCCESS —— 会话就绪，Spot 可接令')

    // 7) time-sync 维持 @60s
    session.timers.push(
      setInterval(() => {
        void call(clients.timeSync, 'TimeSyncUpdate', { header: header(), clock_identifier: session.clockId }, md()).catch((e) =>
          teardown(`TimeSyncUpdate: ${(e as Error).message}`),
        )
      }, 60_000),
    )

    session.ready = true
    danceBackoff.reset()
  } catch (e) {
    for (const t of session.timers) clearInterval(t)
    session.timers = []
    scheduleDance((e as Error).message)
  }
}

// ---------- 状态桥 ----------

let lastState: any = null
let lastFaultIds = new Set<number>()
let missionRun: MissionRun | null = null
// 当前在飞运动控制（goto 或 mission）——SDK 泵的 preempt 钩子与 operator abort 置其
// aborted，navigateTo 轮询时监听。一机一动，串行由泵保证。mission 时它就是 missionRun。
let activeMotion: { aborted: boolean } | null = null
let manualActive = false
let camera: SpotCamera | undefined
const cameraStreamId = process.env.SPOT_CAM_STREAM_ID ?? `${PROFILE.streams[0]?.id ?? SERIAL}-ptz`

async function controlCommand(mobility: unknown, timeoutMs = 500) {
  if (!session.ready) throw new Error('Spot session is not ready')
  const response = await call(clients.command, 'RobotCommand', { header: header(), lease: session.lease,
    clock_identifier: session.clockId, command: { synchronized_command: { mobility_command: mobility } } }, md(), timeoutMs)
  if (response.header?.error?.code !== 1 || response.status !== 1 || response.lease_use_result?.status !== 1) throw new Error(response.message || 'Spot rejected manual control')
}
async function stopDrive() {
  await controlCommand({ stand_request: {} })
  for (let i = 0; i < 8; i++) {
    const r = await call(clients.state, 'GetRobotState', { header: header() }, md(), 500)
    if (r.header?.error?.code !== 1) throw new Error('Spot stop telemetry unavailable')
    const v = r.robot_state?.kinematic_state?.velocity_of_body_in_odom
    if (v && Math.hypot(v.linear?.x ?? 0, v.linear?.y ?? 0) < 0.02 && Math.abs(v.angular?.z ?? 0) < 0.02) return
    await new Promise(r => setTimeout(r, 80))
  }
  throw new Error('Spot stop was not confirmed')
}
const manualController = {
  async start(frame: ControlFrame) {
    if (activeMotion) throw new Error('Spot has an active navigation order')
    if (frame.target === 'drive') await stopDrive()
    else { if (!camera || frame.channelId !== cameraStreamId) throw new Error('Spot CAM is not available'); await camera.stop() }
    manualActive = true
  },
  async apply(frame: ControlFrame, ttlMs: number) {
    if (frame.target === 'drive') await controlCommand({ se2_velocity_request: { se2_frame_name: 'flat_body',
      end_time: endTime(Math.floor(ttlMs)), velocity: { linear: { x: frame.axes.forward ?? 0, y: frame.axes.lateral ?? 0 }, angular: frame.axes.turn ?? 0 } } }, Math.min(500, Math.floor(ttlMs)))
    else { if (!camera) throw new Error('Spot CAM is not available'); await camera.nudge(frame.axes) }
  },
  async stop(frame: ControlFrame) {
    if (frame.target === 'drive') await stopDrive()
    else { if (!camera) throw new Error('Spot CAM is not available'); await camera.stop() }
    if (frame.status !== 'active') manualActive = false
  },
  async position(frame: ControlFrame) { return frame.target === 'ptz' ? camera?.position() : undefined },
}
let waypoints: { id: string; x: number; z: number }[] = []

async function poseFromState(rs: any): Promise<{ x: number; z: number; heading: number } | null> {
  const edge = rs?.kinematic_state?.transforms_snapshot?.child_to_parent_edge_map?.body
  if (!edge) return null
  const p = edge.parent_tform_child?.position ?? {}
  const w = toWorld(p)
  return { x: w.x, z: w.z, heading: quatToYaw(edge.parent_tform_child?.rotation) }
}

async function stateLoop() {
  if (!session.ready) return
  let rs: any
  try {
    rs = (await call(clients.state, 'GetRobotState', { header: header() }, md())).robot_state
  } catch (e) {
    teardown(`GetRobotState: ${(e as Error).message}`)
    return
  }
  lastState = rs
  const pose = await poseFromState(rs)
  if (!pose) return
  const battery = rs.power_state?.locomotion_charge_percentage?.value ?? rs.battery_states?.[0]?.charge_percentage?.value ?? 0
  const motorOn = rs.power_state?.motor_power_state === 2
  const charging = rs.battery_states?.[0]?.status === 2
  const speed = Math.abs(rs.kinematic_state?.velocity_of_body_in_odom?.linear?.x ?? 0)
  const estopped = (rs.estop_states ?? []).some((e: any) => e.state === 1)
  const mode = manualActive ? 'teleop' : charging ? 'charging' : !motorOn ? 'idle' : speed > 0.05 ? (missionRun ? 'executing' : 'navigating') : 'idle'
  const rep = await plantbot.state(SERIAL, {
    x: +pose.x.toFixed(2),
    z: +pose.z.toFixed(2),
    heading: +pose.heading.toFixed(3),
    speed: +speed.toFixed(2),
    battery: +battery.toFixed(0),
    mode,
    errors: estopped ? ['ESTOPPED'] : undefined,
  })

  // behavior fault 沿：新故障 → 平台事件（FALL/HARDWARE/LEASE_TIMEOUT）
  const CAUSE: Record<number, string> = { 1: 'FALL', 2: 'HARDWARE', 3: 'LEASE_TIMEOUT' } // 跌倒 / 硬件 / 租约超时
  const faults: any[] = rs.behavior_fault_state?.faults ?? []
  for (const f of faults) {
    const fid = Number(f.behavior_fault_id)
    if (!lastFaultIds.has(fid))
      reportFault(plantbot, SERIAL, `BehaviorFault #${fid} · ${CAUSE[f.cause] ?? `cause ${f.cause}`}${f.status === 1 ? ' · clearable' : ''}`)
  }
  lastFaultIds = new Set(faults.map((f) => Number(f.behavior_fault_id)))

  // 运动类订单由 SDK 泵串行；抢占 = 置在飞运动 aborted（navigateTo 轮询即返回），
  // 泵等其结束再发新单。
  await pumpOrders(plantbot, SERIAL, rep, execOrder, {
    preempt: () => {
      if (activeMotion) activeMotion.aborted = true
    },
    log,
  })
}

// ---------- 运动（NavigateToAnchor + feedback 轮询）----------

async function navigateTo(x: number, z: number, timeoutMs = 120_000): Promise<{ ok: boolean; note: string }> {
  if (!session.ready || !session.lease) return { ok: false, note: 'session not ready' }
  const seed = toSeed(x, z)
  let res: any
  try {
    res = await call(
      clients.graphNav,
      'NavigateToAnchor',
      {
        header: header(),
        leases: [session.lease],
        seed_tform_goal: { position: { x: seed.x, y: seed.y, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } },
        end_time: endTime(timeoutMs),
        clock_identifier: session.clockId,
        command_id: 0,
      },
      md(),
    )
  } catch (e) {
    return { ok: false, note: `NavigateToAnchor: ${(e as Error).message}` }
  }
  if (res.status !== 1) return { ok: false, note: `NavigateToAnchor status ${res.status}` }
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 800))
    if (activeMotion?.aborted) return { ok: false, note: 'aborted' }
    if (Date.now() - t0 > timeoutMs) return { ok: false, note: 'navigation timeout' }
    let fb: any
    try {
      fb = await call(clients.graphNav, 'NavigationFeedback', { header: header(), command_id: res.command_id }, md())
    } catch {
      continue
    }
    if (fb.status === 2) return { ok: true, note: 'REACHED_GOAL' }
    if (fb.status !== 1) return { ok: false, note: `NavigationFeedback status ${fb.status}` }
  }
}

async function sit(): Promise<void> {
  if (!session.ready) return
  await call(
    clients.command,
    'RobotCommand',
    {
      header: header(),
      lease: session.lease,
      clock_identifier: session.clockId,
      command: { synchronized_command: { mobility_command: { sit_request: {} } } },
    },
    md(),
  ).catch(() => {})
}

// ---------- 订单执行 ----------

let cameraGeneration = 0
let cameraMotion: Promise<void> | undefined

async function execOrder(order: PlantbotOrder) {
  switch (order.kind) {
    case 'goto': {
      const { x, z, dock } = order.payload
      if (typeof x !== 'number' || typeof z !== 'number') return void plantbot.orderStatus(order.id, 'failed', 'x,z required')
      // 抢占进行中的运动由 SDK 泵 preempt 钩子承担（串行后此处无并发在飞任务）
      const ctl = { aborted: false }
      activeMotion = ctl
      try {
        const r = await navigateTo(x, z)
        if (r.ok && dock) {
          await sit() // 到桩坐下 → 触发充电（Spot Dock 行为的最小等价）
          await plantbot.orderStatus(order.id, 'done', 'Docked · sitting on charger')
        } else {
          await plantbot.orderStatus(
            order.id,
            r.ok ? 'done' : 'failed',
            r.ok ? 'Anchor goal reached · 360° scan complete' : ctl.aborted ? 'preempted by newer order' : r.note,
          )
        }
      } finally {
        if (activeMotion === ctl) activeMotion = null
      }
      return
    }
    case 'mission': {
      missionRun = { orderId: order.id, aborted: false, paused: false }
      activeMotion = missionRun
      log.info(`任务「${order.payload.name}」· ${order.payload.steps?.length ?? 0} 步（NavigateToAnchor 逐点）`)
      await runWaypointMission({
        pb: plantbot,
        order,
        run: missionRun,
        waypoints,
        navTo: navigateTo,
        doneNote: (n) => `${n} anchors inspected · imagery captured`,
        onSettled: () => {
          if (activeMotion === missionRun) activeMotion = null
          missionRun = null
        },
      })
      return
    }
    case 'pause':
      if (missionRun) missionRun.paused = true
      await call(clients.command, 'RobotCommand', { header: header(), lease: session.lease, clock_identifier: session.clockId, command: { synchronized_command: { mobility_command: { stand_request: {} } } } }, md()).catch(() => {})
      await plantbot.orderStatus(order.id, 'done', 'holding (stand)')
      return
    case 'resume':
      if (missionRun) missionRun.paused = false
      await plantbot.orderStatus(order.id, 'done', 'resumed')
      return
    case 'abort':
      if (activeMotion) activeMotion.aborted = true // 中止在飞运动（goto 或 mission）
      await sit().then(() => plantbot.orderStatus(order.id, 'done', 'mission aborted · sitting'))
      return
    case 'ptz': {
      if (!camera || order.payload.channelId !== cameraStreamId) return void await plantbot.orderStatus(order.id, 'failed', 'Spot CAM channel unavailable')
      try {
        if (order.payload.mode === 'stop') {
          cameraGeneration++
          await cameraMotion?.catch(() => {})
          await camera.stop()
          await plantbot.orderStatus(order.id, 'done', 'Spot CAM stop confirmed')
          return
        }
        if (order.payload.mode !== 'absolute') throw new Error('Spot CAM requires absolute positioning')
        if (cameraMotion) throw new Error('Spot CAM is busy')
        const generation = ++cameraGeneration
        const motion = camera.move({ pan: order.payload.pan!, tilt: order.payload.tilt!, zoom: order.payload.zoom! }, () => cameraGeneration !== generation)
        cameraMotion = motion
        try { await motion } finally { if (cameraMotion === motion) cameraMotion = undefined }
        await plantbot.orderStatus(order.id, 'done', 'Spot CAM measured position reached')
      } catch (e) { await plantbot.orderStatus(order.id, 'failed', e instanceof Error ? e.message : String(e)) }
      return
    }
    case 'announce':
      // 裸机 Spot 无扬声器/云台（那是 Spot CAM 载荷）——能力矩阵讲真话
      await plantbot.orderStatus(order.id, 'failed', `${order.kind} unsupported (base Spot has no speaker/PTZ payload)`)
      return
  }
}

// ---------- 启动 ----------

async function main() {
  void dance()
  const site = await waitForSite(plantbot)
  waypoints = site.waypoints.map((w) => ({ id: w.id, x: w.x, z: w.z }))

  // 等会话就绪后注册（用真实位姿作 home；注册前不进状态上报环）
  while (!session.ready) await new Promise((r) => setTimeout(r, 800))
  while (!lastState) {
    lastState = await call(clients.state, 'GetRobotState', { header: header() }, md())
      .then((r: any) => r.robot_state)
      .catch(() => null)
    if (!lastState) await new Promise((r) => setTimeout(r, 800))
  }
  const pose = await poseFromState(lastState)
  const ptzs = await call(clients.ptz, 'ListPtz', { header: header() }, md(), 1000).catch(() => null)
  const description = ptzs?.header?.error?.code === 1 ? ptzs.ptzs?.find((p: any) => p.name === (process.env.SPOT_CAM_PTZ ?? 'mech')) : undefined
  if (description && ['pan', 'tilt', 'zoom'].every(axis => Number.isFinite(description[`${axis}_limit`]?.min?.value) && Number.isFinite(description[`${axis}_limit`]?.max?.value))) {
    const limits = Object.fromEntries(['pan', 'tilt', 'zoom'].map(axis => [axis, [description[`${axis}_limit`].min.value, description[`${axis}_limit`].max.value]])) as any
    camera = new SpotCamera(description.name, limits, (method, body) => call(clients.ptz, method, { header: header(), ...body }, md(), 500))
    try { await camera.position() } catch (error) { camera = undefined; log.warn(`Spot CAM unavailable: ${String(error)}`) }
  }
  const streams = streamsToFactsheet(PROFILE.streams, STREAM_BASE)
  if (camera) {
    const existing = streams.find(s => s.id === cameraStreamId)
    const capability = { absolute: true, manual: 'position' as const, ...camera.limits }
    if (existing) Object.assign(existing, { ptz: capability })
    else if (process.env.SPOT_CAM_STREAM_URL || !process.env.PB_SERIAL) streams.push({ id: cameraStreamId, name: 'Spot CAM PTZ', kind: 'camera', url: process.env.SPOT_CAM_STREAM_URL ?? `${STREAM_BASE}/switchgear.mp4`, ptz: capability } as any)
  }
  await plantbot.registerUntilUp({
    serial: SERIAL,
    model: 'Spot',
    vendor: 'Boston Dynamics',
    callsign: PROFILE.callsign,
    family: 'quadruped',
    level: 'dispatchable',
    teleop: { forward: 0.5, lateral: 0.3, turn: 0.6, watchdog: 'native' },
    protocol: 'bosdyn.api gRPC (auth+timesync+lease+estop+power)',
    home: pose ? { x: +pose.x.toFixed(1), z: +pose.z.toFixed(1) } : undefined,
    streams,
  })
  const srcs = await call(clients.image, 'ListImageSources', { header: header() }, md()).catch(() => null)
  log.info(`已注册 ${PROFILE.callsign}（${SERIAL}）· 机身相机 ${srcs?.image_sources?.length ?? 0} 源`)

  setInterval(() => void stateLoop(), 1000)
  const control = pumpControl(plantbot, SERIAL, manualController)
  const shutdown = () => { void control.stop().finally(() => process.exit(0)) }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  // 5s：battery 健康读数（voltage/temp 来自 BatteryState）
  setInterval(() => {
    const b = lastState?.battery_states?.[0]
    if (!b || !session.ready) return
    void plantbot.readings(SERIAL, [
      { metric: 'batt.v', value: +(b.voltage?.value ?? 0).toFixed(1) },
      { metric: 'batt.temp.c', value: +(b.temperatures?.[0] ?? 0).toFixed(1) },
    ])
  }, 5000)
}

void main()
