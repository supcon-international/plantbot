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
  type EventCategory,
  type Channel,
  type StreamSession,
  type Reading,
  type Command,
  type CommandRecord,
  type MapAsset,
  type FrameTransform,
  type MissionTemplate,
  type Schedule,
  type Cadence,
  BUILTIN_MODELS,
  MODEL_CATEGORY,
  PAYLOAD_METRICS,
  METRIC_DEFS,
  ACTION_REQUIRES,
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

/** detector = the generalized rule: what produces events, and how they get vetted */
export interface DetectionRule {
  id: string
  name: string
  model: DetectionModel
  /** what kind of producer this is — sim CV, edge CV, cloud CV, metric threshold, external system */
  kind: 'sim' | 'onboard-cv' | 'cloud-cv' | 'threshold' | 'external'
  source: string
  sourceName: string
  zone: string
  threshold: number // min confidence 0..1
  severity: Severity
  enabled: boolean
  robotId?: string
  builtin: boolean
  /** threshold detectors: fire when latest reading of `metric` crosses `bound` */
  metric?: string
  op?: '>' | '<'
  bound?: number
  lastFiredAt?: number
  firedCount: number
}

export type EventLifecycle = 'new' | 'acked' | 'resolved' | 'dismissed'

export interface EventEvidence {
  kind: 'image' | 'clip' | 'reading'
  url?: string
  channelId?: string
  reading?: { metric: string; value: number; unit: string }
}

export interface DetectionEvent {
  id: string
  ts: number
  type: DetectionModel
  ruleId: string
  label: string
  detail: string
  severity: Severity
  category: EventCategory
  source: string
  sourceName: string
  robotId?: string
  zone: string
  confidence: number
  /** legacy mirror of evidence[0].url — kept for older clients */
  snapshot?: string
  evidence: EventEvidence[]
  lifecycle: EventLifecycle
  /** legacy mirror: lifecycle !== 'new' */
  acked: boolean
  /** mission run this event was captured in (GoRobot patrolId, made explicit) */
  runId?: string
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
  // campus security vocabulary
  'unattended-bag': () => `Backpack static ${(3 + Math.random() * 7).toFixed(0)} min · no owner within ${(3 + Math.random() * 6).toFixed(0)} m`,
  crowding: () => `~${(18 + Math.random() * 40).toFixed(0)} people in queue box · density ${(1.6 + Math.random() * 1.8).toFixed(1)} p/m²`,
  fall: () => `Person down ${(6 + Math.random() * 20).toFixed(0)}s, not recovering · dispatching nearest unit`,
  'ebike-blocking': () => `E-bike parked across egress line · plate readable, owner paging queued`,
  tailgating: () => `${2 + Math.floor(Math.random() * 2)} entries on one credential in ${(3 + Math.random() * 4).toFixed(1)}s`,
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

/** a mission IS the run — templates and schedules sit above it */
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
  templateId?: string
  scheduleId?: string
  paused?: boolean
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
  /** direct velocity teleop — server-side deadman: expires unless renewed */
  vel?: { vx: number; wz: number; until: number }
  onResult?: (m: Mission, r: MissionResult) => void
}

/** VDA5050-order-like unit of work queued for an external (adapter) robot.
 *  pause/resume/abort mirror operator commands onto an in-flight mission order;
 *  ptz forwards camera intent; goto with dock:true keeps the dock semantic so
 *  adapters can substitute the vendor's own charge/return routine. */
export interface AdapterOrder {
  id: string
  robotId: string
  kind: 'goto' | 'mission' | 'announce' | 'pause' | 'resume' | 'abort' | 'ptz'
  payload: {
    x?: number
    z?: number
    dock?: boolean
    missionId?: string
    name?: string
    steps?: MissionStep[]
    text?: string
    channelId?: string
    pan?: number
    tilt?: number
    zoom?: number
  }
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
  templates: MissionTemplate[] = []
  schedules: Schedule[] = []
  rules: DetectionRule[] = []
  events: DetectionEvent[] = []
  eventTypes: EventTypeDef[] = []
  orders: AdapterOrder[] = []
  externals = new Map<string, ExternalState>() // robotId -> adapter state
  commandLog: CommandRecord[] = []
  /** robotId|metric -> ring buffer of recent readings */
  readings = new Map<string, Reading[]>()
  sessions = new Map<string, StreamSession>()
  onResult?: (m: Mission, r: MissionResult) => void
  onEvent?: (ev: DetectionEvent) => void
  onReadings?: (batch: Reading[]) => void

  private wpById: Map<string, SiteDef['waypoints'][number]>
  private ruleSeq = 1
  private evSeq = 1
  private missionSeq = 100
  private orderSeq = 1
  private tmplSeq = 1
  private schedSeq = 1
  private cmdSeq = 1
  private sessSeq = 1
  private readingClock = 0
  private faultClock = 0
  private thresholdLastFired = new Map<string, number>()

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
    this.eventTypes = [
      ...BUILTIN_MODELS.map((m) => ({ id: m, label: m, severity: 'info' as Severity, builtin: true })),
      { id: 'fault', label: 'robot fault', severity: 'high' as Severity, detail: 'Robot health stream', builtin: true },
    ]
    for (const r of this.robots) this.initNav(r)
    for (const t of def.eventTypeSeeds ?? []) this.addEventType(t)
    for (const s of def.ruleSeeds) this.addRule({ kind: 'sim', ...s, enabled: true, builtin: true })
    this.seedReadings()
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

  // ---------- channels + stream sessions ----------

  /** derive the channel list — robot payloads with footage plus fixed site cameras */
  channels(robotId?: string): Channel[] {
    const out: Channel[] = []
    for (const r of this.robots) {
      if (robotId && r.id !== robotId) continue
      for (const p of r.payloads) {
        if (!p.file && !p.stream) continue
        if (p.kind !== 'camera' && p.kind !== 'thermal' && p.kind !== 'ogi') continue
        const nCams = r.payloads.filter((q) => q.kind === 'camera').length
        const role: Channel['role'] =
          p.kind === 'thermal' ? 'thermal'
          : p.kind === 'ogi' ? 'ogi'
          : nCams > 1 && p.id !== r.payloads.find((q) => q.kind === 'camera')?.id ? 'optical'
          : 'front'
        out.push({
          id: `${r.id}:${p.id}`,
          robotId: r.id,
          payloadId: p.id,
          role,
          label: `${r.callsign} · ${p.name}`,
          codec: 'h264',
          source: p.file ? { kind: 'file', file: p.file } : { kind: 'hls', url: p.file ?? '' },
          streamKey: p.stream,
        })
      }
    }
    if (!robotId)
      for (const c of this.cameras)
        out.push({
          id: `cam:${c.id}`,
          role: 'fixed',
          label: c.name,
          codec: 'h264',
          source: c.file ? { kind: 'file', file: c.file } : { kind: 'hls', url: c.stream },
          streamKey: c.stream,
        })
    return out
  }

  /** open a playback lease. Demo file sources never expire; live ones get a TTL. */
  openSession(channelId: string): StreamSession | null {
    const ch = this.channels().find((c) => c.id === channelId)
    if (!ch) return null
    const id = `SS-${this.id}-${String(this.sessSeq++).padStart(4, '0')}`
    const s: StreamSession =
      ch.source.kind === 'file'
        ? { id, channelId, url: ch.source.file, protocol: 'file', createdAt: Date.now(), expiresAt: null }
        : { id, channelId, url: ch.source.url, protocol: ch.source.kind === 'rtsp' ? 'rtsp' : 'hls', createdAt: Date.now(), expiresAt: Date.now() + 120_000 }
    this.sessions.set(id, s)
    if (this.sessions.size > 300) {
      const oldest = [...this.sessions.keys()][0]
      this.sessions.delete(oldest)
    }
    return s
  }

  renewSession(id: string): StreamSession | null {
    const s = this.sessions.get(id)
    if (!s) return null
    if (s.expiresAt !== null) s.expiresAt = Date.now() + 120_000
    return s
  }

  closeSession(id: string): boolean {
    return this.sessions.delete(id)
  }

  // ---------- payload readings ----------

  private pushReading(r: Reading) {
    const key = `${r.robotId}|${r.metric}`
    const buf = this.readings.get(key) ?? []
    buf.push(r)
    if (buf.length > 200) buf.shift()
    this.readings.set(key, buf)
  }

  listReadings(robotId: string, metric?: string, since = 0, limit = 200): Reading[] {
    const out: Reading[] = []
    for (const [key, buf] of this.readings) {
      if (!key.startsWith(`${robotId}|`)) continue
      if (metric && key !== `${robotId}|${metric}`) continue
      for (const r of buf) if (r.ts > since) out.push(r)
    }
    out.sort((a, b) => a.ts - b.ts)
    return out.slice(-limit)
  }

  /** metrics a robot actually emits, given its installed payloads */
  robotMetrics(robotId: string): string[] {
    const r = this.robots.find((x) => x.id === robotId)
    if (!r) return []
    const ids = new Set<string>()
    for (const p of r.payloads) for (const m of PAYLOAD_METRICS[p.kind] ?? []) ids.add(m)
    return [...ids]
  }

  /** integration API: adapter posts a batch of readings (accepted ones broadcast like sim readings) */
  ingestReadings(robotId: string, items: { metric: string; value: number; ts?: number; payloadId?: string; quality?: Reading['quality'] }[]): number {
    const accepted: Reading[] = []
    for (const it of items) {
      if (typeof it.value !== 'number' || !METRIC_DEFS.some((d) => d.id === it.metric)) continue
      const rd: Reading = {
        robotId,
        payloadId: it.payloadId ?? 'adapter',
        metric: it.metric,
        value: it.value,
        ts: it.ts ?? Date.now(),
        quality: it.quality ?? 'ok',
      }
      this.pushReading(rd)
      accepted.push(rd)
    }
    if (accepted.length) this.onReadings?.(accepted)
    return accepted.length
  }

  /** simulated sensor values — smooth bands with the odd excursion */
  private simValue(metric: string, t: number, seed: number): number {
    const w = (f: number, p: number) => Math.sin(t / f + seed * p)
    switch (metric) {
      case 'ch4.ppm': {
        const spike = Math.random() < 0.004 ? 4 + Math.random() * 4 : 0
        return +(2.4 + 1.1 * w(97_000, 1.3) + 0.5 * w(23_000, 2.1) + spike).toFixed(2)
      }
      case 'h2s.ppm':
        return +Math.max(0, 0.12 + 0.1 * w(83_000, 1.7)).toFixed(2)
      case 'co.ppm':
        return +Math.max(0, 2.2 + 1.4 * w(61_000, 0.9)).toFixed(1)
      case 'o2.pct':
        return +(20.9 + 0.06 * w(120_000, 2.3)).toFixed(2)
      case 'dt.max.c': {
        const spike = Math.random() < 0.0025 ? 4 + Math.random() * 4 : 0
        return +(6.8 + 2.6 * w(140_000, 1.1) + 1.1 * w(31_000, 3.2) + spike).toFixed(1)
      }
      case 'uls.db':
        return +Math.max(0, 6 + 2.8 * w(74_000, 1.9) + 1.1 * w(17_000, 0.7)).toFixed(1)
      case 'ch4.ppmm':
        return Math.round(Math.max(60, 320 + 160 * w(110_000, 1.5) + 60 * w(26_000, 2.7)))
      case 'vib.g':
        return +Math.max(0.01, 0.11 + 0.07 * w(45_000, 2.9)).toFixed(3)
      default:
        return 0
    }
  }

  private genReadings(now: number, quiet = false) {
    const batch: Reading[] = []
    for (const r of this.robots) {
      if (r.adapter === 'external') continue // adapters push their own
      const nav = this.nav.get(r.id)!
      let seed = 0
      for (const c of r.id) seed = (seed * 31 + c.charCodeAt(0)) % 97
      for (const p of r.payloads) {
        for (const m of PAYLOAD_METRICS[p.kind] ?? []) {
          const rd: Reading = {
            robotId: r.id,
            payloadId: p.id,
            metric: m,
            value: this.simValue(m, now, seed),
            ts: now,
            quality: 'ok',
            wp: nav.state === 'executing' ? nav.targetWp : undefined,
          }
          this.pushReading(rd)
          batch.push(rd)
        }
      }
    }
    if (!quiet && batch.length) this.onReadings?.(batch)
  }


  private seedReadings() {
    const now = Date.now()
    for (let i = 60; i > 0; i--) this.genReadings(now - i * 3000, true)
  }

  /** threshold detectors: latest reading vs bound, 60 s per-rule cooldown */
  private checkThresholds(now: number) {
    for (const rule of this.rules) {
      if (!rule.enabled || rule.kind !== 'threshold' || !rule.metric || !rule.robotId || rule.bound === undefined) continue
      const buf = this.readings.get(`${rule.robotId}|${rule.metric}`)
      const last = buf?.[buf.length - 1]
      if (!last) continue
      const crossed = rule.op === '<' ? last.value < rule.bound : last.value > rule.bound
      if (!crossed) continue
      const prev = this.thresholdLastFired.get(rule.id) ?? 0
      if (now - prev < 180_000) continue
      this.thresholdLastFired.set(rule.id, now)
      const def = METRIC_DEFS.find((d) => d.id === rule.metric)
      void this.generateEvent(rule, now, {
        detail: `${def?.label ?? rule.metric} ${last.value}${def?.unit ?? ''} — bound ${rule.op ?? '>'} ${rule.bound}${def?.unit ?? ''}`,
        evidence: [{ kind: 'reading', reading: { metric: rule.metric, value: last.value, unit: def?.unit ?? '' } }],
      }).then((ev) => {
        if (ev) this.onEvent?.(ev)
      })
    }
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
    kind?: DetectionRule['kind']
    metric?: string
    op?: '>' | '<'
    bound?: number
  }) {
    return this.addRule({
      name: input.name,
      model: input.model,
      kind: input.kind ?? (input.metric ? 'threshold' : 'sim'),
      source: input.source,
      sourceName: input.sourceName ?? input.source,
      zone: input.zone ?? 'Site-wide',
      threshold: input.threshold ?? 0.6,
      severity: input.severity ?? 'info',
      enabled: true,
      robotId: input.robotId,
      metric: input.metric,
      op: input.op,
      bound: input.bound,
      builtin: false,
    })
  }

  patchRule(id: string, patch: Partial<Pick<DetectionRule, 'enabled' | 'threshold' | 'severity' | 'name' | 'bound'>>) {
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

  /** last known position — undefined when the robot has never registered
   *  (e.g. seed rules pin an ext-* id whose adapter hasn't come up yet) */
  robotPosition(id: string): { x: number; z: number } | undefined {
    const s = this.nav.get(id)
    return s ? { x: s.x, z: s.z } : undefined
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

  async generateEvent(
    rule?: DetectionRule,
    ts = Date.now(),
    opts?: { detail?: string; evidence?: EventEvidence[]; runId?: string },
  ): Promise<DetectionEvent | null> {
    const r = rule ?? this.pickRule()
    if (!r) return null
    const id = `EV-${String(this.evSeq++).padStart(4, '0')}`
    const side = Math.random() > 0.5 ? 1 : -1
    const bx = this.site.bounds.x
    const bz = this.site.bounds.z
    // robot-bound rules fall back to an in-bounds random spot while the robot
    // is unknown (adapter not up yet) — never pile seed events onto (0,0)
    const pos = (r.robotId ? this.robotPosition(r.robotId) : undefined) ?? {
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
      detail: opts?.detail ?? DETAILS[r.model]?.() ?? typeDef?.detail ?? `${typeDef?.label ?? r.model} detection`,
      severity: r.severity,
      category: MODEL_CATEGORY[r.model] ?? 'equipment',
      source: r.source,
      sourceName: r.sourceName,
      robotId: r.robotId,
      zone: r.zone,
      confidence,
      evidence: opts?.evidence ?? [],
      lifecycle: 'new',
      acked: false,
      runId: opts?.runId,
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
      ev.evidence.unshift({ kind: 'image', url: ev.snapshot, channelId: this.channels().find((c) => c.streamKey === r.source)?.id })
    }

    this.pushEvent(ev)
    return ev
  }

  /** occasional robot-health faults — the second event stream (GoRobot AlarmRunInfo) */
  private maybeFault(now: number) {
    if (now - this.faultClock < 150_000 || Math.random() > 0.007) return
    const sims = this.robots.filter((r) => r.adapter !== 'external')
    if (!sims.length) return
    this.faultClock = now
    const r = sims[Math.floor(Math.random() * sims.length)]
    const pos = this.robotPosition(r.id) ?? { x: 0, z: 0 }
    const kinds = [
      { label: 'Joint overtemp', detail: () => `Hip actuator ${(78 + Math.random() * 9).toFixed(0)} °C — derating gait` },
      { label: 'Localization jitter', detail: () => `Scan-match residual ${(0.4 + Math.random() * 0.5).toFixed(2)} m — re-anchoring on lidar keyframe` },
      { label: 'Comms degraded', detail: () => `RSSI floor ${(-78 - Math.random() * 8).toFixed(0)} dBm on mesh hop 2 — buffering telemetry` },
    ]
    const k = kinds[Math.floor(Math.random() * kinds.length)]
    const ev: DetectionEvent = {
      id: `EV-${String(this.evSeq++).padStart(4, '0')}`,
      ts: now,
      type: 'fault',
      ruleId: 'HEALTH',
      label: k.label,
      detail: k.detail(),
      severity: 'high',
      category: 'robot-fault',
      source: r.id,
      sourceName: r.callsign,
      robotId: r.id,
      zone: 'Robot health',
      confidence: 1,
      evidence: [],
      lifecycle: 'new',
      acked: false,
      x: +pos.x.toFixed(2),
      z: +pos.z.toFixed(2),
    }
    this.pushEvent(ev)
    this.onEvent?.(ev)
  }

  /** integration API: external system pushes a custom event */
  ingestEvent(input: {
    type: string
    label?: string
    detail?: string
    severity?: Severity
    category?: EventCategory
    x?: number
    z?: number
    robotId?: string
    sourceName?: string
    snapshotUrl?: string
    evidence?: EventEvidence[]
    confidence?: number
    runId?: string
    ts?: number
  }): DetectionEvent | null {
    const typeDef = this.eventTypes.find((t) => t.id === input.type)
    if (!typeDef) return null
    const pos = (input.robotId ? this.robotPosition(input.robotId) : undefined) ?? { x: input.x ?? 0, z: input.z ?? 0 }
    const evidence = input.evidence ?? []
    if (input.snapshotUrl && !evidence.some((e) => e.url === input.snapshotUrl))
      evidence.unshift({ kind: 'image', url: input.snapshotUrl })
    const ev: DetectionEvent = {
      id: `EV-${String(this.evSeq++).padStart(4, '0')}`,
      ts: input.ts ?? Date.now(),
      type: typeDef.id,
      ruleId: 'EXT',
      label: input.label ?? typeDef.label,
      detail: input.detail ?? typeDef.detail ?? 'Reported via integration API',
      severity: input.severity ?? typeDef.severity,
      category: input.category ?? MODEL_CATEGORY[typeDef.id] ?? 'equipment',
      source: 'integration',
      sourceName: input.sourceName ?? (input.robotId ? this.robots.find((r) => r.id === input.robotId)?.callsign ?? 'adapter' : 'adapter'),
      robotId: input.robotId,
      zone: 'Site-wide',
      confidence: input.confidence ?? 1,
      snapshot: input.snapshotUrl ?? evidence.find((e) => e.kind === 'image')?.url,
      evidence,
      lifecycle: 'new',
      acked: false,
      runId: input.runId,
      x: +(input.x ?? pos.x).toFixed(2),
      z: +(input.z ?? pos.z).toFixed(2),
    }
    this.pushEvent(ev)
    this.onEvent?.(ev) // external events are always live — broadcast at the source
    return ev
  }

  private pushEvent(ev: DetectionEvent) {
    this.events.unshift(ev)
    if (this.events.length > 400) this.events.pop()
  }

  listEvents(limit = 100) {
    return this.events.slice(0, limit)
  }

  /** lifecycle: new → acked → resolved | dismissed (dismissed keeps evidence → training exports) */
  setLifecycle(id: string, to: 'acked' | 'resolved' | 'dismissed') {
    const ev = this.events.find((e) => e.id === id)
    if (!ev) return undefined
    ev.lifecycle = to
    ev.acked = true
    return ev
  }

  ackEvent(id: string) {
    return this.setLifecycle(id, 'acked')
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
    for (const e of this.events.slice(6)) {
      if (e.lifecycle === 'new') {
        e.lifecycle = Math.random() < 0.3 ? 'dismissed' : 'resolved'
        e.acked = true
      }
    }
  }

  // ---------- mission templates (routes) + schedules ----------

  private deriveRequires(steps: MissionStep[]): PayloadSpec['kind'][] {
    const out = new Set<PayloadSpec['kind']>()
    for (const s of steps) for (const a of s.actions) {
      const k = ACTION_REQUIRES[a.type]
      if (k) out.add(k)
    }
    return [...out]
  }

  createTemplate(input: { name: string; steps: MissionStep[]; builtin?: boolean }): MissionTemplate {
    const t: MissionTemplate = {
      id: `T-${String(this.tmplSeq++).padStart(2, '0')}`,
      name: input.name,
      steps: input.steps,
      requires: this.deriveRequires(input.steps),
      builtin: input.builtin ?? false,
      createdAt: Date.now(),
    }
    this.templates.push(t)
    return t
  }

  deleteTemplate(id: string): boolean {
    const i = this.templates.findIndex((t) => t.id === id && !t.builtin)
    if (i < 0) return false
    this.templates.splice(i, 1)
    this.schedules = this.schedules.filter((s) => s.templateId !== id)
    return true
  }

  private nextRun(c: Cadence, from: number): number | undefined {
    if (c.kind === 'once') return c.at && c.at > from ? c.at : undefined
    if (c.kind === 'interval') return from + c.everyMin * 60_000
    // weekly: next matching day+time after `from`
    const [hh, mm] = c.at.split(':').map(Number)
    for (let d = 0; d < 8; d++) {
      const cand = new Date(from + d * 86_400_000)
      cand.setHours(hh ?? 0, mm ?? 0, 0, 0)
      if (cand.getTime() > from && c.days.includes(cand.getDay())) return cand.getTime()
    }
    return undefined
  }

  createSchedule(input: {
    templateId: string
    assign?: Schedule['assign']
    cadence: Cadence
    priority?: 1 | 2 | 3
    /** stagger the first run (ms) so seeded schedules don't all fire at boot */
    firstDelayMs?: number
  }): Schedule | null {
    if (!this.templates.some((t) => t.id === input.templateId)) return null
    const now = Date.now()
    const s: Schedule = {
      id: `SC-${String(this.schedSeq++).padStart(2, '0')}`,
      templateId: input.templateId,
      assign: input.assign ?? { kind: 'auto' },
      cadence: input.cadence,
      priority: input.priority ?? 2,
      enabled: true,
      runCount: 0,
      nextRunAt:
        input.firstDelayMs !== undefined
          ? now + input.firstDelayMs
          : input.cadence.kind === 'once'
            ? (input.cadence.at ?? now)
            : this.nextRun(input.cadence, now),
    }
    this.schedules.push(s)
    return s
  }

  patchSchedule(id: string, patch: { enabled?: boolean; cadence?: Cadence; assign?: Schedule['assign']; priority?: 1 | 2 | 3 }) {
    const s = this.schedules.find((x) => x.id === id)
    if (!s) return undefined
    Object.assign(s, patch)
    if (patch.cadence) s.nextRunAt = this.nextRun(patch.cadence, Date.now())
    return s
  }

  deleteSchedule(id: string): boolean {
    const i = this.schedules.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.schedules.splice(i, 1)
    return true
  }

  /** robots whose payload kinds cover a template's requires — auto-assignment pool */
  private capableRobots(t: MissionTemplate): string[] {
    return this.robots
      .filter((r) => r.adapter !== 'external')
      .filter((r) => t.requires.every((k) => r.payloads.some((p) => p.kind === k)))
      .map((r) => r.id)
  }

  /** fire due schedules — creation IS activation, there is no separate “deploy” step */
  private tickSchedules(now: number) {
    for (const s of this.schedules) {
      if (!s.enabled || !s.nextRunAt || now < s.nextRunAt) continue
      // skip while the previous run is still open; re-check shortly
      const open = this.missions.some((m) => m.scheduleId === s.id && (m.status === 'queued' || m.status === 'active'))
      if (open) {
        s.nextRunAt = now + 60_000
        continue
      }
      const t = this.templates.find((x) => x.id === s.templateId)
      if (!t) continue
      const m = this.createMission(
        { name: t.name, priority: s.priority, requestedRobot: s.assign.kind === 'robot' ? s.assign.robotId : 'auto', steps: t.steps },
        'queued',
      )
      m.templateId = t.id
      m.scheduleId = s.id
      s.lastRunAt = now
      s.runCount++
      s.nextRunAt = s.cadence.kind === 'once' ? undefined : this.nextRun(s.cadence, now)
    }
  }

  // ---------- missions (runs) ----------

  createMission(
    data: { name: string; priority?: 1 | 2 | 3; requestedRobot?: string; recurring?: boolean; steps: MissionStep[]; templateId?: string },
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
      templateId: data.templateId,
    }
    this.missions.push(m)
    if (this.missions.length > 120) {
      const i = this.missions.findIndex((x) => x.status === 'done' || x.status === 'aborted' || x.status === 'failed')
      if (i >= 0) this.missions.splice(i, 1)
    }
    return m
  }

  pauseMission(id: string, paused: boolean): Mission | undefined {
    const m = this.missions.find((x) => x.id === id)
    if (!m || m.status !== 'active') return undefined
    m.paused = paused
    // an externally-executed mission must hear about it, or only the UI pauses
    const r = m.robotId ? this.robots.find((x) => x.id === m.robotId) : undefined
    if (r?.adapter === 'external') this.enqueueOrder(r.id, paused ? 'pause' : 'resume', { missionId: m.id })
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
      // cancel any pending adapter order carrying this mission; if the adapter
      // already pulled it, follow up with an explicit abort order
      let acked = false
      for (const o of this.orders)
        if (o.payload.missionId === m.id) {
          if (o.state === 'pending') o.state = 'failed'
          else if (o.state === 'acked' && o.kind === 'mission') acked = true
        }
      const r = this.robots.find((x) => x.id === m.robotId)
      if (r?.adapter === 'external' && acked) this.enqueueOrder(r.id, 'abort', { missionId: m.id })
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

  // ---------- commands (semantic, server-validated) ----------

  command(robotId: string, cmd: Command, by = 'operator'): CommandRecord {
    const rec: CommandRecord = {
      id: `CMD-${String(this.cmdSeq++).padStart(4, '0')}`,
      robotId,
      ts: Date.now(),
      by,
      command: cmd,
      accepted: false,
    }
    const done = (accepted: boolean, reason?: string) => {
      rec.accepted = accepted
      rec.reason = reason
      this.commandLog.unshift(rec)
      if (this.commandLog.length > 80) this.commandLog.pop()
      return rec
    }
    const r = this.robots.find((x) => x.id === robotId)
    const s = this.nav.get(robotId)
    if (!r || !s) return done(false, 'unknown robot')
    const ext = r.adapter === 'external' ? this.externals.get(robotId) : undefined
    if (ext && Date.now() - ext.lastSeen > EXTERNAL_STALE_MS) return done(false, 'robot offline')
    if (r.adapter === 'external' && r.integrationLevel !== 'dispatchable')
      return done(false, 'external unit is state-only')

    switch (cmd.type) {
      case 'goto': {
        const wp = cmd.wp ? this.wpById.get(cmd.wp) : undefined
        const x = wp?.x ?? cmd.x
        const z = wp?.z ?? cmd.z
        if (typeof x !== 'number' || typeof z !== 'number') return done(false, 'wp or x,z required')
        if (s.battery < 8) return done(false, 'battery critical — dock first')
        return done(this.teleopGoto(robotId, x, z))
      }
      case 'dock': {
        const dock = this.wpById.get(this.def.dockWp)!
        if (r.adapter === 'external') {
          // keep the dock semantic — the adapter may swap in the vendor's own
          // return-to-charge routine instead of plain navigation
          this.enqueueOrder(robotId, 'goto', { x: dock.x, z: dock.z, dock: true })
          return done(true)
        }
        return done(this.teleopGoto(robotId, dock.x, dock.z))
      }
      case 'pause':
      case 'resume': {
        const m = s.missionId ? this.missions.find((x) => x.id === s.missionId) : undefined
        if (!m) return done(false, 'no active mission')
        this.pauseMission(m.id, cmd.type === 'pause')
        return done(true)
      }
      case 'abort': {
        const m = s.missionId ? this.missions.find((x) => x.id === s.missionId) : undefined
        if (!m) return done(false, 'no active mission')
        this.abortMission(m.id)
        return done(true)
      }
      case 'announce': {
        if (!cmd.text?.trim()) return done(false, 'text required')
        if (r.adapter === 'external') this.enqueueOrder(robotId, 'announce', { text: cmd.text })
        return done(true)
      }
      case 'ptz': {
        const ch = this.channels(robotId).find((c) => c.id === cmd.channelId)
        if (!ch) return done(false, 'unknown channel')
        if (r.adapter === 'external')
          this.enqueueOrder(robotId, 'ptz', { channelId: ch.streamKey ?? ch.id, pan: cmd.pan, tilt: cmd.tilt, zoom: cmd.zoom })
        return done(true)
      }
      case 'velocity': {
        if (r.adapter === 'external') return done(false, 'velocity teleop is sim-only')
        if (s.state === 'charging') return done(false, 'undocking required')
        // server-side deadman: expires unless the client keeps renewing intent
        s.vel = { vx: Math.max(-r.maxSpeed, Math.min(r.maxSpeed, cmd.vx)), wz: Math.max(-1.8, Math.min(1.8, cmd.wz)), until: Date.now() + 400 }
        return done(true)
      }
    }
  }

  // ---------- maps + calibration ----------

  maps(): { maps: MapAsset[]; transforms: FrameTransform[] } {
    const maps: MapAsset[] = []
    const transforms: FrameTransform[] = []
    if (this.site.map) {
      const m = this.site.map
      maps.push({
        id: 'occupancy',
        kind: 'occupancy',
        name: m.source,
        url: m.image,
        occupancy: { resolution: m.resolution, origin: m.origin, width: m.width, height: m.height },
      })
      // pixel frame (top-left origin, +y down) → world metres: explicit, so no client ever flips y
      transforms.push({
        from: 'map:occupancy',
        to: 'world',
        params: { s: m.resolution, thetaRad: 0, t: [m.origin[0], m.origin[1]] },
        note: 'p_world = px · resolution + origin (top-left anchored, x→east, z→south)',
      })
    }
    if (this.def.splat)
      maps.push({ id: 'splat', kind: 'splat', name: this.def.splat.name, url: this.def.splat.url })
    // demo geodetic anchor — a similarity fit, the shape a real survey calibration takes
    transforms.push({
      from: 'world',
      to: 'wgs84',
      params: { s: 1 / 111_320, thetaRad: 0, t: this.id === 'plant-07' ? [121.474, 31.233] : [121.605, 31.37] },
      note: 'lon = x·s + t[0] · lat = -z·s + t[1] (small-area approximation)',
    })
    return { maps, transforms }
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
    // only the mission order itself settles the mission — pause/resume/abort
    // orders carry missionId purely as a reference
    if (o.kind === 'mission' && o.payload.missionId) {
      const m = this.missions.find((x) => x.id === o.payload.missionId)
      if (m && m.status === 'active') {
        m.status = state === 'done' ? 'done' : 'failed'
        m.progress = state === 'done' ? 1 : m.progress
        m.endedAt = Date.now()
        const s = m.robotId ? this.nav.get(m.robotId) : undefined
        if (s?.missionId === m.id) s.missionId = undefined
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
      const tmpl = m.templateId ? this.templates.find((t) => t.id === m.templateId) : undefined
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
        // capability match: auto-assignment only picks robots whose payloads cover the route's needs
        if (m.requestedRobot === 'auto' && tmpl && !tmpl.requires.every((k) => r.payloads.some((p) => p.kind === k)))
          return false
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
        // hand the whole mission to the adapter as one order (VDA5050-style);
        // still pin nav.missionId so robot-scoped pause/resume/abort commands
        // resolve the active mission for external units too
        s.missionId = m.id
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
    // schedule-born runs never self-requeue — the schedule fires the next run
    if (m.recurring && !m.scheduleId) {
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
        if (s.vel && Date.now() < s.vel.until) continue // direct velocity drive owns the robot
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
        if (m.paused) {
          s.speed = Math.max(0, s.speed - dt * 2.5)
          continue
        }
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
        if (m.paused) continue // operator hold — clock stops at the waypoint
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
                if (snap) {
                  res.snapshot = snap
                  const linked = this.events.find((e) => e.runId === m.id && e.ts === res.ts)
                  if (linked && !linked.snapshot) {
                    linked.snapshot = snap
                    linked.evidence.unshift({ kind: 'image', url: snap })
                  }
                }
              })
            }
            // an anomalous capture IS an event on the run (GoRobot's per-waypoint capture → alarm link)
            if (!ok) {
              const rule = this.rules.find((x) => x.enabled && x.robotId === robot.id && x.source === src) ?? undefined
              void this.generateEvent(
                rule ?? {
                  id: 'RUN',
                  name: `${robot.callsign} · ${action.type.replace('_', ' ')}`,
                  model: action.type === 'thermal_scan' ? 'thermal' : action.type === 'ogi_scan' ? 'ogi' : action.type === 'acoustic_scan' ? 'acoustic' : 'gauge',
                  kind: 'onboard-cv',
                  source: src ?? robot.id,
                  sourceName: robot.callsign,
                  zone: this.wpById.get(step.waypointId)?.name ?? step.waypointId,
                  threshold: 0.6,
                  severity: 'high',
                  enabled: true,
                  robotId: robot.id,
                  builtin: true,
                  firedCount: 0,
                },
                res.ts,
                { detail: note, runId: m.id },
              ).then((ev) => {
                if (ev) this.onEvent?.(ev)
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

  /** direct-velocity teleop with a server-side deadman — expires unless renewed */
  private applyVelocity(dt: number, now: number) {
    for (const r of this.robots) {
      if (r.adapter === 'external') continue
      const s = this.nav.get(r.id)!
      if (!s.vel) continue
      if (now >= s.vel.until) {
        s.vel = undefined
        if (s.state === 'teleop' && !s.teleopTarget) {
          s.state = 'idle'
          s.speed = 0
        }
        continue
      }
      s.state = 'teleop'
      s.teleopTarget = undefined
      s.path = []
      s.pathRemaining = 0
      s.heading += s.vel.wz * dt
      const bx = this.site.bounds.x
      const bz = this.site.bounds.z
      s.x = Math.max(bx[0] + 0.5, Math.min(bx[1] - 0.5, s.x + Math.cos(s.heading) * s.vel.vx * dt))
      s.z = Math.max(bz[0] + 0.5, Math.min(bz[1] - 0.5, s.z - Math.sin(s.heading) * s.vel.vx * dt))
      s.speed = Math.abs(s.vel.vx)
      s.odo += (Math.abs(s.vel.vx) * dt) / 1000
    }
  }

  /** advance the sim and return the telemetry frame for broadcast */
  tick(dt: number): Telemetry[] {
    const nowPre = Date.now()
    this.tickSchedules(nowPre)
    this.tickMissions(dt)
    this.applyVelocity(dt, nowPre)
    this.maybeFault(nowPre)
    if (nowPre - this.readingClock >= 3000) {
      this.readingClock = nowPre
      this.genReadings(nowPre)
      this.checkThresholds(nowPre)
    }
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
    let stagger = 0
    for (const seed of this.def.missionSeeds) {
      if (seed.done) {
        // backdated completed run + the route it followed, registered as a reusable template
        const t = this.createTemplate({ name: seed.name, steps: seed.steps, builtin: true })
        const m = this.createMission(
          { name: seed.name, priority: seed.priority, requestedRobot: seed.requestedRobot, steps: seed.steps, templateId: t.id },
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
      } else if (seed.recurring) {
        // recurring seeds become template + interval schedule — the schedule drives every run
        const t = this.createTemplate({ name: seed.name, steps: seed.steps, builtin: true })
        const sched = this.createSchedule({
          templateId: t.id,
          assign: seed.requestedRobot === 'auto' ? { kind: 'auto' } : { kind: 'robot', robotId: seed.requestedRobot },
          cadence: { kind: 'interval', everyMin: seed.everyMin ?? 4 + Math.floor(Math.random() * 3) },
          priority: seed.priority,
          firstDelayMs: stagger,
        })
        if (sched) stagger += 9000 + Math.random() * 8000
      } else {
        this.createMission(
          {
            name: seed.name,
            priority: seed.priority,
            requestedRobot: seed.requestedRobot,
            steps: seed.steps,
          },
          'queued',
        )
      }
    }
  }
}
