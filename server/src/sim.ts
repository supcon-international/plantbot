import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROBOTS } from './fleet.js'
import { grabFrame } from './go2rtc.js'
import { nav, missions, tickMissions } from './missions.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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
  mode: 'idle' | 'navigating' | 'executing' | 'teleop' | 'charging'
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

export function tick(dt: number): Telemetry[] {
  tickMissions(dt)
  const now = Date.now()
  const out: Telemetry[] = []
  for (const spec of ROBOTS) {
    const s = nav.get(spec.id)!
    const m = s.missionId ? missions.find((x) => x.id === s.missionId) : undefined
    const jointNames = spec.family === 'ugv' ? UGV_JOINTS : QUAD_JOINTS
    const joints: JointTemp[] = jointNames.map((name, i) => ({
      name,
      c: +(41 + 4 * Math.sin(now / 9000 + i * 1.7) + 2 * Math.sin(now / 2300 + i) + (s.speed > 0.2 ? 3 : 0)).toFixed(1),
    }))
    out.push({
      id: spec.id,
      x: +s.x.toFixed(2),
      z: +s.z.toFixed(2),
      heading: +s.heading.toFixed(3),
      speed: +s.speed.toFixed(2),
      battery: +s.battery.toFixed(1),
      rssi: Math.round(-54 + 6 * Math.sin(now / 5000 + spec.ip.length)),
      latency: Math.round(22 + 10 * Math.abs(Math.sin(now / 3100))),
      mode: s.state,
      odoKm: +s.odo.toFixed(2),
      gait:
        spec.family === 'ugv'
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

export function robotPosition(id: string) {
  const s = nav.get(id)
  return s ? { x: s.x, z: s.z } : { x: 0, z: 0 }
}

// ---------- detection rules ----------

export type Severity = 'critical' | 'high' | 'info' | 'low'
export type DetectionModel = 'person' | 'smoking' | 'thermal' | 'gauge' | 'ppe' | 'motion' | 'acoustic' | 'ogi'

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
  firedCount: number
}

let ruleSeq = 1
export const rules: DetectionRule[] = []

function addRule(r: Omit<DetectionRule, 'id' | 'firedCount' | 'builtin'> & { builtin?: boolean }) {
  const rule: DetectionRule = {
    ...r,
    id: `RL-${String(ruleSeq++).padStart(2, '0')}`,
    builtin: r.builtin ?? true,
    firedCount: 0,
  }
  rules.push(rule)
  return rule
}

addRule({ name: 'Unbadged person in substation', model: 'person', source: 'x30-optical', sourceName: 'X30-01 · Optical', zone: 'Substation bay S-1', threshold: 0.7, severity: 'critical', enabled: true, robotId: 'x30-01' })
addRule({ name: 'Smoking behavior', model: 'smoking', source: 'workshop-cam', sourceName: 'Dock Camera', zone: 'Robot staging area', threshold: 0.75, severity: 'critical', enabled: true })
addRule({ name: 'Stack thermal anomaly', model: 'thermal', source: 'lite3-thermal', sourceName: 'Lite3-01 · Thermal', zone: 'Boiler stack, sector N', threshold: 0.65, severity: 'high', enabled: true, robotId: 'lite3-01' })
addRule({ name: 'Fugitive emission (OGI)', model: 'ogi', source: 'agx-ogi', sourceName: 'HSK·W1 · OGI', zone: 'Tank farm — ATEX', threshold: 0.6, severity: 'high', enabled: true, robotId: 'agx-w1' })
addRule({ name: 'Analog gauge OCR', model: 'gauge', source: 'lite3-front', sourceName: 'Lite3-01 · PTZ', zone: 'Valve manifold VM-4', threshold: 0.6, severity: 'info', enabled: true, robotId: 'lite3-01' })
addRule({ name: 'PPE compliance', model: 'ppe', source: 'workshop-cam', sourceName: 'Dock Camera', zone: 'Robot staging area', threshold: 0.6, severity: 'info', enabled: true })
addRule({ name: 'Perimeter motion', model: 'motion', source: 'perimeter-cam', sourceName: 'Perimeter — Reservoir Gate', zone: 'North fence, waterline', threshold: 0.55, severity: 'low', enabled: true })
addRule({ name: 'Partial discharge signature', model: 'acoustic', source: 'x30-optical', sourceName: 'X30-01 · Acoustic imager', zone: 'Transformer bay T-1', threshold: 0.7, severity: 'high', enabled: true, robotId: 'x30-01' })

export function createRule(input: {
  name: string
  model: DetectionModel
  source: string
  sourceName?: string
  zone?: string
  threshold?: number
  severity?: Severity
}) {
  return addRule({
    name: input.name,
    model: input.model,
    source: input.source,
    sourceName: input.sourceName ?? input.source,
    zone: input.zone ?? 'Site-wide',
    threshold: input.threshold ?? 0.6,
    severity: input.severity ?? 'info',
    enabled: true,
    builtin: false,
  })
}

export function patchRule(id: string, patch: Partial<Pick<DetectionRule, 'enabled' | 'threshold' | 'severity' | 'name'>>) {
  const r = rules.find((x) => x.id === id)
  if (!r) return undefined
  Object.assign(r, patch)
  return r
}

export function deleteRule(id: string) {
  const i = rules.findIndex((x) => x.id === id && !x.builtin)
  if (i < 0) return false
  rules.splice(i, 1)
  return true
}

// ---------- events ----------

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

const DETAILS: Record<DetectionModel, () => string> = {
  person: () => `Unbadged person detected, dwell ${(4 + Math.random() * 8).toFixed(0)}s · tracking on`,
  smoking: () => 'Cigarette signature, confidence high · zone is ATEX-rated',
  thermal: () => `ΔT +${(9 + Math.random() * 9).toFixed(1)} °C vs. baseline · plume widening`,
  ogi: () => `CH₄ plume candidate · column density ${(220 + Math.random() * 400).toFixed(0)} ppm·m`,
  gauge: () => `Pressure ${(5.8 + Math.random() * 1.2).toFixed(1)} bar — within nominal band`,
  ppe: () => `${5 + Math.floor(Math.random() * 3)}/8 operators in frame, all compliant`,
  motion: () => 'Filtered as wildlife / vegetation sway · no action',
  acoustic: () => `38 kHz band energy +${(6 + Math.random() * 6).toFixed(1)} dB at bushing`,
}

const WEIGHTS: Record<DetectionModel, number> = {
  gauge: 2.2,
  ppe: 1.7,
  motion: 1.8,
  thermal: 1.3,
  ogi: 1.1,
  acoustic: 0.9,
  person: 1.1,
  smoking: 0.5,
}

const events: DetectionEvent[] = []
let seq = 1

function pickRule(): DetectionRule | undefined {
  const enabled = rules.filter((r) => r.enabled)
  if (!enabled.length) return undefined
  const total = enabled.reduce((a, r) => a + (WEIGHTS[r.model] ?? 1), 0)
  let x = Math.random() * total
  for (const r of enabled) {
    x -= WEIGHTS[r.model] ?? 1
    if (x <= 0) return r
  }
  return enabled[0]
}

export async function generateEvent(rule?: DetectionRule, ts = Date.now()): Promise<DetectionEvent | null> {
  const r = rule ?? pickRule()
  if (!r) return null
  const id = `EV-${String(seq++).padStart(4, '0')}`
  const side = Math.random() > 0.5 ? 1 : -1
  const pos = r.robotId
    ? robotPosition(r.robotId)
    : { x: -13 + Math.random() * 26, z: side * (4.2 + Math.random() * 3.6) }
  const confidence = +(r.threshold + Math.random() * (1 - r.threshold) * 0.9).toFixed(2)

  const ev: DetectionEvent = {
    id,
    ts,
    type: r.model,
    ruleId: r.id,
    label: r.name,
    detail: DETAILS[r.model](),
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

  const frame = await grabFrame(r.source)
  if (frame) {
    const file = `${id}-${ts.toString(36)}.jpg`
    writeFileSync(join(SNAP_DIR, file), frame)
    ev.snapshot = `/api/snapshots/${file}`
  }

  events.unshift(ev)
  if (events.length > 400) events.pop()
  return ev
}

export function listEvents(limit = 100) {
  return events.slice(0, limit)
}

export function ackEvent(id: string) {
  const ev = events.find((e) => e.id === id)
  if (ev) ev.acked = true
  return ev
}

/** Save a mission action snapshot; returns the public URL. */
export async function missionSnapshot(stream: string, missionId: string): Promise<string | undefined> {
  const frame = await grabFrame(stream, 6000)
  if (!frame) return undefined
  const file = `${missionId}-${Date.now().toString(36)}.jpg`
  writeFileSync(join(SNAP_DIR, file), frame)
  return `/api/snapshots/${file}`
}

/** Seed a believable history so the UI isn't empty on first load. */
export async function seedEvents() {
  const now = Date.now()
  const mins = [3, 7, 12, 19, 26, 34, 47, 58, 73, 95, 121, 148, 176, 204]
  const plan = mins.map((m) => ({ rule: pickRule()!, ago: m * 60_000 }))
  plan[1].rule = rules[0] // person
  plan[3].rule = rules[2] // thermal
  plan[4].rule = rules[3] // ogi
  plan[5].rule = rules[1] // smoking
  plan.sort((a, b) => b.ago - a.ago)
  for (const p of plan) await generateEvent(p.rule, now - p.ago)
  for (const e of events.slice(6)) e.acked = true
}
