// Boston Dynamics Spot 仿真 —— 官方 bosdyn.api gRPC server 面（vendored proto 闭包）。
// 按 docs/vendors/spot-sdk.md 还原会话舞蹈的每一道闸：
//   token（除 auth/robot-id 外全体校验 Bearer）→ time-sync（两轮才 STATUS_OK，命令须带
//   clock_identifier）→ lease（body 单一持有 + sequence 新旧判定 + RetainLease 保活）→
//   estop（challenge/response uint64 取反 + timeout/3 心跳，超时 SETTLE_THEN_CUT 断电）→
//   power（未放行回 STATUS_ESTOPPED；未上电发运动指令回 STATUS_NOT_POWERED_ON）。
// 运动模型工作在 odom/seed 帧（x 东 y 北，即 plant-07 世界系的 y=-z 镜像）。

import grpc from '@grpc/grpc-js'
import { api, graphNav, ts, tsToMs, okHeader, estopResponse, yawToQuat, U64_MASK } from '../loader.js'
import { makeLog } from '../../shared/log.js'

const log = makeLog('spot-sim')
const PORT = Number(process.env.SPOT_SIM_PORT ?? 9103)
const USER = process.env.SPOT_SIM_USER ?? 'admin'
const PASS = process.env.SPOT_SIM_PASS ?? 'spotdev2026'
// 充电桩与初始位姿（seed 帧 x 东 y 北 ≡ 世界系 y=-z），随实例场站参数化：
// 默认 = plant-07 的 WP-09 (-11.5,-6.9)世界；campus 实例经 SPOT_SIM_* 传 DOCK-C，
// 否则 dock 命令把机器人送到场站桩位后充电判定仍留在 plant 坐标（永不 charging）。
const DOCK = { x: Number(process.env.SPOT_SIM_DOCK_X ?? -11.5), y: Number(process.env.SPOT_SIM_DOCK_Y ?? 6.9) }
const HOME = { x: Number(process.env.SPOT_SIM_HOME_X ?? 4), y: Number(process.env.SPOT_SIM_HOME_Y ?? -2) }

// 1×1 灰 JPEG —— GetImage 的最小合法帧（协议保真；证据图走平台快照服务）
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
)

// ---------- 机体模型 ----------
const st = {
  x: HOME.x, y: HOME.y, yaw: 0, speed: 0,
  battery: 88, charging: false,
  motor: 1 as 1 | 2 | 3 | 4, // MOTOR_POWER_STATE_ OFF=1 ON=2 POWERING_ON=3 POWERING_OFF=4
  standing: false,
  navGoal: null as { x: number; y: number; commandId: number; reached: boolean; endAt: number } | null,
  vel: null as { vx: number; vy: number; w: number; endAt: number } | null,
  behaviorFaults: [] as { behavior_fault_id: number; cause: number; status: number }[],
}

// ---------- 会话状态 ----------
let tokenOk = new Set<string>()
const clockId = 'spot-sim-clock'
let tsRounds = 0 // client_name 无从取 → 连接无关全局轮数（单客户端场景）

let leaseSeq = 0
let lease: { epoch: string; sequence: number[]; owner: string; retainedAt: number } | null = null

interface EstopEp {
  unique_id: string
  name: string
  role: string
  timeoutMs: number
  challenge: bigint
  lastCheckinAt: number
  level: number // 应答时申报的 stop_level；4=NONE 放行
}
let estopEp: EstopEp | null = null
let estopConfigId = 'estop-config-sim-1'

let powerCmdSeq = 0
const powerCmds = new Map<number, { done: boolean }>()
let cmdSeq = 100
let navSeq = 500

const estopped = () => !estopEp || estopEp.level !== 4 || Date.now() - estopEp.lastCheckinAt > estopEp.timeoutMs

// estop 超时执法：SETTLE_THEN_CUT —— 停导航、坐下、断电
setInterval(() => {
  if (estopEp && Date.now() - estopEp.lastCheckinAt > estopEp.timeoutMs && st.motor === 2) {
    log.warn(`estop check-in 超时（>${estopEp.timeoutMs}ms）→ SETTLE_THEN_CUT：断电停机`)
    st.motor = 1
    st.navGoal = null
    st.vel = null
    st.standing = false
  }
}, 500)

// SPOT_SIM_FAULT_S：测试用 behavior fault 注入（FALL，可清除）
const faultEveryS = Number(process.env.SPOT_SIM_FAULT_S ?? 0)
let faultSeq = 900
if (faultEveryS > 0)
  setInterval(() => {
    st.behaviorFaults.push({ behavior_fault_id: ++faultSeq, cause: 1, status: 1 })
    log.warn(`注入 BehaviorFault #${faultSeq}（FALL · clearable）`)
  }, faultEveryS * 1000)

// 运动主循环
const SPEED = 1.2
setInterval(() => {
  const dt = 0.25
  const now = Date.now()
  if (st.motor !== 2) {
    st.speed = 0
  } else if (st.vel && now < st.vel.endAt) {
    // 速度指令（end_time 即 deadman）
    st.x += st.vel.vx * dt
    st.y += st.vel.vy * dt
    st.yaw += st.vel.w * dt
    st.speed = Math.hypot(st.vel.vx, st.vel.vy)
  } else if (st.navGoal && !st.navGoal.reached) {
    if (now > st.navGoal.endAt) {
      st.navGoal = null // 命令过期即停（end_time 语义）
      st.speed = 0
    } else {
      const dx = st.navGoal.x - st.x
      const dy = st.navGoal.y - st.y
      const d = Math.hypot(dx, dy)
      if (d < 0.2) {
        st.navGoal.reached = true
        st.speed = 0
      } else {
        const step = Math.min(SPEED * dt, d)
        st.x += (dx / d) * step
        st.y += (dy / d) * step
        st.yaw = Math.atan2(dy, dx)
        st.speed = SPEED
      }
    }
  } else {
    st.speed = 0
  }
  // 电量：桩上充电（0.5m 内且静止），运动放电
  st.charging = Math.hypot(DOCK.x - st.x, DOCK.y - st.y) < 0.6 && st.speed === 0
  if (st.charging) st.battery = Math.min(100, st.battery + dt * 0.35)
  else if (st.motor === 2) st.battery = Math.max(1, st.battery - dt * (st.speed > 0 ? 0.02 : 0.004))
}, 250)

// ---------- 通用校验 ----------

const authed = (call: grpc.ServerUnaryCall<any, any>): boolean => {
  const md = call.metadata.get('authorization')
  const v = String(md[0] ?? '')
  return v.startsWith('Bearer ') && tokenOk.has(v.slice(7))
}

const seqCmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d) return d
  }
  return 0
}

/** 校验命令携带的 lease；返回 LeaseUseResult（STATUS_OK=1/INVALID=2/OLDER=3/REVOKED=4/WRONG_EPOCH=6） */
function useLease(l?: { epoch?: string; sequence?: number[]; resource?: string }) {
  const latest = lease
    ? { resource: 'body', epoch: lease.epoch, sequence: lease.sequence, client_names: [lease.owner] }
    : undefined
  if (!l || !lease) return { status: 2, latest_known_lease: latest, attempted_lease: l }
  if (l.epoch !== lease.epoch) return { status: 6, latest_known_lease: latest, attempted_lease: l }
  const c = seqCmp(l.sequence ?? [], lease.sequence)
  if (c < 0) return { status: 3, latest_known_lease: latest, attempted_lease: l, owner: { client_name: lease.owner } }
  return { status: 1, latest_known_lease: latest, attempted_lease: l }
}

type Handler = grpc.handleUnaryCall<any, any>
const guard = (h: Handler): Handler => (call, cb) => {
  if (!authed(call)) {
    cb({ code: grpc.status.UNAUTHENTICATED, message: 'invalid or missing bearer token' })
    return
  }
  h(call, cb)
}

// ---------- services ----------

const robotIdImpl = {
  GetRobotId: ((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      robot_id: {
        serial_number: process.env.SPOT_SERIAL ?? 'BD-91250107',
        species: 'spot',
        version: 'V3',
        nickname: process.env.SPOT_NICK ?? 'plant07-spot',
        computer_serial_number: '02-91250107',
        software_release: { version: { major_version: 4, minor_version: 1, patch_level: 0 }, name: 'spot-sim' },
      },
    })
  }) as Handler,
}

const SERVICES = [
  ['auth', 'bosdyn.api.AuthService', false],
  ['robot-id', 'bosdyn.api.RobotIdService', false],
  ['directory', 'bosdyn.api.DirectoryService', true],
  ['time-sync', 'bosdyn.api.TimeSyncService', true],
  ['lease', 'bosdyn.api.LeaseService', true],
  ['estop', 'bosdyn.api.EstopService', true],
  ['power', 'bosdyn.api.PowerService', true],
  ['robot-state', 'bosdyn.api.RobotStateService', true],
  ['robot-command', 'bosdyn.api.RobotCommandService', true],
  ['image', 'bosdyn.api.ImageService', true],
  ['graph-nav-service', 'bosdyn.api.graph_nav.GraphNavService', true],
] as const

const directoryImpl = {
  ListServiceEntries: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      service_entries: SERVICES.map(([name, type, tok]) => ({
        name,
        type,
        authority: `${name}.spot-sim`,
        user_token_required: tok,
        last_update: ts(),
      })),
    })
  }),
  GetServiceEntry: guard((call, cb) => {
    const e = SERVICES.find(([n]) => n === call.request.service_name)
    cb(null, {
      header: okHeader(call.request.header),
      status: e ? 1 : 2, // STATUS_OK / STATUS_NONEXISTENT_SERVICE
      service_entry: e ? { name: e[0], type: e[1], authority: `${e[0]}.spot-sim`, user_token_required: e[2] } : undefined,
    })
  }),
}

const authImpl = {
  GetAuthToken: ((call, cb) => {
    const { username, password, token } = call.request
    if (token && tokenOk.has(token)) {
      const t = `jwt-sim-${Math.random().toString(36).slice(2)}`
      tokenOk.add(t)
      return cb(null, { header: okHeader(call.request.header), status: 1, token: t })
    }
    if (username === USER && password === PASS) {
      const t = `jwt-sim-${Math.random().toString(36).slice(2)}`
      tokenOk.add(t)
      log.info(`认证通过 · 发放 token（user=${username}）`)
      return cb(null, { header: okHeader(call.request.header), status: 1, token: t })
    }
    cb(null, { header: okHeader(call.request.header), status: 2, token: '' }) // STATUS_INVALID_LOGIN
  }) as Handler,
}

const timeSyncImpl = {
  TimeSyncUpdate: guard((call, cb) => {
    tsRounds++
    const ok = tsRounds >= 2
    cb(null, {
      header: okHeader(call.request.header),
      previous_estimate: { round_trip_time: { seconds: '0', nanos: 2_000_000 }, clock_skew: { seconds: '0', nanos: 0 } },
      state: {
        status: ok ? 1 : 2, // OK / MORE_SAMPLES_NEEDED
        best_estimate: { round_trip_time: { seconds: '0', nanos: 2_000_000 }, clock_skew: { seconds: '0', nanos: 0 } },
        measurement_time: ts(),
      },
      clock_identifier: clockId,
    })
  }),
}

const leaseImpl = {
  AcquireLease: guard((call, cb) => {
    const resource = call.request.resource
    if (resource !== 'body')
      return cb(null, { header: okHeader(call.request.header), status: 3 }) // INVALID_RESOURCE
    const fresh = lease && Date.now() - lease.retainedAt < 6000
    if (fresh)
      return cb(null, {
        header: okHeader(call.request.header),
        status: 2, // RESOURCE_ALREADY_CLAIMED
        lease_owner: { client_name: lease!.owner },
      })
    lease = { epoch: 'sim-epoch-1', sequence: [++leaseSeq], owner: call.request.header?.client_name ?? 'unknown', retainedAt: Date.now() }
    log.info(`lease[body] 授予 ${lease.owner} · seq=[${lease.sequence}]`)
    cb(null, {
      header: okHeader(call.request.header),
      status: 1,
      lease: { resource: 'body', epoch: lease.epoch, sequence: lease.sequence, client_names: [lease.owner] },
      lease_owner: { client_name: lease.owner },
    })
  }),
  TakeLease: guard((call, cb) => {
    lease = { epoch: 'sim-epoch-1', sequence: [++leaseSeq], owner: call.request.header?.client_name ?? 'unknown', retainedAt: Date.now() }
    cb(null, {
      header: okHeader(call.request.header),
      status: 1,
      lease: { resource: 'body', epoch: lease.epoch, sequence: lease.sequence, client_names: [lease.owner] },
    })
  }),
  RetainLease: guard((call, cb) => {
    const r = useLease(call.request.lease)
    if (r.status === 1 && lease) lease.retainedAt = Date.now()
    cb(null, { header: okHeader(call.request.header), lease_use_result: r })
  }),
  ReturnLease: guard((call, cb) => {
    const r = useLease(call.request.lease)
    if (r.status === 1) {
      log.info('lease[body] 归还')
      lease = null
    }
    cb(null, { header: okHeader(call.request.header), status: r.status === 1 ? 1 : 2 })
  }),
  ListLeases: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      resources: lease
        ? [{ resource: 'body', lease: { resource: 'body', epoch: lease.epoch, sequence: lease.sequence }, lease_owner: { client_name: lease.owner }, is_stale: Date.now() - lease.retainedAt > 6000 }]
        : [],
      resource_tree: { resource: 'body', sub_resources: [{ resource: 'mobility' }] },
    })
  }),
}

const newChallenge = () => BigInt.asUintN(64, (BigInt(Math.floor(Math.random() * 0xffffffff)) << 32n) | BigInt(Math.floor(Math.random() * 0xffffffff)))

const estopImpl = {
  GetEstopConfig: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      active_config: {
        unique_id: estopConfigId,
        endpoints: estopEp ? [{ role: estopEp.role, name: estopEp.name, unique_id: estopEp.unique_id, timeout: { seconds: String(Math.floor(estopEp.timeoutMs / 1000)), nanos: 0 } }] : [],
      },
    })
  }),
  SetEstopConfig: guard((call, cb) => {
    estopConfigId = `estop-config-sim-${Date.now() % 1000}`
    cb(null, { header: okHeader(call.request.header), status: 1, active_config: { ...call.request.config, unique_id: estopConfigId } })
  }),
  RegisterEstopEndpoint: guard((call, cb) => {
    const ep = call.request.new_endpoint
    if (call.request.target_config_id !== estopConfigId)
      return cb(null, { header: okHeader(call.request.header), status: 3 }) // CONFIG_MISMATCH
    estopEp = {
      unique_id: `ep-${Date.now() % 100000}`,
      name: ep?.name ?? 'unnamed',
      role: ep?.role ?? 'PDB_rooted',
      timeoutMs: tsToMs(ep?.timeout) || 9000,
      challenge: newChallenge(),
      lastCheckinAt: Date.now(),
      level: 0,
    }
    log.info(`estop endpoint 注册 ${estopEp.name} · timeout=${estopEp.timeoutMs}ms（心跳应为 /3）`)
    cb(null, {
      header: okHeader(call.request.header),
      status: 1,
      new_endpoint: { role: estopEp.role, name: estopEp.name, unique_id: estopEp.unique_id, timeout: ep?.timeout },
    })
  }),
  DeregisterEstopEndpoint: guard((call, cb) => {
    estopEp = null
    cb(null, { header: okHeader(call.request.header), status: 1 })
  }),
  EstopCheckIn: guard((call, cb) => {
    const req = call.request
    if (!estopEp || req.endpoint?.unique_id !== estopEp.unique_id)
      return cb(null, { header: okHeader(call.request.header), status: 2, challenge: '0' }) // ENDPOINT_UNKNOWN
    const expected = (~estopEp.challenge) & U64_MASK
    const got = BigInt(req.response ?? 0)
    const next = newChallenge()
    if (got !== expected) {
      // 首次 check-in 没有可答的 challenge —— 官方语义：回 INCORRECT，client 忽略并取新题
      estopEp.challenge = next
      return cb(null, { header: okHeader(call.request.header), status: 5, challenge: next.toString() })
    }
    estopEp.challenge = next
    estopEp.lastCheckinAt = Date.now()
    estopEp.level = req.stop_level // 4=ESTOP_LEVEL_NONE 放行
    cb(null, { header: okHeader(call.request.header), status: 1, challenge: next.toString() })
  }),
  GetEstopSystemStatus: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      status: {
        endpoints: estopEp ? [{ endpoint: { unique_id: estopEp.unique_id, name: estopEp.name }, stop_level: estopEp.level, time_since_valid_response: ts(Date.now() - estopEp.lastCheckinAt) }] : [],
        stop_level: estopped() ? 2 : 4,
      },
    })
  }),
}

const powerImpl = {
  PowerCommand: guard((call, cb) => {
    const lu = useLease(call.request.lease)
    if (lu.status !== 1)
      return cb(null, { header: okHeader(call.request.header), lease_use_result: lu, status: 8 }) // INTERNAL_ERROR + lease result
    if (estopped() && call.request.request === 2)
      return cb(null, { header: okHeader(call.request.header), lease_use_result: lu, status: 6 }) // STATUS_ESTOPPED
    const id = ++powerCmdSeq
    if (call.request.request === 2) {
      // REQUEST_ON_MOTORS：600ms 上电
      st.motor = 3
      powerCmds.set(id, { done: false })
      setTimeout(() => {
        st.motor = 2
        powerCmds.set(id, { done: true })
        log.info('电机上电完成（MOTOR_POWER_STATE_ON）')
      }, 600)
      return cb(null, { header: okHeader(call.request.header), lease_use_result: lu, status: 1, power_command_id: id }) // IN_PROGRESS
    }
    if (call.request.request === 1) {
      st.motor = 1
      st.navGoal = null
      st.vel = null
      powerCmds.set(id, { done: true })
      return cb(null, { header: okHeader(call.request.header), lease_use_result: lu, status: 2, power_command_id: id }) // SUCCESS
    }
    cb(null, { header: okHeader(call.request.header), lease_use_result: lu, status: 8 })
  }),
  PowerCommandFeedback: guard((call, cb) => {
    const rec = powerCmds.get(Number(call.request.power_command_id))
    cb(null, { header: okHeader(call.request.header), status: rec?.done ? 2 : 1 }) // SUCCESS / IN_PROGRESS
  }),
}

function frameTree() {
  return {
    child_to_parent_edge_map: {
      body: {
        parent_frame_name: 'odom',
        parent_tform_child: { position: { x: st.x, y: st.y, z: 0 }, rotation: yawToQuat(st.yaw) },
      },
      vision: { parent_frame_name: 'odom', parent_tform_child: { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } } },
    },
  }
}

const robotStateImpl = {
  GetRobotState: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      robot_state: {
        power_state: {
          timestamp: ts(),
          motor_power_state: st.motor,
          shore_power_state: 2, // OFF
          locomotion_charge_percentage: { value: st.battery },
        },
        battery_states: [
          {
            timestamp: ts(),
            identifier: 'bat-0',
            charge_percentage: { value: st.battery },
            current: { value: st.charging ? 6.4 : -3.1 },
            voltage: { value: 52.3 - (100 - st.battery) * 0.06 },
            temperatures: [31.5 + (100 - st.battery) * 0.05],
            status: st.charging ? 2 : 3, // CHARGING / DISCHARGING
          },
        ],
        estop_states: [
          { timestamp: ts(), name: 'software_estop', type: 2, state: estopped() ? 1 : 2 },
          { timestamp: ts(), name: 'hardware_estop', type: 1, state: 2 },
        ],
        kinematic_state: {
          acquisition_timestamp: ts(),
          transforms_snapshot: frameTree(),
          velocity_of_body_in_odom: { linear: { x: st.speed, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } },
        },
        behavior_fault_state: { faults: st.behaviorFaults.map((f) => ({ ...f, onset_timestamp: ts() })) },
        system_fault_state: { faults: [], aggregated: {} },
      },
    })
  }),
}

const robotCommandImpl = {
  RobotCommand: guard((call, cb) => {
    const req = call.request
    const lu = useLease(req.lease)
    const H = okHeader(req.header)
    if (lu.status !== 1) return cb(null, { header: H, lease_use_result: lu, status: 2, message: 'lease rejected' })
    if (req.clock_identifier !== clockId)
      return cb(null, { header: H, lease_use_result: lu, status: 4, message: 'no timesync' }) // STATUS_NO_TIMESYNC
    const mob = req.command?.synchronized_command?.mobility_command
    if (!mob) return cb(null, { header: H, lease_use_result: lu, status: 2, message: 'only synchronized.mobility supported' })
    if (st.motor !== 2 && !mob.sit_request)
      return cb(null, { header: H, lease_use_result: lu, status: 7, message: 'not powered on' }) // STATUS_NOT_POWERED_ON
    const id = ++cmdSeq
    const branch = mob.command // oneofs 虚拟字段
    if (branch === 'se2_trajectory_request') {
      const tr = mob.se2_trajectory_request
      const frame = tr.se2_frame_name
      if (frame !== 'odom' && frame !== 'vision' && frame !== 'body')
        return cb(null, { header: H, lease_use_result: lu, status: 8, message: `unknown frame ${frame}` })
      const p = tr.trajectory?.points?.[0]?.pose
      if (!p) return cb(null, { header: H, lease_use_result: lu, status: 2, message: 'empty trajectory' })
      const goal =
        frame === 'body'
          ? { x: st.x + Math.cos(st.yaw) * (p.position?.x ?? 0) - Math.sin(st.yaw) * (p.position?.y ?? 0), y: st.y + Math.sin(st.yaw) * (p.position?.x ?? 0) + Math.cos(st.yaw) * (p.position?.y ?? 0) }
          : { x: p.position?.x ?? 0, y: p.position?.y ?? 0 }
      st.navGoal = { ...goal, commandId: id, reached: false, endAt: tsToMs(tr.end_time) || Date.now() + 30_000 }
      st.standing = true
    } else if (branch === 'se2_velocity_request') {
      const v = mob.se2_velocity_request
      const lin = v.velocity?.linear ?? {}
      // flat_body/odom/vision 帧：机体系速度转全局
      const vx = (lin.x ?? 0) * Math.cos(st.yaw) - (lin.y ?? 0) * Math.sin(st.yaw)
      const vy = (lin.x ?? 0) * Math.sin(st.yaw) + (lin.y ?? 0) * Math.cos(st.yaw)
      st.vel = { vx, vy, w: v.velocity?.angular ?? 0, endAt: tsToMs(v.end_time) || Date.now() + 500 }
      st.standing = true
    } else if (branch === 'stand_request') {
      st.standing = true
    } else if (branch === 'sit_request') {
      st.standing = false
      st.navGoal = null
      st.vel = null
    } else {
      return cb(null, { header: H, lease_use_result: lu, status: 3, message: `unsupported ${branch}` })
    }
    cb(null, { header: H, lease_use_result: lu, status: 1, robot_command_id: id })
  }),
  RobotCommandFeedback: guard((call, cb) => {
    const id = Number(call.request.robot_command_id)
    const H = okHeader(call.request.header)
    const nav = st.navGoal
    const traj =
      nav && nav.commandId === id
        ? { status: nav.reached ? 1 : 2, body_movement_status: nav.reached ? 2 : 1, final_goal_status: nav.reached ? 2 : 1 }
        : { status: 1, body_movement_status: 2, final_goal_status: 2 } // 无在途 → 视作已停
    cb(null, {
      header: H,
      feedback: {
        synchronized_feedback: {
          mobility_command_feedback: {
            status: 1, // RobotCommandFeedbackStatus.STATUS_PROCESSING
            se2_trajectory_feedback: traj,
          },
        },
      },
    })
  }),
  ClearBehaviorFault: guard((call, cb) => {
    const id = Number(call.request.behavior_fault_id)
    st.behaviorFaults = st.behaviorFaults.filter((f) => f.behavior_fault_id !== id)
    cb(null, { header: okHeader(call.request.header), status: 1 })
  }),
}

const IMAGE_SOURCES = [
  'frontleft_fisheye_image',
  'frontright_fisheye_image',
  'left_fisheye_image',
  'right_fisheye_image',
  'back_fisheye_image',
]

const imageImpl = {
  ListImageSources: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      image_sources: IMAGE_SOURCES.map((name) => ({
        name,
        cols: 640,
        rows: 480,
        image_type: 1, // VISUAL
        pixel_formats: [3],
        image_formats: [1],
      })),
    })
  }),
  GetImage: guard((call, cb) => {
    const reqs = call.request.image_requests ?? []
    cb(null, {
      header: okHeader(call.request.header),
      image_responses: reqs.map((r: any) => ({
        shot: {
          acquisition_time: ts(),
          frame_name_image_sensor: r.image_source_name,
          image: { cols: 64, rows: 48, data: TINY_JPEG, format: 1, pixel_format: 3 },
        },
        source: { name: r.image_source_name, cols: 640, rows: 480, image_type: 1 },
        status: IMAGE_SOURCES.includes(r.image_source_name) ? 1 : 2, // OK / UNKNOWN_CAMERA
      })),
    })
  }),
}

let navCommand: { id: number; reachedAt: number | null } | null = null

const graphNavImpl = {
  SetLocalization: guard((call, cb) => {
    cb(null, { header: okHeader(call.request.header), status: 1, localization: locNow() })
  }),
  GetLocalizationState: guard((call, cb) => {
    cb(null, {
      header: okHeader(call.request.header),
      localization: locNow(),
      robot_kinematics: { transforms_snapshot: frameTree() },
    })
  }),
  NavigateToAnchor: guard((call, cb) => {
    const req = call.request
    const H = okHeader(req.header)
    const lus = (req.leases ?? []).map((l: any) => useLease(l))
    if (!lus.length || lus.some((r: any) => r.status !== 1))
      return cb(null, { header: H, lease_use_results: lus.length ? lus : [useLease(undefined)], status: 1, command_id: 0 })
    if (req.clock_identifier !== clockId) return cb(null, { header: H, lease_use_results: lus, status: 2, command_id: 0 }) // NO_TIMESYNC
    if (st.motor !== 2) return cb(null, { header: H, lease_use_results: lus, status: 5, command_id: 0 }) // ROBOT_IMPAIRED
    const goal = req.seed_tform_goal
    if (!goal) return cb(null, { header: H, lease_use_results: lus, status: 16, command_id: 0 }) // INVALID_POSE
    const id = ++navSeq
    st.navGoal = { x: goal.position?.x ?? 0, y: goal.position?.y ?? 0, commandId: id, reached: false, endAt: tsToMs(req.end_time) || Date.now() + 60_000 }
    st.standing = true
    navCommand = { id, reachedAt: null }
    log.info(`NavigateToAnchor #${id} → seed(${(goal.position?.x ?? 0).toFixed(1)}, ${(goal.position?.y ?? 0).toFixed(1)})`)
    cb(null, { header: H, lease_use_results: lus, status: 1, command_id: id })
  }),
  NavigateTo: guard((call, cb) => {
    cb(null, { header: okHeader(call.request.header), status: 7, command_id: 0 }) // UNKNOWN_WAYPOINT（sim 不建图）
  }),
  NavigationFeedback: guard((call, cb) => {
    const id = Number(call.request.command_id)
    const H = okHeader(call.request.header)
    if (!navCommand || navCommand.id !== id) return cb(null, { header: H, status: 12 }) // COMMAND_OVERRIDDEN
    const nav = st.navGoal
    if (nav && nav.commandId === id && !nav.reached && Date.now() > nav.endAt)
      return cb(null, { header: H, status: 7 }) // COMMAND_TIMED_OUT
    const reached = !nav || nav.commandId !== id || nav.reached
    cb(null, { header: H, status: reached ? 2 : 1 }) // REACHED_GOAL / FOLLOWING_ROUTE
  }),
}

const locNow = () => ({
  waypoint_id: 'anchor-seed',
  waypoint_tform_body: { position: { x: 0, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } },
  seed_tform_body: { position: { x: st.x, y: st.y, z: 0 }, rotation: yawToQuat(st.yaw) },
  timestamp: ts(),
})

// ---------- bind ----------

const server = new grpc.Server()
server.addService(api.RobotIdService.service, robotIdImpl)
server.addService(api.DirectoryService.service, directoryImpl)
server.addService(api.AuthService.service, authImpl)
server.addService(api.TimeSyncService.service, timeSyncImpl)
server.addService(api.LeaseService.service, leaseImpl)
server.addService(api.EstopService.service, estopImpl)
server.addService(api.PowerService.service, powerImpl)
server.addService(api.RobotStateService.service, robotStateImpl)
server.addService(api.RobotCommandService.service, robotCommandImpl)
server.addService(api.ImageService.service, imageImpl)
server.addService(graphNav.GraphNavService.service, graphNavImpl)

server.bindAsync(`127.0.0.1:${PORT}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) {
    log.warn(`bind 失败: ${err.message}`)
    process.exit(1)
  }
  log.info(`Spot 仿真就绪 grpc://127.0.0.1:${PORT} · serial BD-91250107 · 电量 ${st.battery}% · 充电桩 seed(${DOCK.x}, ${DOCK.y})`)
  log.info('会话闸生效：token → timesync(2轮) → lease(body) → estop challenge/response → power ON_MOTORS')
})
