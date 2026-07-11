// World — the per-site runtime. Plantbot is a pure integration layer: every
// robot arrives through a vendor adapter (/api/integration/v1), so a World
// owns no motion simulation — it holds the site (waypoints/zones/rules/maps),
// the mission engine (template → schedule → run), the detection-event stream
// and the order queue that adapters pull. Nothing in here is module-global:
// multi-site isolation.

import { writeFileSync, mkdirSync } from 'node:fs'
import { readdir, stat, unlink } from 'node:fs/promises'
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
  UNIT_COLORS,
} from './fleet.js'
import type { SiteDef, SeedMissionDef } from './sites.js'
import type { Persist } from './config.js'
import { grabFrame, type FrameSource } from './frames.js'
import { ensureRelayStream, relayConfigured, relayName } from './media.js'
import type { Waypoint, Zone, Building, SiteCamera, SiteMapMeta } from './fleet.js'

/** everything a World needs at runtime — geometry is data (SQLite), not code */
export interface SiteRuntime {
  id: string
  name: string
  operator: string
  bounds: { x: [number, number]; z: [number, number] }
  map: SiteMapMeta | null
  dockWp: string
  splat?: { name: string; url: string }
  buildings: Building[]
  waypoints: Waypoint[]
  zones: Zone[]
  cameras: SiteCamera[]
  transforms: FrameTransform[]
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUB = process.env.PUBLIC_BASE ?? ''
export const SNAP_DIR = join(ROOT, 'data', 'snapshots')
mkdirSync(SNAP_DIR, { recursive: true })

// evidence snapshots are unbounded otherwise (events cap at 400, files don't):
// every ~25 writes, drop the oldest beyond the cap
const SNAP_KEEP = 600
let snapWrites = 0
function sweepSnapshots() {
  if (++snapWrites % 25 !== 0) return
  void (async () => {
    const files = await readdir(SNAP_DIR)
    if (files.length <= SNAP_KEEP) return
    const dated = await Promise.all(
      files.map(async (f) => ({ f, t: (await stat(join(SNAP_DIR, f))).mtimeMs })),
    )
    dated.sort((a, b) => a.t - b.t)
    for (const { f } of dated.slice(0, dated.length - SNAP_KEEP)) await unlink(join(SNAP_DIR, f))
  })().catch(() => {})
}

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

/** last adapter-reported pose per robot (plus platform-side odo accumulation) */
export interface NavState {
  x: number
  z: number
  heading: number
  speed: number
  battery: number
  odo: number
  /** active run pinned here so robot-scoped pause/resume/abort resolve it */
  missionId?: string
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

export const EXTERNAL_STALE_MS = 20_000
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, info: 2, low: 3 }

// ============================================================ World

export class World {
  readonly id: string
  site: SiteInfo
  demo: boolean
  robots: RobotSpec[]
  cameras: SiteCamera[]
  waypoints: Waypoint[]
  zones: Zone[]
  buildings: Building[]
  dockWp: string
  splat?: { name: string; url: string }
  /** calibration transforms (stored) — merged with the occupancy-derived one in maps() */
  transforms: FrameTransform[] = []
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
  onEvent?: (ev: DetectionEvent) => void
  onReadings?: (batch: Reading[]) => void

  private wpById: Map<string, Waypoint>
  private ruleSeq = 1
  private evSeq = 1
  private missionSeq = 100
  private orderSeq = 1
  private tmplSeq = 1
  private schedSeq = 1
  private cmdSeq = 1
  private sessSeq = 1
  private thresholdClock = 0
  private thresholdLastFired = new Map<string, number>()
  private persist?: Persist

  constructor(rt: SiteRuntime, opts?: { persist?: Persist; demo?: boolean }) {
    this.id = rt.id
    this.persist = opts?.persist
    this.demo = opts?.demo ?? false
    this.site = {
      id: rt.id,
      name: rt.name,
      operator: rt.operator,
      bounds: rt.bounds,
      map: rt.map,
    }
    this.robots = [] // pure integration layer: units only ever arrive via registerExternal
    this.cameras = rt.cameras
    this.waypoints = rt.waypoints
    this.zones = rt.zones
    this.buildings = rt.buildings
    this.dockWp = rt.dockWp
    this.splat = rt.splat
    this.transforms = rt.transforms
    this.wpById = new Map(rt.waypoints.map((w) => [w.id, w]))
    this.eventTypes = [
      ...BUILTIN_MODELS.map((m) => ({ id: m, label: m, severity: 'info' as Severity, builtin: true })),
      { id: 'fault', label: 'robot fault', severity: 'high' as Severity, detail: 'Robot health stream', builtin: true },
    ]
  }

  /** replace the editable geometry (site builder saves) — takes effect live */
  setGeometry(g: { waypoints: Waypoint[]; zones: Zone[]; cameras: SiteCamera[]; dockWp: string; bounds?: SiteInfo['bounds'] }) {
    this.waypoints = g.waypoints
    this.zones = g.zones
    this.cameras = g.cameras
    this.dockWp = g.dockWp
    if (g.bounds) this.site.bounds = g.bounds
    this.wpById = new Map(g.waypoints.map((w) => [w.id, w]))
  }

  /** restore persisted ops state after a restart (blobs parsed by the caller's loader) */
  hydrate(ops: {
    rules: DetectionRule[]
    templates: MissionTemplate[]
    schedules: Schedule[]
    missions: Mission[]
    events: DetectionEvent[]
    orders: AdapterOrder[]
    readings: Reading[]
  }, seqs: { rule: number; ev: number; mission: number; order: number; tmpl: number; sched: number; cmd: number }) {
    this.rules = ops.rules
    this.templates = ops.templates
    this.schedules = ops.schedules
    this.missions = ops.missions
    this.events = ops.events // loader returns newest-first, matching pushEvent order
    this.orders = ops.orders
    for (const r of ops.readings) this.pushReading(r)
    this.ruleSeq = seqs.rule + 1
    this.evSeq = seqs.ev + 1
    this.missionSeq = Math.max(100, seqs.mission + 1)
    this.orderSeq = seqs.order + 1
    this.tmplSeq = seqs.tmpl + 1
    this.schedSeq = seqs.sched + 1
    this.cmdSeq = seqs.cmd + 1
    // an order the adapter had pulled (acked) but never settled is re-queued:
    // after a restart the vendor side has lost the in-flight run, so an acked
    // order would sit forever. Inspection runs are idempotent — re-dispatching
    // is safe even if the robot never actually stopped.
    for (const o of this.orders) {
      if (o.state === 'acked') {
        o.state = 'pending'
        this.persist?.order(o)
      }
    }
    // a run that was active when the platform died and whose order is gone
    // can never settle — fail it instead of showing a zombie forever
    for (const m of this.missions) {
      if (m.status !== 'active') continue
      const live = this.orders.some((o) => o.payload.missionId === m.id && (o.state === 'pending' || o.state === 'acked'))
      if (!live) {
        m.status = 'failed'
        m.endedAt = Date.now()
        m.results.push({
          ts: Date.now(), stepIdx: m.currentStep, waypointId: m.steps[m.currentStep]?.waypointId ?? '—',
          action: 'wait', ok: false, note: 'platform restarted mid-run — no live order to settle',
        })
        this.persist?.mission(m)
      }
    }
  }

  /** first-creation seeding (demo import / new site) — never re-runs on boot */
  seedFromDef(def: Pick<SiteDef, 'ruleSeeds' | 'missionSeeds'>) {
    for (const s of def.ruleSeeds) this.addRule({ kind: 'sim', ...s, enabled: true, builtin: true })
    this.seedMissions(def.missionSeeds)
  }

  /** watchdog: an active run that never settles (adapter died mid-mission,
   *  result report lost) would sit active forever — fail it after 6 h */
  sweepStaleRuns(maxAgeMs = 6 * 3600_000) {
    const now = Date.now()
    for (const m of this.missions) {
      if (m.status !== 'active' || !m.startedAt || now - m.startedAt < maxAgeMs) continue
      m.status = 'failed'
      m.endedAt = now
      m.results.push({
        ts: now,
        stepIdx: m.currentStep,
        waypointId: m.steps[m.currentStep]?.waypointId ?? '—',
        action: 'wait',
        ok: false,
        note: 'watchdog: run exceeded 6h without settling',
      })
      const s = m.robotId ? this.nav.get(m.robotId) : undefined
      if (s?.missionId === m.id) s.missionId = undefined
      this.persist?.mission(m)
    }
  }

  // ---------- fleet ----------

  private initNav(r: RobotSpec) {
    this.nav.set(r.id, {
      x: r.home.x,
      z: r.home.z,
      heading: 0,
      speed: 0,
      battery: r.batteryStart,
      odo: 0,
    })
  }

  robotBySerial(serial: string): RobotSpec | undefined {
    return this.robots.find((r) => r.serial === serial && r.adapter === 'external')
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
    if (typeof s.x === 'number' && typeof s.z === 'number') {
      // platform-side odometer: accumulate reported displacement (skip jitter
      // below 2 cm and >5 m teleports — re-localization, not travel)
      const d = Math.hypot(s.x - nav.x, s.z - nav.z)
      if (d > 0.02 && d < 5) nav.odo += d / 1000
      nav.x = s.x
      nav.z = s.z
    } else {
      if (typeof s.x === 'number') nav.x = s.x
      if (typeof s.z === 'number') nav.z = s.z
    }
    if (typeof s.heading === 'number') nav.heading = s.heading
    if (typeof s.speed === 'number') nav.speed = s.speed
    if (typeof s.battery === 'number') nav.battery = Math.max(0, Math.min(100, s.battery))
    return true
  }

  // ---------- channels + stream sessions ----------

  /** derive the channel list — robot payloads with footage plus fixed site cameras.
   *  RTSP is the production source kind; local demo loops stay `file`. */
  channels(robotId?: string): Channel[] {
    const srcOf = (url?: string, rtsp?: string): Channel['source'] =>
      rtsp || url?.startsWith('rtsp://')
        ? { kind: 'rtsp', url: rtsp || url! }
        : url
          ? { kind: 'file', file: url }
          : { kind: 'hls', url: '' }
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
          source: srcOf(p.file),
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
          source: srcOf(c.file, c.rtsp),
          streamKey: c.stream,
        })
    return out
  }

  /** channels for client consumption — RTSP URLs carry credentials and stay
   *  server-side; viewers only need the source kind (playback goes through
   *  session leases, snapshots through the evidence service) */
  publicChannels(robotId?: string): Channel[] {
    return this.channels(robotId).map((c) =>
      c.source.kind === 'rtsp' ? { ...c, source: { kind: 'rtsp' as const, url: '' } } : c,
    )
  }

  /** cameras for client consumption — same rule: rtsp:// (credentials) is
   *  admin-only, everyone else sees the camera minus its source URL */
  publicCameras(): SiteCamera[] {
    return this.cameras.map(({ rtsp: _rtsp, ...c }) => c)
  }

  /** where a snapshot for this stream key comes from (evidence service) */
  frameSource(streamKey: string): FrameSource | null {
    const ch = this.channels().find((c) => c.streamKey === streamKey || c.id === streamKey)
    if (!ch) return null
    if (ch.source.kind === 'rtsp') return { kind: 'rtsp', url: ch.source.url }
    if (ch.source.kind === 'file') {
      const base = ch.source.file.split('/').pop()
      return base ? { kind: 'file', file: base } : null
    }
    return null
  }

  /** open a playback lease. Demo file sources never expire; RTSP goes through
   *  the go2rtc relay — the session url is the relay stream name the web
   *  player passes to <BASE>/stream/api/ws?src=… */
  openSession(channelId: string): StreamSession | null {
    const ch = this.channels().find((c) => c.id === channelId)
    if (!ch) return null
    const id = `SS-${this.id}-${String(this.sessSeq++).padStart(4, '0')}`
    let s: StreamSession
    if (ch.source.kind === 'file') {
      s = { id, channelId, url: ch.source.file, protocol: 'file', createdAt: Date.now(), expiresAt: null }
    } else if (ch.source.kind === 'rtsp') {
      const name = relayName(this.id, ch.streamKey ?? ch.id)
      ensureRelayStream(name, ch.source.url)
      s = {
        id,
        channelId,
        url: name,
        protocol: 'mse',
        relayOnline: relayConfigured(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 120_000,
      }
    } else {
      s = { id, channelId, url: ch.source.url, protocol: 'hls', createdAt: Date.now(), expiresAt: Date.now() + 120_000 }
    }
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
    if (accepted.length) {
      this.persist?.readings(accepted)
      this.onReadings?.(accepted)
    }
    return accepted.length
  }

  /** threshold detectors: latest reading vs bound, 3 min per-rule cooldown */
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
    this.persist?.rule(rule)
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
    this.persist?.rule(r)
    return r
  }

  deleteRule(id: string) {
    const i = this.rules.findIndex((x) => x.id === id && !x.builtin)
    if (i < 0) return false
    this.rules.splice(i, 1)
    this.persist?.ruleDeleted(id)
    return true
  }

  // ---------- custom event vocabulary ----------

  addEventType(input: { id: string; label: string; severity?: Severity; detail?: string; category?: EventCategory }): EventTypeDef | null {
    const id = input.id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32)
    if (!id || this.eventTypes.some((t) => t.id === id)) return null
    const t: EventTypeDef = {
      id,
      label: input.label || id,
      severity: input.severity ?? 'info',
      detail: input.detail,
      category: input.category,
      builtin: false,
    }
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

  /** the ONE event constructor — id sequence, lifecycle defaults and the
   *  legacy snapshot mirror live here for every producer (rules + ingest) */
  private makeEvent(
    f: Omit<DetectionEvent, 'id' | 'lifecycle' | 'acked' | 'snapshot'> & { snapshot?: string },
  ): DetectionEvent {
    const ev: DetectionEvent = {
      ...f,
      id: `EV-${String(this.evSeq++).padStart(4, '0')}`,
      snapshot: f.snapshot ?? f.evidence.find((e) => e.kind === 'image')?.url,
      lifecycle: 'new',
      acked: false,
    }
    this.pushEvent(ev)
    this.persist?.event(ev)
    return ev
  }

  async generateEvent(
    rule?: DetectionRule,
    ts = Date.now(),
    opts?: { detail?: string; evidence?: EventEvidence[]; runId?: string },
  ): Promise<DetectionEvent | null> {
    const r = rule ?? this.pickRule()
    if (!r) return null
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
    r.firedCount++
    r.lastFiredAt = ts

    const evidence = opts?.evidence ?? []
    const src = this.frameSource(r.source)
    const frame = src ? await grabFrame(src) : null
    if (frame) {
      const file = `${this.id}_ev-${ts.toString(36)}-${Math.floor(Math.random() * 46_656).toString(36)}.jpg`
      writeFileSync(join(SNAP_DIR, file), frame)
      sweepSnapshots()
      evidence.unshift({
        kind: 'image',
        url: `${PUB}/api/snapshots/${file}`,
        channelId: this.channels().find((c) => c.streamKey === r.source)?.id,
      })
    }

    return this.makeEvent({
      ts,
      type: r.model,
      ruleId: r.id,
      label: r.name,
      detail: opts?.detail ?? DETAILS[r.model]?.() ?? typeDef?.detail ?? `${typeDef?.label ?? r.model} detection`,
      severity: r.severity,
      category: typeDef?.category ?? MODEL_CATEGORY[r.model] ?? 'equipment',
      source: r.source,
      sourceName: r.sourceName,
      robotId: r.robotId,
      zone: r.zone,
      confidence,
      evidence,
      runId: opts?.runId,
      x: +pos.x.toFixed(2),
      z: +pos.z.toFixed(2),
    })
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
    const ev = this.makeEvent({
      ts: input.ts ?? Date.now(),
      type: typeDef.id,
      ruleId: 'EXT',
      label: input.label ?? typeDef.label,
      detail: input.detail ?? typeDef.detail ?? 'Reported via integration API',
      severity: input.severity ?? typeDef.severity,
      category: input.category ?? typeDef.category ?? MODEL_CATEGORY[typeDef.id] ?? 'equipment',
      source: 'integration',
      sourceName: input.sourceName ?? (input.robotId ? this.robots.find((r) => r.id === input.robotId)?.callsign ?? 'adapter' : 'adapter'),
      robotId: input.robotId,
      zone: 'Site-wide',
      confidence: input.confidence ?? 1,
      snapshot: input.snapshotUrl,
      evidence,
      runId: input.runId,
      x: +(input.x ?? pos.x).toFixed(2),
      z: +(input.z ?? pos.z).toFixed(2),
    })
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
    this.persist?.event(ev)
    return ev
  }

  ackEvent(id: string) {
    return this.setLifecycle(id, 'acked')
  }

  async missionSnapshot(stream: string, missionId: string): Promise<string | undefined> {
    const src = this.frameSource(stream)
    const frame = src ? await grabFrame(src, 6000) : null
    if (!frame) return undefined
    const file = `${this.id}_${missionId}-${Date.now().toString(36)}.jpg`
    writeFileSync(join(SNAP_DIR, file), frame)
    sweepSnapshots()
    return `${PUB}/api/snapshots/${file}`
  }

  async seedEvents(eventSeedMins: number[]) {
    const now = Date.now()
    const plan = eventSeedMins.map((m) => ({ rule: this.pickRule()!, ago: m * 60_000 }))
    // force the most severe rules into the recent history so the board has depth
    const bySeverity = [...this.rules].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
    for (let i = 0; i < Math.min(4, bySeverity.length); i++) if (plan[i + 1]) plan[i + 1].rule = bySeverity[i]
    plan.sort((a, b) => b.ago - a.ago)
    for (const p of plan) await this.generateEvent(p.rule, now - p.ago)
    for (const e of this.events.slice(6)) {
      if (e.lifecycle === 'new') {
        e.lifecycle = Math.random() < 0.3 ? 'dismissed' : 'resolved'
        e.acked = true
        this.persist?.event(e)
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
    this.persist?.template(t)
    return t
  }

  deleteTemplate(id: string): boolean {
    const i = this.templates.findIndex((t) => t.id === id && !t.builtin)
    if (i < 0) return false
    this.templates.splice(i, 1)
    this.persist?.templateDeleted(id)
    for (const s of this.schedules.filter((x) => x.templateId === id)) this.persist?.scheduleDeleted(s.id)
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
    this.persist?.schedule(s)
    return s
  }

  patchSchedule(id: string, patch: { enabled?: boolean; cadence?: Cadence; assign?: Schedule['assign']; priority?: 1 | 2 | 3 }) {
    const s = this.schedules.find((x) => x.id === id)
    if (!s) return undefined
    Object.assign(s, patch)
    if (patch.cadence) s.nextRunAt = this.nextRun(patch.cadence, Date.now())
    this.persist?.schedule(s)
    return s
  }

  deleteSchedule(id: string): boolean {
    const i = this.schedules.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.schedules.splice(i, 1)
    this.persist?.scheduleDeleted(id)
    return true
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
      this.persist?.mission(m)
      this.persist?.schedule(s)
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
      // memory cap only — the finished run stays queryable in SQLite
      const i = this.missions.findIndex((x) => x.status === 'done' || x.status === 'aborted' || x.status === 'failed')
      if (i >= 0) this.missions.splice(i, 1)
    }
    this.persist?.mission(m)
    return m
  }

  pauseMission(id: string, paused: boolean): Mission | undefined {
    const m = this.missions.find((x) => x.id === id)
    if (!m || m.status !== 'active') return undefined
    m.paused = paused
    this.persist?.mission(m)
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
      if (s?.missionId === m.id) s.missionId = undefined
      // cancel any pending adapter order carrying this mission; if the adapter
      // already pulled it, follow up with an explicit abort order
      let acked = false
      for (const o of this.orders)
        if (o.payload.missionId === m.id) {
          if (o.state === 'pending') {
            o.state = 'failed'
            o.updatedAt = Date.now()
            this.persist?.order(o)
          } else if (o.state === 'acked' && o.kind === 'mission') acked = true
        }
      if (acked) this.enqueueOrder(m.robotId, 'abort', { missionId: m.id })
    }
    m.status = 'aborted'
    m.endedAt = Date.now()
    this.persist?.mission(m)
    return m
  }

  /** tap-to-dispatch: forwarded to the adapter as a goto order */
  teleopGoto(robotId: string, x: number, z: number): boolean {
    const r = this.robots.find((rb) => rb.id === robotId)
    if (!r || r.integrationLevel !== 'dispatchable') return false
    this.enqueueOrder(robotId, 'goto', { x, z })
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
      this.persist?.command(rec) // audit trail — retention-swept, not ring-capped
      return rec
    }
    const r = this.robots.find((x) => x.id === robotId)
    const s = this.nav.get(robotId)
    if (!r || !s) return done(false, 'unknown robot')
    const ext = this.externals.get(robotId)
    if (!ext || Date.now() - ext.lastSeen > EXTERNAL_STALE_MS) return done(false, 'robot offline')
    if (r.integrationLevel !== 'dispatchable') return done(false, 'external unit is state-only')

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
        // keep the dock semantic — the adapter may swap in the vendor's own
        // return-to-charge routine instead of plain navigation
        const dock = this.wpById.get(this.dockWp)
        if (!dock) return done(false, 'no dock waypoint configured for this site')
        this.enqueueOrder(robotId, 'goto', { x: dock.x, z: dock.z, dock: true })
        return done(true)
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
        this.enqueueOrder(robotId, 'announce', { text: cmd.text })
        return done(true)
      }
      case 'ptz': {
        const ch = this.channels(robotId).find((c) => c.id === cmd.channelId)
        if (!ch) return done(false, 'unknown channel')
        this.enqueueOrder(robotId, 'ptz', { channelId: ch.streamKey ?? ch.id, pan: cmd.pan, tilt: cmd.tilt, zoom: cmd.zoom })
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
    if (this.splat)
      maps.push({ id: 'splat', kind: 'splat', name: this.splat.name, url: this.splat.url })
    // stored calibration transforms (calibration UI / demo seeds) sit alongside
    // the occupancy-derived one
    transforms.push(...this.transforms)
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
    this.persist?.order(o)
    return o
  }

  pullOrders(robotId: string): AdapterOrder[] {
    const out = this.orders.filter((o) => o.robotId === robotId && o.state === 'pending')
    for (const o of out) {
      o.state = 'acked'
      o.updatedAt = Date.now()
      this.persist?.order(o)
    }
    return out
  }

  setOrderStatus(orderId: string, state: 'done' | 'failed', note?: string): AdapterOrder | undefined {
    const o = this.orders.find((x) => x.id === orderId)
    if (!o) return undefined
    o.state = state
    o.updatedAt = Date.now()
    this.persist?.order(o)
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
        this.persist?.mission(m)
      }
    }
    return o
  }

  // ---------- dispatcher ----------

  private assignQueued() {
    const queued = this.missions
      .filter((m) => m.status === 'queued')
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
    const now = Date.now()
    for (const m of queued) {
      const tmpl = m.templateId ? this.templates.find((t) => t.id === m.templateId) : undefined
      const candidates = this.robots.filter((r) => {
        if (r.integrationLevel !== 'dispatchable') return false
        // pinned requests dispatch unconditionally — the order queue is the
        // buffer, so a run survives the robot being briefly offline
        if (m.requestedRobot !== 'auto') return m.requestedRobot === r.id
        // auto-assignment only picks healthy, idle, capable units
        const ext = this.externals.get(r.id)
        if (!ext || now - ext.lastSeen > EXTERNAL_STALE_MS) return false
        const s = this.nav.get(r.id)!
        if (s.missionId || s.battery < 25) return false
        if (tmpl && !tmpl.requires.every((k) => r.payloads.some((p) => p.kind === k))) return false
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
      m.robotId = robot.id
      m.status = 'active'
      m.startedAt = now
      m.currentStep = 0
      m.progress = 0
      this.persist?.mission(m)
      // hand the whole mission to the adapter as one order (VDA5050-style);
      // pin nav.missionId so robot-scoped pause/resume/abort commands resolve it
      this.nav.get(robot.id)!.missionId = m.id
      this.enqueueOrder(robot.id, 'mission', { missionId: m.id, name: m.name, steps: m.steps })
    }
  }

  /** fire schedules, dispatch queued runs, snapshot telemetry for broadcast */
  tick(): Telemetry[] {
    const now = Date.now()
    this.tickSchedules(now)
    this.assignQueued()
    if (now - this.thresholdClock >= 3000) {
      this.thresholdClock = now
      this.checkThresholds(now)
    }
    const out: Telemetry[] = []
    for (const spec of this.robots) {
      const s = this.nav.get(spec.id)!
      const ext = this.externals.get(spec.id)
      const offline = !ext || now - ext.lastSeen > EXTERNAL_STALE_MS
      const m = s.missionId ? this.missions.find((x) => x.id === s.missionId) : undefined
      out.push({
        id: spec.id,
        x: +s.x.toFixed(2),
        z: +s.z.toFixed(2),
        heading: +s.heading.toFixed(3),
        speed: +s.speed.toFixed(2),
        battery: +s.battery.toFixed(1),
        rssi: offline ? -99 : -60,
        latency: offline ? 999 : 45,
        mode: offline ? 'offline' : ((ext.mode as Telemetry['mode']) ?? 'idle'),
        odoKm: +s.odo.toFixed(2),
        // gait derived from family + reported speed — drives the URDF twin's
        // walk/trot animation (adapters don't report gait explicitly)
        gait: offline
          ? '—'
          : spec.family === 'ugv'
            ? s.speed > 0.05
              ? 'diff-drive'
              : 'brake'
            : s.speed < 0.05
              ? 'stand'
              : s.speed > 1.4
                ? 'trot'
                : 'walk',
        joints: [], // no vendor protocol exposes joint temps — honest empty
        payloadHealth: Object.fromEntries(spec.payloads.map((p) => [p.id, 'ok'])),
        missionId: m?.id,
        missionName: m?.name,
        path: [],
        pathRemaining: 0,
      })
    }
    return out
  }

  // ---------- seeding (first site creation only — demo import / new site) ----------

  seedMissions(missionSeeds: SeedMissionDef[]) {
    let stagger = 0
    for (const seed of missionSeeds) {
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
        this.persist?.mission(m) // re-persist: backdated fields were set after creation
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
