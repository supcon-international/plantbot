// 云深处绝影 X30「106 导航主机 robot_server」仿真 —— TCP server 面。
// 按 docs/vendors/deeprobotics-robotserver.md 还原：
//   - 监听 30000（官方示例端口），无握手/无鉴权/无心跳；
//   - 1002/1004/1007 同步即答（回填请求 seq）；
//   - 1003 不回 ACK —— 任务终态时才用当年的 seq 回唯一一帧（0 成功/1 失败/2 取消 + ErrorStatus 细因码）；
//   - 发包纪律：一次 write 只装一帧（官方 SDK 收包「单帧解析 + 整段清空」）。
// 行为模型：X30 只有「执行导航任务」与「待机/充电」两种生活；机器人本体的
// 定时任务（X30 平板 App 可配）以「空闲即自跑本地巡检环」模拟——平台会以
// state-only 视角看到厂商侧自主任务在动。

import net from 'node:net'
import { makeLog } from '../../shared/log.js'
import {
  FrameParser, encodeFrame, TYPE,
  buildRealtimeResp, buildNavTaskResp, buildCancelResp, buildQueryResp,
  parseNavTaskReq, type NavPoint, type RealtimeStatus,
} from '../protocol.js'

const log = makeLog('deepro-sim')
const PORT = Number(process.env.DR_SIM_PORT ?? 30000)
/** 空闲多久后自跑本地巡检环（机器人本体排程的模拟）；0 = 关闭 */
const LOCAL_PATROL_IDLE_MS = Number(process.env.DR_SIM_LOCAL_PATROL_MS ?? 150_000)

// 地图坐标系（米，y 北向）；本地巡检环（海港码头一圈）
const HOME = { x: -11, y: 6 } // 充电桩
const LOCAL_ROUTE = [
  { x: -8, y: 4 },
  { x: -3, y: -2 },
  { x: 3, y: -5 },
  { x: 8, y: -2 },
  { x: 3, y: 3 },
]

interface NavRun {
  points: NavPoint[]
  idx: number
  seq: number | null // null = 本地任务（无 SDK 回帧）
  sock: net.Socket | null
  cancelled: boolean
}

const st = {
  x: HOME.x,
  y: HOME.y,
  yaw: 0,
  speed: 0,
  electricity: 91,
  curOdom: 0,
  sumOdom: 4213,
  bootAt: Date.now(),
  location: 0 as 0 | 1, // 0 正常 / 1 定位丢失
  charge: 0 as 0 | 1,
  run: null as NavRun | null,
  idleSince: Date.now(),
  lastDone: { value: 0, status: 0 as -1 | 0 | 1 },
}

// ---- 行为主循环 ----
const SPEED = 1.1 // m/s
setInterval(() => {
  const dt = 0.25
  const now = Date.now()

  // 偶发定位漂移（约每 10 分钟 20 秒），期间任务照常但 Location=1 —— adapter 应报本体故障
  // DR_SIM_FAULT_S：测试用固定注入周期（秒）
  const faultEveryS = Number(process.env.DR_SIM_FAULT_S ?? 0)
  const p = faultEveryS > 0 ? dt / faultEveryS : dt / 600
  if (st.location === 0 && Math.random() < p) {
    st.location = 1
    log.warn('注入：定位丢失 Location=1（20s）')
    setTimeout(() => (st.location = 0), faultEveryS > 0 ? 5000 : 20_000)
  }

  const run = st.run
  if (run) {
    st.charge = 0
    const target = run.points[run.idx]
    const dx = target.PosX - st.x
    const dy = target.PosY - st.y
    const d = Math.hypot(dx, dy)
    if (d < 0.25) {
      if (run.idx + 1 < run.points.length) {
        run.idx++
      } else {
        finishRun(0, 8960) // 单点巡检任务执行完成
      }
    } else {
      const step = Math.min(SPEED * dt, d)
      st.x += (dx / d) * step
      st.y += (dy / d) * step
      st.yaw = Math.atan2(dy, dx)
      st.speed = SPEED
      st.curOdom += step
      st.sumOdom += step
      st.electricity = Math.max(1, st.electricity - dt * 0.015)
      // 低电中断任务（真实终态注入：41730 电量过低）
      if (st.electricity < 8) finishRun(1, 41730)
    }
  } else {
    st.speed = 0
    // 空闲回桩充电
    const dHome = Math.hypot(HOME.x - st.x, HOME.y - st.y)
    if (dHome < 0.3) {
      if (st.electricity < 96) {
        st.charge = 1
        st.electricity = Math.min(100, st.electricity + dt * 0.4)
      } else st.charge = 0
    }
    // 机器人本体排程：空闲太久自跑本地环（电量充足时）
    if (
      LOCAL_PATROL_IDLE_MS > 0 &&
      now - st.idleSince > LOCAL_PATROL_IDLE_MS &&
      st.electricity > 30
    ) {
      const pts = [...LOCAL_ROUTE, HOME].map((p, i) => ({
        MapId: 0, Value: i + 1, PosX: p.x, PosY: p.y, PosZ: 0, AngleYaw: 0,
        PointInfo: 0, Gait: 0, Speed: 1, Manner: 0, ObsMode: 0, NavMode: 1, Terrain: 0, Posture: 0,
      }))
      st.run = { points: pts, idx: 0, seq: null, sock: null, cancelled: false }
      log.info('本体排程触发：自跑本地巡检环（6 点）')
    }
  }
}, 250)

function finishRun(errorCode: 0 | 1 | 2, errorStatus: number) {
  const run = st.run
  if (!run) return
  st.run = null
  st.idleSince = Date.now()
  st.speed = 0
  st.lastDone = { value: run.points[run.idx]?.Value ?? 0, status: errorCode === 0 ? 0 : -1 }
  if (run.seq !== null && run.sock && !run.sock.destroyed) {
    // 用下发时的序列号回唯一一帧终态（1003 语义核心）
    run.sock.write(encodeFrame(run.seq, buildNavTaskResp(run.points[run.idx]?.Value ?? 0, errorCode, errorStatus)))
  }
  log.info(`任务终态 ErrorCode=${errorCode} ErrorStatus=${errorStatus}`)
}

function realtime(): RealtimeStatus {
  return {
    MotionState: st.run ? 1 : 0,
    PosX: +st.x.toFixed(6),
    PosY: +st.y.toFixed(6),
    PosZ: 0.004,
    AngleYaw: +st.yaw.toFixed(6),
    Roll: 0,
    Pitch: 0,
    Yaw: +st.yaw.toFixed(6),
    Speed: +st.speed.toFixed(2),
    CurOdom: +st.curOdom.toFixed(1),
    SumOdom: +st.sumOdom.toFixed(1),
    CurRuntime: Date.now() - st.bootAt,
    SumRuntime: 9_000_000 + (Date.now() - st.bootAt),
    Res: 0,
    X0: 0,
    Y0: 0,
    H: 0,
    Electricity: Math.round(st.electricity),
    Location: st.location,
    RTKState: 0,
    OnDockState: st.charge,
    GaitState: st.run ? 2 : 0,
    MotorState: 0,
    ChargeState: st.charge,
    ControlMode: 0,
    MapUpdateState: 0,
  }
}

// ---- TCP server（robot_server 面） ----
const server = net.createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`
  log.info(`SDK 接入 ${peer}`)
  const parser = new FrameParser()
  sock.on('data', (chunk) => {
    for (const frame of parser.push(chunk)) {
      switch (frame.type) {
        case TYPE.REALTIME:
          sock.write(encodeFrame(frame.seq, buildRealtimeResp(realtime())))
          break
        case TYPE.QUERY: {
          const run = st.run
          if (run) sock.write(encodeFrame(frame.seq, buildQueryResp(run.points[run.idx].Value, 1)))
          else sock.write(encodeFrame(frame.seq, buildQueryResp(st.lastDone.value, st.lastDone.status)))
          break
        }
        case TYPE.CANCEL: {
          const run = st.run
          sock.write(encodeFrame(frame.seq, buildCancelResp(0)))
          if (run) {
            run.cancelled = true
            // 【推断】取消后补发 1003 终态（cancelled），形成 SDK 回调闭环
            finishRun(2, 8962)
          }
          break
        }
        case TYPE.NAV_TASK: {
          const points = parseNavTaskReq(frame.body)
          if (!points.length) break // 非法任务：静默（官方无 NACK 帧语义）
          if (st.run) {
            if (st.run.seq === null) {
              // 本体排程任务让位于 SDK 任务？不——按真实语义：正在执行任务，拒绝
              // （41793），SDK 侧应先 1004 取消再下发。本地任务同样占用导航栈。
              sock.write(encodeFrame(frame.seq, buildNavTaskResp(points[0].Value, 1, 41793)))
              break
            }
            sock.write(encodeFrame(frame.seq, buildNavTaskResp(points[0].Value, 1, 41793)))
            break
          }
          st.run = { points, idx: 0, seq: frame.seq, sock, cancelled: false }
          log.info(`导航任务下发 seq=${frame.seq} · ${points.length} 点 · 首点 (${points[0].PosX}, ${points[0].PosY})`)
          // 不回 ACK —— 终态时 finishRun 回帧
          break
        }
        default:
          log.warn(`未知 Type=${frame.type}，忽略（官方 SDK 端此处会卡缓冲）`)
      }
    }
  })
  sock.on('close', () => {
    log.info(`SDK 断开 ${peer}`)
    // 官方语义 41802：存在上位机连接断开，自动停止任务（仅停 SDK 下发的任务）
    if (st.run && st.run.sock === sock) finishRun(1, 41802)
  })
  sock.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  log.info(`X30 robot_server 仿真就绪 tcp://127.0.0.1:${PORT} · 电量 ${st.electricity}% · 充电桩 (${HOME.x}, ${HOME.y})`)
})
