// 云深处 robotserver_sdk 线协议编解码（sim 与 adapter 共用）。
// 依据 docs/vendors/deeprobotics-robotserver.md（源出官方 SDK 源码，逐字段）：
//   帧 = 16 字节定长头（EB 90 EB 90 + uint16LE body长度 + uint16LE 序列号 + 8×0x00）
//     + UTF-8 XML body（根 <PatrolDevice>，<Type> 1002/1003/1004/1007 区分）。
//   响应帧必须回填请求序列号；1003 的响应是任务终态，不是 ACK。

export const SYNC = Buffer.from([0xeb, 0x90, 0xeb, 0x90])

export const TYPE = {
  REALTIME: 1002,
  NAV_TASK: 1003,
  CANCEL: 1004,
  QUERY: 1007,
} as const

/** ErrorStatus_Navigation（types.h 逐值）——人类可读文案用于平台侧任务备注。
 *  文案统一英文（进英文界面）；每行注释保留厂商中文原文。 */
export const ERROR_STATUS: Record<number, string> = {
  0: 'default', // 默认
  8960: 'single-point inspection task completed', // 单点巡检任务执行完成
  8962: 'single-point inspection task cancelled', // 单点巡检任务被取消
  41729: 'motion-state fault, task failed (soft e-stop / fall)', // 运动状态异常，任务失败（软急停、摔倒）
  41730: 'battery too low, task failed', // 电量过低，任务失败
  41731: 'motor over-temperature, task failed', // 电机过温异常，任务失败
  41732: 'charging on charger, task failed', // 正在使用充电器充电，任务失败
  41745: 'navigation process not started, cannot dispatch task', // 导航进程未启动，无法下发任务
  41746: 'navigation module comms fault, cannot dispatch task', // 导航模块通讯异常，无法下发任务
  41747: 'localization persistently abnormal (over 30s)', // 定位状态持续异常（超过 30s）
  41793: 'a task is already running, new task rejected', // 当前正在执行任务，下发新任务失败
  41804: 'global path planning failed', // 导航全局规划失败
  41881: 'relocalization failed', // 重定位失败
}

export function encodeFrame(seq: number, xmlBody: string): Buffer {
  const body = Buffer.from(xmlBody, 'utf8')
  const head = Buffer.alloc(16)
  SYNC.copy(head, 0)
  head.writeUInt16LE(body.length, 4) // length = body 的 UTF-8 字节数
  head.writeUInt16LE(seq & 0xffff, 6)
  return Buffer.concat([head, body])
}

export interface Frame {
  seq: number
  type: number
  body: string
}

/** 累积缓冲拆帧器 —— 我们两端都比官方 SDK 健壮（多帧/半帧都吃），
 *  但发包纪律仍按官方接收端的限制执行（一次 write 只装一帧）。 */
export class FrameParser {
  private acc = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.acc = Buffer.concat([this.acc, chunk])
    const out: Frame[] = []
    for (;;) {
      if (this.acc.length < 16) break
      if (!(this.acc[0] === 0xeb && this.acc[1] === 0x90 && this.acc[2] === 0xeb && this.acc[3] === 0x90)) {
        // 同步字丢失：丢 1 字节重找（官方会卡死；我们容错）
        this.acc = this.acc.subarray(1)
        continue
      }
      const len = this.acc.readUInt16LE(4)
      if (this.acc.length < 16 + len) break
      const seq = this.acc.readUInt16LE(6)
      const body = this.acc.subarray(16, 16 + len).toString('utf8')
      this.acc = this.acc.subarray(16 + len)
      const type = Number(/<Type>(\d+)<\/Type>/.exec(body)?.[1] ?? 0)
      out.push({ seq, type, body })
    }
    return out
  }
}

const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface NavPoint {
  MapId: number
  Value: number
  PosX: number
  PosY: number
  PosZ: number
  AngleYaw: number
  PointInfo: number
  Gait: number
  Speed: number
  Manner: number
  ObsMode: number
  NavMode: number
  Terrain: number
  Posture: number
}

export const defaultNavPoint = (v: number, x: number, y: number, yaw = 0): NavPoint => ({
  MapId: 0,
  Value: v,
  PosX: x,
  PosY: y,
  PosZ: 0,
  AngleYaw: yaw,
  PointInfo: 0,
  Gait: 0,
  Speed: 1,
  Manner: 0,
  ObsMode: 0,
  NavMode: 1,
  Terrain: 0,
  Posture: 0,
})

// ---------- 请求（SDK/adapter → 机器人）----------

const emptyReq = (type: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n<Type>${type}</Type>\n<Command>1</Command>\n<Time>${stamp()}</Time>\n<Items/>\n</PatrolDevice>`

export const buildRealtimeReq = () => emptyReq(TYPE.REALTIME)
export const buildCancelReq = () => emptyReq(TYPE.CANCEL)
export const buildQueryReq = () => emptyReq(TYPE.QUERY)

export function buildNavTaskReq(points: NavPoint[]): string {
  const items = points
    .map(
      (p) =>
        `<Items>\n  <MapId>${p.MapId}</MapId>\n  <Value>${p.Value}</Value>\n  <PosX>${p.PosX}</PosX>\n  <PosY>${p.PosY}</PosY>\n  <PosZ>${p.PosZ}</PosZ>\n  <AngleYaw>${p.AngleYaw}</AngleYaw>\n  <PointInfo>${p.PointInfo}</PointInfo>\n  <Gait>${p.Gait}</Gait>\n  <Speed>${p.Speed}</Speed>\n  <Manner>${p.Manner}</Manner>\n  <ObsMode>${p.ObsMode}</ObsMode>\n  <NavMode>${p.NavMode}</NavMode>\n  <Terrain>${p.Terrain}</Terrain>\n  <Posture>${p.Posture}</Posture>\n</Items>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n<Type>${TYPE.NAV_TASK}</Type>\n<Command>1</Command>\n<Time>${stamp()}</Time>\n${items}\n</PatrolDevice>`
}

// ---------- 响应（机器人/sim → SDK）----------

export interface RealtimeStatus {
  MotionState: number
  PosX: number
  PosY: number
  PosZ: number
  AngleYaw: number
  Roll: number
  Pitch: number
  Yaw: number
  Speed: number
  CurOdom: number
  SumOdom: number
  CurRuntime: number
  SumRuntime: number
  Res: number
  X0: number
  Y0: number
  H: number
  Electricity: number
  Location: number
  RTKState: number
  OnDockState: number
  GaitState: number
  MotorState: number
  ChargeState: number
  ControlMode: number
  MapUpdateState: number
}

export function buildRealtimeResp(s: RealtimeStatus): string {
  const kv = (Object.entries(s) as [string, number][])
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n<Type>${TYPE.REALTIME}</Type>\n<Items>\n${kv}\n</Items>\n</PatrolDevice>`
}

export const buildNavTaskResp = (value: number, errorCode: 0 | 1 | 2, errorStatus: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n<Type>${TYPE.NAV_TASK}</Type>\n<Items>\n<Value>${value}</Value>\n<ErrorCode>${errorCode}</ErrorCode>\n<ErrorStatus>${errorStatus}</ErrorStatus>\n</Items>\n</PatrolDevice>`

export const buildCancelResp = (errorCode: 0 | 1) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n<Type>${TYPE.CANCEL}</Type>\n<Items>\n<ErrorCode>${errorCode}</ErrorCode>\n</Items>\n</PatrolDevice>`

export const buildQueryResp = (value: number, status: -1 | 0 | 1) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n<Type>${TYPE.QUERY}</Type>\n<Items>\n<Value>${value}</Value>\n<Status>${status}</Status>\n<ErrorCode>${status}</ErrorCode>\n</Items>\n</PatrolDevice>`

// ---------- 解析工具 ----------

/** 取标签内文本再 Number()：捕获 `[^<]+` 而非手写数字类，正确吃下带负指数的
 *  科学计数法（`1.5e-3`、`-2E+4`）——旧正则 `(-?[\d.eE+]+)` 不含指数负号，
 *  会把 `1.5e-3` 截成 `1.5e` → NaN 或 0。非数字回 0。 */
export const num = (body: string, tag: string): number => {
  const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(body)
  if (!m) return 0
  const v = Number(m[1].trim())
  return Number.isFinite(v) ? v : 0
}

export function parseRealtimeResp(body: string): RealtimeStatus {
  const keys: (keyof RealtimeStatus)[] = [
    'MotionState', 'PosX', 'PosY', 'PosZ', 'AngleYaw', 'Roll', 'Pitch', 'Yaw', 'Speed', 'CurOdom', 'SumOdom',
    'CurRuntime', 'SumRuntime', 'Res', 'X0', 'Y0', 'H', 'Electricity', 'Location', 'RTKState', 'OnDockState',
    'GaitState', 'MotorState', 'ChargeState', 'ControlMode', 'MapUpdateState',
  ]
  const out = {} as RealtimeStatus
  for (const k of keys) out[k] = num(body, k)
  return out
}

export const parseNavTaskResp = (body: string) => ({
  value: num(body, 'Value'),
  errorCode: num(body, 'ErrorCode'),
  errorStatus: num(body, 'ErrorStatus'),
})

export const parseCancelResp = (body: string) => ({ errorCode: num(body, 'ErrorCode') })

export const parseQueryResp = (body: string) => ({
  value: num(body, 'Value'),
  status: num(body, 'Status'),
  errorCode: num(body, 'ErrorCode'),
})

/** 解析 1003 REQ 里的多个 <Items> 导航点（sim 用） */
export function parseNavTaskReq(body: string): NavPoint[] {
  const out: NavPoint[] = []
  const re = /<Items>([\s\S]*?)<\/Items>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const seg = m[1]
    const g = (tag: string) => num(seg, tag)
    out.push({
      MapId: g('MapId'), Value: g('Value'), PosX: g('PosX'), PosY: g('PosY'), PosZ: g('PosZ'),
      AngleYaw: g('AngleYaw'), PointInfo: g('PointInfo'), Gait: g('Gait'), Speed: g('Speed'),
      Manner: g('Manner'), ObsMode: g('ObsMode'), NavMode: g('NavMode'), Terrain: g('Terrain'), Posture: g('Posture'),
    })
  }
  return out
}
