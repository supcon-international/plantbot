// GoRobot 云端仿真 · 行为模型层。一切状态都活在厂商语义里：激光地图像素坐标
// （原点左下角）、deviceId/robotSn 双主键、taskType/workStatus/isPatrolStop 状态位、
// alarmType 数字码。北向（Plantbot）概念在这里一个都不出现——那是 adapter 的事。
// 报文字段名与取值 verbatim 依据 docs/vendors/gosuncn-api.md。

import { randomUUID } from 'node:crypto'

// ---- 激光地图（校园部署）----
export const MAP = {
  mapName: 'campus_laser_0710',
  mapId: 3,
  picWidth: 800,
  picHeight: 440,
  // 该分辨率不会出现在任何 API 响应里 —— GoRobot 不暴露 px↔米 标定，集成方自己量。
  pxPerMeter: 20,
}

export interface LaserPoint {
  X: number
  Y: number
  id: string
  radius: number
}

export interface PatrolLine {
  id: number
  lineNo: string
  lineName: string
  points: LaserPoint[]
}

export const LINES: PatrolLine[] = [
  {
    id: 41,
    lineNo: '1',
    lineName: '中央大道巡逻线',
    points: [
      { X: 400, Y: 76, id: 'P-101', radius: 0 },
      { X: 296, Y: 128, id: 'P-102', radius: 90 },
      { X: 220, Y: 96, id: 'P-103', radius: 45 },
      { X: 160, Y: 68, id: 'P-104', radius: 0 },
      { X: 296, Y: 128, id: 'P-105', radius: 270 },
      { X: 400, Y: 76, id: 'P-106', radius: 180 },
      { X: 508, Y: 92, id: 'P-107', radius: 90 },
      { X: 564, Y: 136, id: 'P-108', radius: 45 },
      { X: 508, Y: 92, id: 'P-109', radius: 270 },
    ],
  },
  {
    id: 42,
    lineNo: '2',
    lineName: '宿舍食堂环线',
    points: [
      { X: 500, Y: 332, id: 'P-201', radius: 0 },
      { X: 400, Y: 324, id: 'P-202', radius: 90 },
      { X: 320, Y: 330, id: 'P-203', radius: 180 },
      { X: 230, Y: 328, id: 'P-204', radius: 270 },
      { X: 320, Y: 330, id: 'P-205', radius: 90 },
      { X: 400, Y: 324, id: 'P-206', radius: 0 },
    ],
  },
]

export const BEACON_POINTS = [
  { name: '大门岗亭', x: 400, y: 84, id: 9001, mapName: MAP.mapName, type: 1 },
  { name: '图书馆入口', x: 400, y: 152, id: 9002, mapName: MAP.mapName, type: 1 },
  { name: '宿舍广场', x: 230, y: 332, id: 9003, mapName: MAP.mapName, type: 1 },
  { name: '充电桩', x: 388, y: 56, id: 9004, mapName: MAP.mapName, type: 2 },
]

const CHARGE_PILE = { X: 388, Y: 56 }

// ---- 检测算法注册表（真实抓取样本 + 本部署自定义 3 条）----
export const DETECTION_REGISTRY = [
  { id: 2, detectionTypeName: '人体闯入检测', detectionType: 1, enableStatus: 1, algorithmDetectType: 10000, detectionCategory: 4, alarmType: 102, needConsult: null, extraParameter: null, needConfirm: null, promptTemplate: null },
  { id: 3, detectionTypeName: '车辆闯入检测', detectionType: 2, enableStatus: 1, algorithmDetectType: 10000, detectionCategory: 4, alarmType: 460, needConsult: null, extraParameter: null, needConfirm: null, promptTemplate: null },
  { id: 19, detectionTypeName: '人员聚集检测', detectionType: 18, enableStatus: 1, algorithmDetectType: 10000, detectionCategory: 4, alarmType: 1015, needConsult: 0, extraParameter: '{"number":5}', needConfirm: null, promptTemplate: null },
  { id: 25, detectionTypeName: '车辆违停检测', detectionType: 24, enableStatus: 1, algorithmDetectType: 360000, detectionCategory: 4, alarmType: 310, needConsult: null, extraParameter: null, needConfirm: null, promptTemplate: null },
  { id: 31, detectionTypeName: '离岗检测', detectionType: 30, enableStatus: 1, algorithmDetectType: 10000, detectionCategory: 4, alarmType: 322, needConsult: 0, extraParameter: null, needConfirm: null, promptTemplate: '图中没有人吗' },
  { id: 35, detectionTypeName: '大模型识别爬围墙', detectionType: 34, enableStatus: 1, algorithmDetectType: null, detectionCategory: 1, alarmType: 314, needConsult: 0, extraParameter: null, needConfirm: 1, promptTemplate: '图中是否有人在爬围墙' },
  { id: 38, detectionTypeName: '大模型识别钓鱼', detectionType: 37, enableStatus: 1, algorithmDetectType: null, detectionCategory: 1, alarmType: 10005, needConsult: 0, extraParameter: null, needConfirm: 1, promptTemplate: '图中是否有人在钓鱼' },
  { id: 46, detectionTypeName: '地面积水检测', detectionType: 46, enableStatus: 1, algorithmDetectType: 690000, detectionCategory: 1, alarmType: 427, needConsult: 0, extraParameter: null, needConfirm: null, promptTemplate: null },
  // —— 本校园部署追加（注册表本就是站点可配置资产；alarmType 走 10012+ 自定义段）——
  { id: 51, detectionTypeName: '大模型识别遗留背包', detectionType: 51, enableStatus: 1, algorithmDetectType: null, detectionCategory: 4, alarmType: 10012, needConsult: 0, extraParameter: null, needConfirm: 1, promptTemplate: '图中是否有无人看管的背包' },
  { id: 52, detectionTypeName: '大模型识别人员跌倒', detectionType: 52, enableStatus: 1, algorithmDetectType: null, detectionCategory: 4, alarmType: 10014, needConsult: 0, extraParameter: null, needConfirm: 1, promptTemplate: '图中是否有人跌倒未起身' },
  { id: 53, detectionTypeName: '电动车占用消防通道检测', detectionType: 53, enableStatus: 1, algorithmDetectType: 260000, detectionCategory: 1, alarmType: 10015, needConsult: 1, extraParameter: null, needConfirm: null, promptTemplate: null },
]

const ALARM_NAMES: Record<number, string> = {
  102: '人体闯入告警',
  315: '陌生人告警',
  310: '车辆违停告警',
  314: '爬围墙告警',
  1015: '人员聚集告警',
  10012: '遗留背包告警',
  10014: '人员跌倒告警',
  10015: '电动车占道告警',
}

export interface AlarmRecord {
  id: number
  uuid: string
  deviceId: number
  deviceSn: string
  deviceName: string
  deviceType: 'robot'
  alarmType: number
  alarmName: string
  alarmLevel: number
  alarmStatus: 0 | 1 | 2 | 3
  alarmValue: string
  alarmBeginTime: string
  alarmEndTime: string
  reliability: number
  credible: boolean
  picUrl: string
  algorithmResult: string
  mapName: string
  x: number
  y: number
  latitude: number
  longitude: number
  address: string
  source: null | 1
  confirmComment?: string
  confirmUsername?: string
  confirmTime?: string
  closeComment?: string
  closeTime?: string
  remindType: 0 | 1
}

export interface CaptureRecord {
  picUrl: string
  captureName: string
  detectValue: string
  captureTime: string
  detectType: string
  pointName: string
  alarm: '0' | '1'
  status: '0' | '1' | '2'
}

export interface RunAlarm {
  deviceId: number
  addTime: string
  code: string
  name: string
  describe: string
  exceType: string
  position: string
  modelPic: string
  deviceName: string
}

export interface SimRobot {
  deviceId: number
  robotSn: string
  robotName: string
  model: 'F2'
  companyName: string
  companyCode: string
  online: 0 | 1
  // 激光地图像素位姿（左下角原点，y 向上）
  x: number
  y: number
  angle: number // 度，0-360
  speedMps: number
  electricity: number
  workStatus: 0 | 1 // 0 自动 / 1 手动
  taskType: 'patrol' | 'watch' | 'charge' | 'standBy'
  stopStatus: 0 | 1
  isPatrolStop: 0 | 1
  ifChargeTask: 0 | 1
  chargeConnectMode: 0 | 1 | 2
  mileage: number // 米
  currentMileage: number
  duration: number // 分钟
  currentDuration: number
  temperature: number
  humidity: number
  decibel: number
  voltage: number
  batteryTemp: number
  ptz: { hangle: number; vangle: number; zoom: number; focus: number }
  headLightStatus: 0 | 1
  line: PatrolLine
  planName: string
  patrolPlanId: number
  leg: number
  dwellUntil: number
  navTask?: { X: number; Y: number; actionId?: number }
  manualVel?: { vx: number; vy: number; until: number }
  captures: CaptureRecord[]
  lastCaptureAt: number
}

const fmt = (t: number) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const minioPic = (bucket: string) => `/robotservice/minioservice/robotv2/${bucket}/${randomUUID().replace(/-/g, '')}.jpeg`

export class GoRobotFleet {
  robots: SimRobot[]
  alarms: AlarmRecord[] = []
  private alarmSeq = 75_000
  onAlarm?: (a: AlarmRecord) => void
  onRunAlarm?: (a: RunAlarm) => void
  onCapture?: (r: SimRobot, c: CaptureRecord & { deviceId: number; deviceCode: string }) => void

  constructor() {
    this.robots = [
      this.mkRobot(591, 'F2230204117', '中央大道巡逻一号', LINES[0], 87, 41),
      this.mkRobot(592, 'F2230204118', '宿舍食堂巡逻二号', LINES[1], 72, 42),
    ]
    setInterval(() => this.tick(0.25), 250)
    // 巡检告警与本体告警各自的泊松节拍
    for (const [i, r] of this.robots.entries()) this.scheduleAlarm(r, 45_000 + i * 60_000)
    this.scheduleRunAlarm()
  }

  private mkRobot(deviceId: number, sn: string, name: string, line: PatrolLine, batt: number, planId: number): SimRobot {
    return {
      deviceId,
      robotSn: sn,
      robotName: name,
      model: 'F2',
      companyName: '校园东区保卫处',
      companyCode: 'campus-east',
      online: 1,
      x: line.points[0].X,
      y: line.points[0].Y,
      angle: 0,
      speedMps: 0,
      electricity: batt,
      workStatus: 0,
      taskType: 'patrol',
      stopStatus: 0,
      isPatrolStop: 0,
      ifChargeTask: 0,
      chargeConnectMode: 0,
      mileage: 218_640 + deviceId * 137,
      currentMileage: 0,
      duration: 42_120 + deviceId * 61,
      currentDuration: 0,
      temperature: 26.5,
      humidity: 58,
      decibel: 48,
      voltage: 49.6,
      batteryTemp: 33,
      ptz: { hangle: 0, vangle: 0, zoom: 1, focus: 0 },
      headLightStatus: 0,
      line,
      planName: line.lineName.replace('线', '计划'),
      patrolPlanId: planId,
      leg: 0,
      dwellUntil: 0,
      captures: [],
      lastCaptureAt: 0,
    }
  }

  byDeviceId(id: number) {
    return this.robots.find((r) => r.deviceId === id)
  }
  bySn(sn: string) {
    return this.robots.find((r) => r.robotSn === sn)
  }

  // ---------- 指令入口（HTTP 层调用，均为厂商语义） ----------

  navigateToPoint(r: SimRobot, X: number, Y: number, actionId?: number): boolean {
    if (r.stopStatus) return false
    r.navTask = { X, Y, actionId }
    r.ifChargeTask = 0
    r.chargeConnectMode = 0
    return true
  }

  oneKeyCharge(r: SimRobot, on: boolean) {
    r.ifChargeTask = on ? 1 : 0
    if (on) {
      r.navTask = { X: CHARGE_PILE.X, Y: CHARGE_PILE.Y }
      r.taskType = 'charge'
    } else {
      r.chargeConnectMode = 0
      if (r.taskType === 'charge') r.taskType = 'patrol'
    }
  }

  moveControl(r: SimRobot, action: number, speed: number) {
    if (r.workStatus !== 1) return false // 手动模式前置，与真机一致
    const v = Math.min(1.2, 0.25 * (speed || 3))
    const dir: Record<number, [number, number]> = {
      0: [0, 0], 1: [1, 0], 2: [-1, 0], 4: [0, 1], 5: [1, 1], 6: [-1, 1], 8: [0, -1], 9: [1, -1], 10: [-1, -1],
    }
    const d = dir[action]
    if (!d) return false
    // 机器人本体系：前=朝向方向。转全局向量。
    const rad = (r.angle * Math.PI) / 180
    const fx = Math.cos(rad)
    const fy = Math.sin(rad)
    const lx = -fy
    const ly = fx
    r.manualVel = { vx: (fx * d[0] + lx * d[1]) * v, vy: (fy * d[0] + ly * d[1]) * v, until: Date.now() + 350 }
    return true
  }

  ptzControl(r: SimRobot, unCtrlValue: number, value: number) {
    const step = Math.max(1, value / 10)
    const p = r.ptz
    if (unCtrlValue === 1) p.vangle = Math.min(90, p.vangle + step)
    else if (unCtrlValue === 5) p.vangle = Math.max(-30, p.vangle - step)
    else if (unCtrlValue === 3) p.hangle = (p.hangle + step) % 360
    else if (unCtrlValue === 7) p.hangle = (p.hangle - step + 360) % 360
    else if (unCtrlValue === 9) p.zoom = Math.min(25, p.zoom + step / 5)
    else if (unCtrlValue === 10) p.zoom = Math.max(1, p.zoom - step / 5)
    else if (unCtrlValue === 19) p.focus += step
    else if (unCtrlValue === 20) p.focus -= step
    else if (unCtrlValue === 12) Object.assign(p, { hangle: 0, vangle: 0, zoom: 1, focus: 0 })
  }

  // ---------- 主循环 ----------

  private tick(dt: number) {
    const now = Date.now()
    for (const r of this.robots) {
      r.currentDuration += dt / 60
      r.duration += dt / 60
      // 环境量漫步
      r.temperature = 24.5 + 3.5 * Math.sin(now / 900_000 + r.deviceId) + Math.random() * 0.3
      r.humidity = 58 + 12 * Math.sin(now / 1_300_000 + r.deviceId * 2) + Math.random()
      r.decibel = 48 + 9 * Math.sin(now / 240_000 + r.deviceId) + Math.random() * 2

      if (r.stopStatus) {
        r.speedMps = 0
        continue
      }

      // 手动摇杆（robotMoveControl 350ms 意图窗）
      if (r.manualVel && now < r.manualVel.until) {
        const pxV = r.manualVel.vx * MAP.pxPerMeter
        const pyV = r.manualVel.vy * MAP.pxPerMeter
        r.x = Math.max(4, Math.min(MAP.picWidth - 4, r.x + pxV * dt))
        r.y = Math.max(4, Math.min(MAP.picHeight - 4, r.y + pyV * dt))
        r.speedMps = Math.hypot(r.manualVel.vx, r.manualVel.vy)
        this.drain(r, dt)
        continue
      }
      if (r.workStatus === 1 && !r.navTask) {
        r.speedMps = 0
        continue // 手动模式下不自动巡逻
      }
      if (r.isPatrolStop) {
        r.speedMps = 0
        continue
      }

      // 充电中
      if (r.chargeConnectMode === 1) {
        r.electricity = Math.min(100, r.electricity + dt * 0.5)
        r.speedMps = 0
        if (r.electricity >= 96 && !r.navTask) {
          // 充满自动回巡逻（部署配置行为）
          r.chargeConnectMode = 0
          r.ifChargeTask = 0
          r.taskType = 'patrol'
        }
        continue
      }

      // 低电自动回充
      if (r.electricity < 18 && !r.ifChargeTask) this.oneKeyCharge(r, true)

      const target = r.navTask ?? (now < r.dwellUntil ? undefined : r.line.points[(r.leg + 1) % r.line.points.length])
      if (!target) {
        r.speedMps = 0 // 点位停留
        continue
      }
      const dx = target.X - r.x
      const dy = target.Y - r.y
      const dist = Math.hypot(dx, dy)
      const pxSpeed = 0.85 * MAP.pxPerMeter
      if (dist < 3) {
        if (r.navTask) {
          const t = r.navTask
          r.navTask = undefined
          if (r.ifChargeTask) {
            r.chargeConnectMode = 1
            r.taskType = 'charge'
          } else {
            if (t.actionId) this.capture(r, '一键到达动作', '定点抓拍')
            r.taskType = r.workStatus === 1 ? 'standBy' : 'patrol'
          }
        } else {
          r.leg = (r.leg + 1) % r.line.points.length
          r.dwellUntil = now + 6000 + Math.random() * 7000
          this.capture(r, r.line.points[r.leg].id, '定点抓拍')
        }
        r.speedMps = 0
      } else {
        const step = Math.min(pxSpeed * dt, dist)
        r.x += (dx / dist) * step
        r.y += (dy / dist) * step
        r.angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
        r.speedMps = 0.85
        r.mileage += step / MAP.pxPerMeter
        r.currentMileage += step / MAP.pxPerMeter
        this.drain(r, dt)
      }
    }
  }

  private drain(r: SimRobot, dt: number) {
    r.electricity = Math.max(1, r.electricity - dt * 0.012)
  }

  private capture(r: SimRobot, pointName: string, detectType: string) {
    const now = Date.now()
    if (now - r.lastCaptureAt < 4000) return
    r.lastCaptureAt = now
    const rec: CaptureRecord = {
      picUrl: minioPic('patrolSnap'),
      captureName: pointName,
      detectValue: '',
      captureTime: fmt(now),
      detectType,
      pointName,
      alarm: '0',
      status: '2',
    }
    r.captures.unshift(rec)
    if (r.captures.length > 16) r.captures.pop()
    this.onCapture?.(r, { ...rec, deviceId: r.deviceId, deviceCode: r.robotSn })
  }

  // ---------- 告警生成 ----------

  private scheduleAlarm(r: SimRobot, initial?: number) {
    // GOSUNCN_SIM_ALARM_MS：测试用的固定告警节拍（默认 90–240s 泊松）
    const fixed = Number(process.env.GOSUNCN_SIM_ALARM_MS ?? 0)
    const delay = fixed > 0 ? fixed : (initial ?? 90_000 + Math.random() * 150_000)
    setTimeout(() => {
      if (r.online) this.emitAlarm(r)
      this.scheduleAlarm(r)
    }, delay)
  }

  private emitAlarm(r: SimRobot) {
    // 权重按点位环境：主干道多背包/聚集/陌生人，宿舍区多电动车/聚集
    const pool =
      r.line.id === 41
        ? [10012, 10012, 10012, 1015, 315, 315, 314, 10014]
        : [10015, 10015, 1015, 1015, 315, 10012]
    const alarmType = pool[Math.floor(Math.random() * pool.length)]
    const level = alarmType === 10014 || alarmType === 10012 ? 1 : alarmType === 315 || alarmType === 314 ? 2 : 3
    const a: AlarmRecord = {
      id: this.alarmSeq++,
      uuid: randomUUID(),
      deviceId: r.deviceId,
      deviceSn: r.robotSn,
      deviceName: r.robotName,
      deviceType: 'robot',
      alarmType,
      alarmName: ALARM_NAMES[alarmType] ?? `告警${alarmType}`,
      alarmLevel: level,
      alarmStatus: 0,
      alarmValue: alarmType === 1015 ? String(5 + Math.floor(Math.random() * 6)) : '0.0',
      alarmBeginTime: fmt(Date.now()),
      alarmEndTime: fmt(Date.now()),
      reliability: +(0.58 + Math.random() * 0.38).toFixed(2),
      credible: Math.random() > 0.25,
      picUrl: minioPic('messy'),
      algorithmResult: minioPic('alarmAnnotation'),
      mapName: MAP.mapName,
      x: Math.round(r.x),
      y: Math.round(r.y),
      latitude: 31.302 + r.y / 111_320 / MAP.pxPerMeter,
      longitude: 121.5 + r.x / 111_320 / MAP.pxPerMeter,
      address: '校园东区',
      source: null,
      remindType: 1,
    }
    this.alarms.unshift(a)
    if (this.alarms.length > 200) this.alarms.pop()
    this.onAlarm?.(a)
  }

  private scheduleRunAlarm() {
    setTimeout(() => {
      const r = this.robots[Math.floor(Math.random() * this.robots.length)]
      const a: RunAlarm = {
        deviceId: r.deviceId,
        addTime: fmt(Date.now()),
        code: '50101',
        name: '位置丢失',
        describe: '原因分析：1、机器人激光不匹配环境，无法确认自己的位置。解决方案：1、手动初始化机器人位置。',
        exceType: '导航',
        position: `{'x':'${Math.round(r.x)}','y':'${Math.round(r.y)}','mapName':'${MAP.mapName}'}`,
        modelPic: '/robotservice/file/defaultimg/img_robot-F2.png',
        deviceName: r.robotName,
      }
      this.onRunAlarm?.(a)
      this.scheduleRunAlarm()
    }, 480_000 + Math.random() * 600_000)
  }

  // ---------- findRobotStatus 全量视图 ----------

  statusOf(r: SimRobot) {
    return {
      alarmLightStatus: 0,
      alphaRay: '0.0',
      alphaRay2: '0.0',
      angle: +r.angle.toFixed(1),
      atmPressure: '101.2',
      batteryTemp: +(r.batteryTemp + Math.random() * 0.4).toFixed(1),
      betaRay: '0.0',
      betaRay2: '0.0',
      camera: { cameraFocus: r.ptz.focus, cameraZoom: r.ptz.zoom },
      cameraLightStatus: 0,
      chargeConnectMode: r.chargeConnectMode,
      co2: String(Math.round(415_000 + Math.random() * 6000)),
      current: +(3.8 + Math.random() * 0.6).toFixed(2),
      currentDuration: Math.round(r.currentDuration),
      currentMileage: Math.round(r.currentMileage),
      decibel: r.decibel.toFixed(1),
      duration: Math.round(r.duration),
      electricity: Math.round(r.electricity),
      exceptionCode: '',
      frequency: '50.0',
      gammaRay: '0.0',
      gpsGixedSolution: '0',
      headLightStatus: r.headLightStatus,
      humidity: r.humidity.toFixed(1),
      humidityMid: (r.humidity + 1.2).toFixed(1),
      humidityUp: (r.humidity + 2.1).toFixed(1),
      ifChargeTask: r.ifChargeTask,
      isPatrolStop: r.isPatrolStop,
      isTalking: 0,
      latitude: 31.302,
      latitudeWGS84: 31.302,
      lift: { height: 0, robotCode: r.robotSn },
      lineCode: r.line.lineNo,
      longitude: 121.5,
      longitudeWGS84: 121.5,
      mapName: MAP.mapName,
      mileage: Math.round(r.mileage),
      model: 'F2',
      nASL: 6.2,
      name: r.robotName,
      neutronRay: '0.0',
      online: r.online,
      orientation: +((r.angle * Math.PI) / 180).toFixed(3),
      ozoneSwitch: 0,
      patrolPlanId: r.patrolPlanId,
      patrolStatus: r.taskType === 'patrol' && !r.isPatrolStop ? 1 : 0,
      planName: r.planName,
      pm10: '31',
      pm25: '18',
      pointName: r.line.points[r.leg].id,
      poisonGas: '0',
      power: +(190 + Math.random() * 30).toFixed(1),
      powerAnomaly: 0,
      ptz: { distance: '0', hangle: r.ptz.hangle, vangle: r.ptz.vangle, robotCode: r.robotSn },
      robotSn: r.robotSn,
      sH2S: '0',
      sSO2: '0',
      sensorData: JSON.stringify({
        SensorStatus: [
          { Data: [{ AlarmType: 201, Name: '温度', Threshold: 0.0, Type: 1, Unit: '℃', Value: +r.temperature.toFixed(1) }], Index: 2 },
          { Data: [{ AlarmType: 204, Name: 'PM2.5', Threshold: 45.0, Type: 13, Unit: 'μg/m³', Value: 18.0 }], Index: 1 },
        ],
      }),
      speed: +r.speedMps.toFixed(2),
      stopStatus: r.stopStatus,
      taskType: r.taskType,
      temperature: r.temperature.toFixed(2),
      temperatureMid: (r.temperature + 0.6).toFixed(2),
      temperatureUp: (r.temperature + 1.1).toFixed(2),
      useLaserToAerial: false,
      useLaserToGPS: false,
      uvSwitch: 0,
      voltage: +(r.voltage + Math.random() * 0.3).toFixed(2),
      workModel: r.workStatus,
      xPosition: Math.round(r.x),
      xPositionAerial: 0,
      yPosition: Math.round(r.y),
      yPositionAerial: 0,
    }
  }

  /** WS RobotStatus 增量帧的候选字段（样本帧字段集） */
  wsStatusOf(r: SimRobot) {
    return {
      angle: +r.angle.toFixed(1),
      latitude: 31.302,
      longitude: 121.5,
      mapName: MAP.mapName,
      robotSn: r.robotSn,
      speed: +r.speedMps.toFixed(2),
      xPosition: Math.round(r.x),
      yPosition: Math.round(r.y),
      ifChargeTask: r.ifChargeTask,
      electricity: Math.round(r.electricity),
      voltage: +r.voltage.toFixed(2),
      batteryTemp: Math.round(r.batteryTemp),
      longitudeWGS84: 121.5,
      latitudeWGS84: 31.302,
      stopStatus: r.stopStatus,
      mileage: Math.round(r.mileage),
      currentMileage: Math.round(r.currentMileage),
      duration: Math.round(r.duration),
      currentDuration: Math.round(r.currentDuration),
      isPatrolStop: r.isPatrolStop,
      planName: r.planName,
      patrolPlanId: r.patrolPlanId,
      temperature: r.temperature.toFixed(2),
      humidity: r.humidity.toFixed(2),
    } as Record<string, unknown>
  }
}
