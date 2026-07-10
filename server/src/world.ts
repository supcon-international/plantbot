// World — the per-site runtime. Each site gets one instance owning its
// fleet, nav sim, mission engine, detection rules/events, custom event
// vocabulary and the order queue for externally-adapted (integration API)
// robots. Nothing in here is module-global: multi-site isolation.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type RobotSpec,
  type PayloadSpec,
  type SiteInfo,
  type Severity,
  type DetectionModel,
  type MissionStep,
  type ActionType,
  type EventTypeDef,
  BUILTIN_MODELS,
  ROBOT_CATALOG,
  PAYLOAD_CATALOG,
  MODEL_CODE,
  UNIT_COLORS,
} from './fleet.js'
import type { SiteDef } from './sites.js'
import { createPlanner, type Planner } from './planner.js'
import { grabFrame } from './frames.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUB = process.env.PUBLIC_BASE ?? ''
export const SNAP_DIR = join(ROOT, 'data', 'snapshots')
mkdirSync(SNAP_DIR, { recursive: true })

// ---------- telemetry ----------

export interface JointTemp {
  name: string
  c: number
}

export interface Telemetry {
  id: string
  x: number
  z: number
  heading: number
  speed: number
  battery: number
  rssi: number
  latency: number
  mode: 'idle' | 'navigating' | 'executing' | 'teleop' | 'charging' | 'offline'
  odoKm: number
  gait: string
  joints: JointTemp[]
  payloadHealth: Record<string, 'ok' | 'warn'>
  missionId?: string
  missionName?: string
  targetWp?: string
  path: { x: number; z: number }[]
  pathRemaining: number
}

const QUAD_JOINTS = ['FL·hip', 'FL·knee', 'FR·hip', 'FR·knee', 'HL·hip', 'HL·knee', 'HR·hip', 'HR·knee']
const UGV_JOINTS = ['FL·drive', 'FR·drive', 'RL·drive', 'RR·drive', 'ESC·left', 'ESC·right']

// ---------- detections ----------

export interface DetectionRule {
  id: string
  name: string
  model: DetectionModel
  source: string
  sourceName: string
  zone: string
  threshold: number // min confidence 0..1
  severity: Severity
  enabled: boolean
  robotId?: string
  builtin: boolean
  lastFiredAt?: number
  firedCount: number
}

export interface DetectionEvent {
  id: string
  ts: number
  type: DetectionModel
  ruleId: string
  label: string
  detail: string
  severity: Severity
  source: string
  sourceName: string
  robotId?: string
  zone: string
  confidence: number
  snapshot?: string
  acked: boolean
  x: number
  z: number
}

const DETAILS: Record<string, () => string> = {
  person: () => `Unbadged person detected, dwell ${(4 + Math.random() * 8).toFixed(0)}s · tracking on`,
  smoking: () => 'Cigarette signature, confidence high · zone is ATEX-rated',
  thermal: () => `ΔT +${(9 + Math.random() * 9).toFixed(1)} °C vs. baseline · plume widening`,
  ogi: () => `CH₄ plume candidate · column density ${(220 + Math.random() * 400).toFixed(0)} ppm·m`,
  gauge: () => `Pressure ${(5.8 + Math.random() * 1.2).toFixed(1)} bar — within nominal band`,
  ppe: () => `${5 + Math.floor(Math.random() * 3)}/8 operators in frame, all compliant`,
  motion: () => 'Filtered as wildlife / vegetation sway · no action',
  acoustic: () => `38 kHz band energy +${(6 + Math.random() * 6).toFixed(1)} dB at bushing`,
}

const WEIGHTS: Record<string, number> = {
  gauge: 2.2,
  ppe: 1.7,
  motion: 1.8,
  thermal: 1.3,
  ogi: 1.1,
  acoustic: 0.9,
  person: 1.1,
  smoking: 0.5,
}

// ---------- missions ----------

export interface MissionResult {
  ts: number
  stepIdx: number
  waypointId: string
  action: ActionType
  ok: boolean
  note: string
  snapshot?: string
}

export interface Mission {
  id: string
  name: string
  priority: 1 | 2 | 3
  requestedRobot: string
  robotId?: string
  recurring: boolean
  status: 'queued' | 'active' | 'done' | 'failed' | 'aborted'
  steps: MissionStep[]
  currentStep: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  results: MissionResult[]
  progress: number
}

export interface NavState {
  x: number
  z: number
  heading: number
  speed: number
  state: 'idle' | 'navigating' | 'executing' | 'teleop' | 'charging'
  missionId?: string
  targetWp?: string
  path: { x: number; z: number }[]
  pathRemaining: number
  battery: number
  odo: number
  actionLeft: number
  actionIdx: number
  teleopTarget?: { x: number; z: number }
  onResult?: (m: Mission, r: MissionResult) => void
}

/** VDA5050-order-like unit of work queued for an external (adapter) robot */
export interface AdapterOrder {
  id: string
  robotId: string
  kind: 'goto' | 'mission'
  payload: { x?: number; z?: number; missionId?: string; name?: string; steps?: MissionStep[] }
  state: 'pending' | 'acked' | 'done' | 'failed'
  createdAt: number
  updatedAt: number
}

/** latest adapter-reported state for an external robot */
export interface ExternalState {
  lastSeen: number
  mode?: string
  errors?: string[]
}

const ACTION_NOTES: Record<ActionType, () => { ok: boolean; note: string }> = {
  capture_photo: () => ({ ok: true, note: 'Frame archived · exposure auto' }),
  gauge_read: () => ({
    ok: Math.random() > 0.06,
    note: `Pressure ${(5.7 + Math.random() * 1.4).toFixed(1)} bar — nominal band`,
  }),
  thermal_scan: () => {
    const dt = 4 + Math.random() * 14
    return { ok: dt < 14, note: `Max ΔT +${dt.toFixed(1)} °C vs. baseline` }
  },
  ogi_scan: () => {
    const hit = Math.random() < 0.18
    return { ok: !hit, note: hit ? 'Plume candidate — flagged for TDLAS quant' : 'No fugitive emission detected' }
  },
  gas_sample: () => ({
    ok: true,
    note: `CH₄ ${(1.9 + Math.random() * 1.6).toFixed(1)} ppm · H₂S 0.0 ppm`,
  }),
  acoustic_scan: () => {
    const db = 4 + Math.random() * 10
    return { ok: db < 11, note: `38 kHz band +${db.toFixed(1)} dB re baseline` }
  },
  wait: () => ({ ok: true, note: 'Hold complete' }),
}

const ACTION_SNAPSHOT_SOURCE: Partial<Record<ActionType, (r: RobotSpec) => string | undefined>> = {
  capture_photo: (r) => r.payloads.find((p) => p.kind === 'camera')?.stream,
  thermal_scan: (r) => r.payloads.find((p) => p.kind === 'thermal')?.stream,
  ogi_scan: (r) => r.payloads.find((p) => p.kind === 'ogi')?.stream,
}

const recurCooldown = () => 35_000 + Math.random() * 55_000
const EXTERNAL_STALE_MS = 20_000
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, info: 2, low: 3 }

// ============================================================ World

export class World {
  readonly id: string
  readonly def: SiteDef
  site: SiteInfo
  robots: RobotSpec[]
  cameras: SiteDef['cameras']
  waypoints: SiteDef['waypoints']
  zones: SiteDef['zones']
  buildings: SiteDef['buildings']
  planner: Planner
  nav = new Map<string, NavState>()
  missions: Mission[] = []
  rules: DetectionRule[] = []
  events: DetectionEvent[] = []
  eventTypes: EventTypeDef[] = []
  orders: AdapterOrder[] = []
  externals = new Map<string, ExternalState>() // robotId -> adapter state
  onResult?: (m: Mission, r: MissionResult) => void

  private wpById: Map<string, SiteDef['waypoints'][number]>
  private ruleSeq = 1
  private evSeq = 1
  private missionSeq = 100
  private orderSeq = 1

  constructor(def: SiteDef) {
    this.id = def.id
    this.def = def
    this.site = {
      id: def.id,
      name: def.name,
      operator: def.operator,
      bounds: def.bounds,
      map: def.map,
    }
    this.robots = def.robots.map((r) => ({ ...r, adapter: 'sim' as const, payloads: r.payloads.map((p) => ({ ...p })) }))
    this.cameras = def.cameras
    this.waypoints = def.waypoints
    this.zones = def.zones
    this.buildings = def.buildings
    this.planner = createPlanner(def.planner)
    this.wpById = new Map(def.waypoints.map((w) => [w.id, w]))
    this.eventTypes = BUILTIN_MODELS.map((m) => ({ id: m, label: m, severity: 'info' as Severity, builtin: true }))
    for (const r of this.robots) this.initNav(r)
    for (const s of def.ruleSeeds) this.addRule({ ...s, enabled: true, builtin: true })
  }

  // ---------- fleet ----------

  initNav(r: RobotSpec) {
    this.nav.set(r.id, {
      x: r.home.x,
      z: r.home.z,
      heading: 0,
      speed: 0,
      state: 'idle',
      path: [],
      pathRemaining: 0,
      battery: r.batteryStart,
      odo: 10 + Math.random() * 8,
      actionLeft: 0,
      actionIdx: 0,
    })
  }

  registerRobot(input: {
    model: string
    callsign?: string
    ip: string
    protocol?: string
    home: { x: number; z: number }
    payloadIds: string[]
  }): RobotSpec | null {
    const spec = ROBOT_CATALOG.find((m) => m.model === input.model)
    if (!spec) return null
    const code = MODEL_CODE[spec.model] ?? 'UNIT'
    const siblings = this.robots.filter((r) => r.model === spec.model).length
    const seq = String(siblings + 1).padStart(2, '0')
    const base = code.toLowerCase().replace(/[^a-z0-9]/g, '')
    let id = `${base}-${seq}`
    while (this.robots.some((r) => r.id === id))
      id = `${base}-${String(Number(id.split('-')[1]) + 1).padStart(2, '0')}`
    const payloads = input.payloadIds
      .map((pid) => PAYLOAD_CATALOG.find((p) => p.id === pid))
      .filter((p): p is PayloadSpec => !!p)
      .map((p) => ({ ...p }))
    const robot: RobotSpec = {
      id,
      callsign: input.callsign?.trim() || `${spec.vendor.startsWith('DEEP') ? 'JY·' : ''}${code}-${seq}`,
      vendor: spec.vendor,
      model: spec.model,
      family: spec.family,
      urdf: spec.urdf,
      serial: `${spec.vendor.startsWith('DEEP') ? 'DR' : 'CP'}-${code}-2607-${String(1000 + Math.floor(Math.random() * 9000)).slice(0, 4)}`,
      firmware: spec.firmware,
      ip: input.ip,
      protocol: input.protocol || spec.protocol,
      massKg: spec.massKg,
      ipRating: spec.ipRating,
      maxSpeed: spec.maxSpeed,
      enduranceMin: spec.enduranceMin,
      payloads,
      batteryStart: Math.round(55 + Math.random() * 35),
      color: UNIT_COLORS[this.robots.length % UNIT_COLORS.length],
      home: input.home,
      adapter: 'sim',
    }
    this.robots.push(robot)
    this.initNav(robot)
    const s = this.nav.get(robot.id)!
    s.onResult = (m, res) => this.onResult?.(m, res)
    return robot
  }

  /** integration API: register/refresh an external (adapter-driven) unit */
  registerExternal(input: {
    serial: string
    model: string
    vendor?: string
    callsign?: string
    family?: 'quadruped' | 'ugv'
    level: 'state-only' | 'dispatchable'
    ip?: string
    protocol?: string
    home?: { x: number; z: number }
    streams?: { id: string; name: string; kind?: PayloadSpec['kind']; url?: string }[]
  }): RobotSpec {
    const id = `ext-${input.serial.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const catalog = ROBOT_CATALOG.find((m) => m.model === input.model)
    const existing = this.robots.find((r) => r.id === id)
    const payloads: PayloadSpec[] = (input.streams ?? []).map((s, i) => ({
      id: s.id || `stream-${i + 1}`,
      name: s.name,
      kind: s.kind ?? 'camera',
      model: 'external stream',
      stream: s.id,
      file: s.url, // adapter-hosted HLS/MP4 URL if any
      detail: 'Adapter-published channel',
    }))
    const home = input.home ?? { x: this.site.bounds.x[0] + 2, z: this.site.bounds.z[0] + 2 }
    const robot: RobotSpec = {
      id,
      callsign: input.callsign ?? input.serial,
      vendor: input.vendor ?? catalog?.vendor ?? 'External adapter',
      model: input.model,
      family: input.family ?? catalog?.family ?? 'ugv',
      urdf: catalog?.urdf ?? '',
      serial: input.serial,
      firmware: 'adapter',
      ip: input.ip ?? '—',
      protocol: input.protocol ?? 'Integration API v1 (VDA5050-style)',
      massKg: catalog?.massKg ?? 0,
      ipRating: catalog?.ipRating ?? '—',
      maxSpeed: catalog?.maxSpeed ?? 1.5,
      enduranceMin: catalog?.enduranceMin ?? 0,
      payloads,
      batteryStart: 100,
      color: UNIT_COLORS[this.robots.length % UNIT_COLORS.length],
      home,
      adapter: 'external',
      integrationLevel: input.level,
    }
    if (existing) {
      Object.assign(existing, robot, { id: existing.id })
      this.externals.get(id)!.lastSeen = Date.now()
      return existing
    }
    this.robots.push(robot)
    this.initNav(robot)
    this.externals.set(id, { lastSeen: Date.now() })
    return robot
  }

  removeExternal(id: string): boolean {
    const i = this.robots.findIndex((r) => r.id === id && r.adapter === 'external')
    if (i < 0) return false
    this.robots.splice(i, 1)
    this.nav.delete(id)
    this.externals.delete(id)
    this.orders = this.orders.filter((o) => o.robotId !== id)
    return true
  }

  /** integration API: adapter posts current state (doubles as heartbeat) */
  ingestState(
    robotId: string,
    s: { x?: number; z?: number; heading?: number; speed?: number; battery?: number; mode?: string; errors?: string[] },
  ): boolean {
    const ext = this.externals.get(robotId)
    const nav = this.nav.get(robotId)
    if (!ext || !nav) return false
    ext.lastSeen = Date.now()
    ext.mode = s.mode
    ext.errors = s.errors
    if (typeof s.x === 'number') nav.x = s.x
    if (typeof s.z === 'number') nav.z = s.z
    if (typeof s.heading === 'number') nav.heading = s.heading
    if (typeof s.speed === 'number') nav.speed = s.speed
    if (typeof s.battery === 'number') nav.battery = Math.max(0, Math.min(100, s.battery))
    return true
  }

  installPayload(robotId: string, payloadId: string): PayloadSpec | null {
    const robot = this.robots.find((r) => r.id === robotId)
    const item = PAYLOAD_CATALOG.find((p) => p.id === payloadId)
    if (!robot || !item) return null
    let pid = item.id
    let n = 2
    while (robot.payloads.some((p) => p.id === pid)) pid = `${item.id}-${n++}`
    const inst = { ...item, id: pid }
    robot.payloads.push(inst)
    return inst
  }

  removePayload(robotId: string, payloadId: string): boolean {
    const robot = this.robots.find((r) => r.id === robotId)
    if (!robot) return false
    const i = robot.payloads.findIndex((p) => p.id === payloadId)
    if (i < 0) return false
    robot.payloads.splice(i, 1)
    return true
  }

  // ---------- rules ----------

  private addRule(r: Omit<DetectionRule, 'id' | 'firedCount'>) {
    const rule: DetectionRule = { ...r, id: `RL-${String(this.ruleSeq++).padStart(2, '0')}`, firedCount: 0 }
    this.rules.push(rule)
    return rule
  }

  createRule(input: {
    name: string
    model: DetectionModel
    source: string
    sourceName?: string
    zone?: string
    threshold?: number
    severity?: Severity
    robotId?: string
  }) {
    return this.addRule({
      name: input.name,
      model: input.model,
      source: input.source,
      sourceName: input.sourceName ?? input.source,
      zone: input.zone ?? 'Site-wide',
      threshold: input.threshold ?? 0.6,
      severity: input.severity ?? 'info',
      enabled: true,
      robotId: input.robotId,
      builtin: false,
    })
  }

  patchRule(id: string, patch: Partial<Pick<DetectionRule, 'enabled' | 'threshold' | 'severity' | 'name'>>) {
    const r = this.rules.find((x) => x.id === id)
    if (!r) return undefined
    Object.assign(r, patch)
    return r
  }

  deleteRule(id: string) {
    const i = this.rules.findIndex((x) => x.id === id && !x.builtin)
    if (i < 0) return false
    this.rules.splice(i, 1)
    return true
  }

  // ---------- custom event vocabulary ----------

  addEventType(input: { id: string; label: string; severity?: Severity; detail?: string }): EventTypeDef | null {
    const id = input.id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32)
    if (!id || this.eventTypes.some((t) => t.id === id)) return null
    const t: EventTypeDef = { id, label: input.label || id, severity: input.severity ?? 'info', detail: input.detail, builtin: false }
    this.eventTypes.push(t)
    return t
  }

  deleteEventType(id: string): boolean {
    const i = this.eventTypes.findIndex((t) => t.id === id && !t.builtin)
    if (i < 0) return false
    this.eventTypes.splice(i, 1)
    return true
  }

  // ---------- events ----------

  robotPosition(id: string) {
    const s = this.nav.get(id)
    return s ? { x: s.x, z: s.z } : { x: 0, z: 0 }
  }

  private pickRule(): DetectionRule | undefined {
    const enabled = this.rules.filter((r) => r.enabled)
    if (!enabled.length) return undefined
    const total = enabled.reduce((a, r) => a + (WEIGHTS[r.model] ?? 1), 0)
    let x = Math.random() * total
    for (const r of enabled) {
      x -= WEIGHTS[r.model] ?? 1
      if (x <= 0) return r
    }
    return enabled[0]
  }

  async generateEvent(rule?: DetectionRule, ts = Date.now()): Promise<DetectionEvent | null> {
    const r = rule ?? this.pickRule()
    if (!r) return null
    const id = `EV-${String(this.evSeq++).padStart(4, '0')}`
    const side = Math.random() > 0.5 ? 1 : -1
    const bx = this.site.bounds.x
    const bz = this.site.bounds.z
    const pos = r.robotId
      ? this.robotPosition(r.robotId)
      : {
          x: bx[0] + 3 + Math.random() * (bx[1] - bx[0] - 6),
          z: side * ((bz[1] - 1.2) * (0.45 + Math.random() * 0.45)),
        }
    const confidence = +(r.threshold + Math.random() * (1 - r.threshold) * 0.9).toFixed(2)
    const typeDef = this.eventTypes.find((t) => t.id === r.model)

    const ev: DetectionEvent = {
      id,
      ts,
      type: r.model,
      ruleId: r.id,
      label: r.name,
      detail: DETAILS[r.model]?.() ?? typeDef?.detail ?? `${typeDef?.label ?? r.model} detection`,
      severity: r.severity,
      source: r.source,
      sourceName: r.sourceName,
      robotId: r.robotId,
      zone: r.zone,
      confidence,
      acked: false,
      x: +pos.x.toFixed(2),
      z: +pos.z.toFixed(2),
    }
    r.firedCount++
    r.lastFiredAt = ts

    const frame = await grabFrame(r.source)
    if (frame) {
      const file = `${this.id}_${id}-${ts.toString(36)}.jpg`
      writeFileSync(join(SNAP_DIR, file), frame)
      ev.snapshot = `${PUB}/api/snapshots/${file}`
    }

    this.pushEvent(ev)
    return ev
  }

  /** integration API: external system pushes a custom event */
  ingestEvent(input: {
    type: string
    label?: string
    detail?: string
    severity?: Severity
    x?: number
    z?: number
    robotId?: string
    sourceName?: string
    snapshotUrl?: string
    confidence?: number
    ts?: number
  }): DetectionEvent | null {
    const typeDef = this.eventTypes.find((t) => t.id === input.type)
    if (!typeDef) return null
    const pos = input.robotId ? this.robotPosition(input.robotId) : { x: input.x ?? 0, z: input.z ?? 0 }
    const ev: DetectionEvent = {
      id: `EV-${String(this.evSeq++).padStart(4, '0')}`,
      ts: input.ts ?? Date.now(),
      type: typeDef.id,
      ruleId: 'EXT',
      label: input.label ?? typeDef.label,
      detail: input.detail ?? typeDef.detail ?? 'Reported via integration API',
      severity: input.severity ?? typeDef.severity,
      source: 'integration',
      sourceName: input.sourceName ?? (input.robotId ? this.robots.find((r) => r.id === input.robotId)?.callsign ?? 'adapter' : 'adapter'),
      robotId: input.robotId,
      zone: 'Site-wide',
      confidence: input.confidence ?? 1,
      snapshot: input.snapshotUrl,
      acked: false,
      x: +(input.x ?? pos.x).toFixed(2),
      z: +(input.z ?? pos.z).toFixed(2),
    }
    this.pushEvent(ev)
    return ev
  }

  private pushEvent(ev: DetectionEvent) {
    this.events.unshift(ev)
    if (this.events.length > 400) this.events.pop()
  }

  listEvents(limit = 100) {
    return this.events.slice(0, limit)
  }

  ackEvent(id: string) {
    const ev = this.events.find((e) => e.id === id)
    if (ev) ev.acked = true
    return ev
  }

  async missionSnapshot(stream: string, missionId: string): Promise<string | undefined> {
    const frame = await grabFrame(stream, 6000)
    if (!frame) return undefined
    const file = `${this.id}_${missionId}-${Date.now().toString(36)}.jpg`
    writeFileSync(join(SNAP_DIR, file), frame)
    return `${PUB}/api/snapshots/${file}`
  }

  async seedEvents() {
    const now = Date.now()
    const plan = this.def.eventSeedMins.map((m) => ({ rule: this.pickRule()!, ago: m * 60_000 }))
    // force the most severe rules into the recent history so the board has depth
    const bySeverity = [...this.rules].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
    for (let i = 0; i < Math.min(4, bySeverity.length); i++) if (plan[i + 1]) plan[i + 1].rule = bySeverity[i]
    plan.sort((a, b) => b.ago - a.ago)
    for (const p of plan) await this.generateEvent(p.rule, now - p.ago)
    for (const e of this.events.slice(6)) e.acked = true
  }

  // ---------- missions ----------

  createMission(
    data: { name: string; priority?: 1 | 2 | 3; requestedRobot?: string; recurring?: boolean; steps: MissionStep[] },
    status: Mission['status'] = 'queued',
  ): Mission {
    const m: Mission = {
      id: `M-${this.missionSeq++}`,
      name: data.name,
      priority: data.priority ?? 2,
      requestedRobot: data.requestedRobot ?? 'auto',
      recurring: data.recurring ?? false,
      status,
      steps: data.steps,
      currentStep: 0,
      createdAt: Date.now(),
      results: [],
      progress: 0,
    }
    this.missions.push(m)
    return m
  }

  abortMission(id: string) {
    const m = this.missions.find((x) => x.id === id)
    if (!m || (m.status !== 'active' && m.status !== 'queued')) return m
    if (m.status === 'active' && m.robotId) {
      const s = this.nav.get(m.robotId)
      if (s) {
        s.state = 'idle'
        s.path = []
        s.missionId = undefined
      }
      // cancel any pending adapter order carrying this mission
      for (const o of this.orders) if (o.payload.missionId === m.id && o.state === 'pending') o.state = 'failed'
    }
    m.status = 'aborted'
    m.endedAt = Date.now()
    return m
  }

  teleopGoto(robotId: string, x: number, z: number): boolean {
    const r = this.robots.find((rb) => rb.id === robotId)
    const s = this.nav.get(robotId)
    if (!r || !s) return false
    if (r.adapter === 'external') {
      if (r.integrationLevel !== 'dispatchable') return false
      this.enqueueOrder(robotId, 'goto', { x, z })
      return true
    }
    s.teleopTarget = { x, z }
    s.state = 'teleop'
    s.path = this.planner.planPath(s.x, s.z, x, z)
    s.pathRemaining = this.planner.pathLength(s.path)
    s.actionLeft = 0
    return true
  }

  // ---------- adapter orders ----------

  enqueueOrder(robotId: string, kind: AdapterOrder['kind'], payload: AdapterOrder['payload']) {
    const o: AdapterOrder = {
      id: `OR-${String(this.orderSeq++).padStart(4, '0')}`,
      robotId,
      kind,
      payload,
      state: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.orders.push(o)
    if (this.orders.length > 200) this.orders.shift()
    return o
  }

  pullOrders(robotId: string): AdapterOrder[] {
    const out = this.orders.filter((o) => o.robotId === robotId && o.state === 'pending')
    for (const o of out) {
      o.state = 'acked'
      o.updatedAt = Date.now()
    }
    return out
  }

  setOrderStatus(orderId: string, state: 'done' | 'failed', note?: string): AdapterOrder | undefined {
    const o = this.orders.find((x) => x.id === orderId)
    if (!o) return undefined
    o.state = state
    o.updatedAt = Date.now()
    if (o.payload.missionId) {
      const m = this.missions.find((x) => x.id === o.payload.missionId)
      if (m && m.status === 'active') {
        m.status = state === 'done' ? 'done' : 'failed'
        m.progress = state === 'done' ? 1 : m.progress
        m.endedAt = Date.now()
        if (note)
          m.results.push({
            ts: Date.now(),
            stepIdx: m.steps.length - 1,
            waypointId: m.steps[m.steps.length - 1]?.waypointId ?? '—',
            action: 'wait',
            ok: state === 'done',
            note,
          })
      }
    }
    return o
  }

  // ---------- dispatcher + sim ----------

  private assignQueued() {
    const queued = this.missions
      .filter((m) => m.status === 'queued')
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
    for (const m of queued) {
      const candidates = this.robots.filter((r) => {
        const s = this.nav.get(r.id)!
        // external units are never auto-dispatched — only explicit requests
        if (r.adapter === 'external' && m.requestedRobot !== r.id) return false
        if (r.adapter === 'external' && r.integrationLevel !== 'dispatchable') return false
        if (r.adapter !== 'external') {
          if (s.state !== 'idle') return false
          if (s.battery < 25) return false
        }
        if (m.requestedRobot !== 'auto' && m.requestedRobot !== r.id) return false
        return true
      })
      if (!candidates.length) continue
      const first = this.wpById.get(m.steps[0]?.waypointId)
      candidates.sort((a, b) => {
        if (!first) return 0
        const sa = this.nav.get(a.id)!
        const sb = this.nav.get(b.id)!
        return Math.hypot(sa.x - first.x, sa.z - first.z) - Math.hypot(sb.x - first.x, sb.z - first.z)
      })
      const robot = candidates[0]
      const s = this.nav.get(robot.id)!
      m.robotId = robot.id
      m.status = 'active'
      m.startedAt = Date.now()
      m.currentStep = 0
      m.progress = 0
      if (robot.adapter === 'external') {
        // hand the whole mission to the adapter as one order (VDA5050-style)
        this.enqueueOrder(robot.id, 'mission', { missionId: m.id, name: m.name, steps: m.steps })
        continue
      }
      s.missionId = m.id
      this.beginLeg(robot, s, m)
    }
  }

  private beginLeg(robot: RobotSpec, s: NavState, m: Mission) {
    const step = m.steps[m.currentStep]
    const wp = step && this.wpById.get(step.waypointId)
    if (!wp) {
      this.finishMission(s, m)
      return
    }
    s.state = 'navigating'
    s.targetWp = wp.id
    s.path = this.planner.planPath(s.x, s.z, wp.x, wp.z)
    s.pathRemaining = this.planner.pathLength(s.path)
    s.actionIdx = 0
    s.actionLeft = 0
  }

  private finishMission(s: NavState, m: Mission) {
    m.progress = 1
    m.endedAt = Date.now()
    s.missionId = undefined
    s.state = 'idle'
    s.path = []
    if (m.recurring) {
      m.status = 'done'
      setTimeout(() => {
        if (m.status !== 'done') return
        m.status = 'queued'
        m.robotId = undefined
        m.currentStep = 0
        m.progress = 0
        m.startedAt = undefined
        m.endedAt = undefined
        m.results = m.results.slice(-24)
        m.createdAt = Date.now()
      }, recurCooldown())
    } else {
      m.status = 'done'
    }
  }

  private followPath(s: NavState, max: number, dt: number) {
    if (!s.path.length) return true
    let remaining = max * dt
    while (remaining > 0 && s.path.length) {
      const next = s.path[0]
      const dx = next.x - s.x
      const dz = next.z - s.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) {
        s.path.shift()
        continue
      }
      const step = Math.min(remaining, d)
      s.x += (dx / d) * step
      s.z += (dz / d) * step
      const want = Math.atan2(-dz, dx)
      let diff = want - s.heading
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff < -Math.PI) diff += 2 * Math.PI
      s.heading += diff * Math.min(1, dt * 4)
      remaining -= step
      s.odo += step / 1000
    }
    s.pathRemaining = this.planner.pathLength([{ x: s.x, z: s.z }, ...s.path])
    return s.path.length === 0
  }

  private tickMissions(dt: number) {
    this.assignQueued()
    for (const robot of this.robots) {
      if (robot.adapter === 'external') continue // adapter-fed; no sim drive
      const s = this.nav.get(robot.id)!
      const cruise = robot.family === 'ugv' ? robot.maxSpeed * 0.85 : robot.maxSpeed * 0.38

      const draining = s.state !== 'idle' && s.state !== 'charging'
      s.battery = Math.max(
        3,
        Math.min(100, s.battery + dt * (s.state === 'charging' ? 0.9 : draining ? -0.011 : -0.002)),
      )

      if (s.state === 'charging') {
        s.speed = 0
        if (s.battery >= 90) s.state = 'idle'
        continue
      }

      if (s.battery < 18 && s.state !== 'teleop') {
        const m = s.missionId && this.missions.find((x) => x.id === s.missionId)
        if (m && m.status === 'active') {
          m.status = 'queued'
          m.robotId = undefined
          s.missionId = undefined
        }
        const dock = this.wpById.get(this.def.dockWp)!
        s.state = 'teleop'
        s.teleopTarget = { x: dock.x, z: dock.z }
        s.path = this.planner.planPath(s.x, s.z, dock.x, dock.z)
      }

      if (s.state === 'teleop') {
        s.speed += (cruise - s.speed) * Math.min(1, dt * 2)
        const arrived = this.followPath(s, s.speed, dt)
        if (arrived) {
          s.teleopTarget = undefined
          const dock = this.wpById.get(this.def.dockWp)!
          const nearDock = Math.hypot(s.x - dock.x, s.z - dock.z) < 1.2
          if (s.battery < 30 && nearDock) {
            s.state = 'charging'
          } else if (s.missionId) {
            const m = this.missions.find((x) => x.id === s.missionId)
            if (m) this.beginLeg(robot, s, m)
            else s.state = 'idle'
          } else {
            s.state = 'idle'
          }
        }
        continue
      }

      const m = s.missionId ? this.missions.find((x) => x.id === s.missionId) : undefined
      if (!m || m.status !== 'active') {
        s.state = 'idle'
        s.speed = Math.max(0, s.speed - dt * 2)
        continue
      }

      if (s.state === 'navigating') {
        s.speed += (cruise - s.speed) * Math.min(1, dt * 2)
        const arrived = this.followPath(s, s.speed, dt)
        if (arrived) {
          s.state = 'executing'
          s.speed = 0
          s.actionIdx = 0
          const step = m.steps[m.currentStep]
          s.actionLeft = step.actions[0]?.durationS ?? 0
        }
      } else if (s.state === 'executing') {
        s.speed = 0
        s.actionLeft -= dt
        const step = m.steps[m.currentStep]
        if (s.actionLeft <= 0 && step) {
          const action = step.actions[s.actionIdx]
          if (action) {
            const { ok, note } = ACTION_NOTES[action.type]()
            const res: MissionResult = {
              ts: Date.now(),
              stepIdx: m.currentStep,
              waypointId: step.waypointId,
              action: action.type,
              ok,
              note,
            }
            m.results.push(res)
            const src = ACTION_SNAPSHOT_SOURCE[action.type]?.(robot)
            if (src) {
              this.missionSnapshot(src, m.id).then((snap) => {
                if (snap) res.snapshot = snap
              })
            }
            ;(s.onResult ?? this.onResult)?.(m, res)
          }
          s.actionIdx++
          const nextAction = step.actions[s.actionIdx]
          if (nextAction) {
            s.actionLeft = nextAction.durationS
          } else {
            m.currentStep++
            m.progress = +(m.currentStep / m.steps.length).toFixed(3)
            if (m.currentStep >= m.steps.length) this.finishMission(s, m)
            else this.beginLeg(robot, s, m)
          }
        }
      } else {
        this.beginLeg(robot, s, m)
      }
    }
  }

  /** advance the sim and return the telemetry frame for broadcast */
  tick(dt: number): Telemetry[] {
    this.tickMissions(dt)
    const now = Date.now()
    const out: Telemetry[] = []
    for (const spec of this.robots) {
      const s = this.nav.get(spec.id)!
      const ext = spec.adapter === 'external' ? this.externals.get(spec.id) : undefined
      const offline = ext ? now - ext.lastSeen > EXTERNAL_STALE_MS : false
      const m = s.missionId ? this.missions.find((x) => x.id === s.missionId) : undefined
      const jointNames = spec.family === 'ugv' ? UGV_JOINTS : QUAD_JOINTS
      const joints: JointTemp[] = ext
        ? []
        : jointNames.map((name, i) => ({
            name,
            c: +(41 + 4 * Math.sin(now / 9000 + i * 1.7) + 2 * Math.sin(now / 2300 + i) + (s.speed > 0.2 ? 3 : 0)).toFixed(1),
          }))
      const mode: Telemetry['mode'] = ext
        ? offline
          ? 'offline'
          : ((ext.mode as Telemetry['mode']) ?? 'idle')
        : s.state
      out.push({
        id: spec.id,
        x: +s.x.toFixed(2),
        z: +s.z.toFixed(2),
        heading: +s.heading.toFixed(3),
        speed: +s.speed.toFixed(2),
        battery: +s.battery.toFixed(1),
        rssi: ext ? (offline ? -99 : -60) : Math.round(-54 + 6 * Math.sin(now / 5000 + spec.ip.length)),
        latency: ext ? (offline ? 999 : 45) : Math.round(22 + 10 * Math.abs(Math.sin(now / 3100))),
        mode,
        odoKm: +s.odo.toFixed(2),
        gait: ext
          ? 'adapter'
          : spec.family === 'ugv'
            ? s.speed > 0.05
              ? 'diff-drive'
              : 'brake'
            : s.state === 'executing' || s.speed < 0.05
              ? 'stand'
              : s.speed > 1.4
                ? 'trot'
                : 'walk',
        joints,
        payloadHealth: Object.fromEntries(spec.payloads.map((p) => [p.id, 'ok'])),
        missionId: m?.id,
        missionName: m?.name,
        targetWp: s.targetWp,
        path: s.path.map((p) => ({ x: +p.x.toFixed(2), z: +p.z.toFixed(2) })),
        pathRemaining: +s.pathRemaining.toFixed(1),
      })
    }
    return out
  }

  // ---------- seeding ----------

  seedMissions() {
    for (const seed of this.def.missionSeeds) {
      if (seed.done) {
        const m = this.createMission(
          { name: seed.name, priority: seed.priority, requestedRobot: seed.requestedRobot, steps: seed.steps },
          'done',
        )
        m.robotId = seed.requestedRobot
        m.createdAt = Date.now() - seed.done.agoH * 3600_000
        m.startedAt = m.createdAt + 60_000
        m.endedAt = m.startedAt + seed.done.durMin * 60_000
        m.progress = 1
        m.results = seed.done.results.map((r) => ({
          ts: m.startedAt! + r.atMin * 60_000,
          stepIdx: r.stepIdx,
          waypointId: r.waypointId,
          action: r.action,
          ok: true,
          note: r.note,
        }))
      } else {
        this.createMission(
          {
            name: seed.name,
            priority: seed.priority,
            requestedRobot: seed.requestedRobot,
            recurring: seed.recurring,
            steps: seed.steps,
          },
          'queued',
        )
      }
    }
  }
}
