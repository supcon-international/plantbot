export interface PayloadSpec {
  id: string
  name: string
  kind: 'camera' | 'thermal' | 'ogi' | 'lidar' | 'gas' | 'acoustic' | 'imu'
  model: string
  stream?: string
  file?: string
  detail: string
}

export interface RobotSpec {
  id: string
  callsign: string
  vendor: string
  model: string
  family: 'quadruped' | 'ugv'
  urdf: string
  serial: string
  firmware: string
  ip: string
  protocol: string
  massKg: number
  ipRating: string
  maxSpeed: number
  enduranceMin: number
  payloads: PayloadSpec[]
  batteryStart: number
  color: string
  home: { x: number; z: number }
  /** 'sim' built-in twin · 'external' integration-API adapter */
  adapter?: 'sim' | 'external'
  integrationLevel?: 'state-only' | 'dispatchable'
}

export interface SiteCamera {
  id: string
  name: string
  place: string
  stream: string
  /** production RTSP source — relayed via go2rtc, snapshotted via ffmpeg */
  rtsp?: string
  /** demo loop under /media (dev fallback) */
  file?: string
  live: boolean
  source: string
}

export interface Waypoint {
  id: string
  name: string
  x: number
  z: number
  kind: 'nav' | 'inspect' | 'dock'
}

export interface Zone {
  id: string
  name: string
  kind: 'restricted' | 'inspection' | 'charging'
  polygon: [number, number][]
  label?: { x: number; z: number; anchor?: 'start' | 'middle' | 'end' } | null
}

export type Building =
  | { id: string; kind: 'box'; x0: number; z0: number; x1: number; z1: number; h: number; tone?: 'light' | 'mid'; name?: string; order?: number }
  | { id: string; kind: 'cyl'; cx: number; cz: number; r: number; h: number; tone?: 'light' | 'mid'; name?: string; order?: number }

export interface RobotModelSpec {
  model: string
  vendor: string
  family: 'quadruped' | 'ugv'
  urdf: string
  massKg: number
  ipRating: string
  maxSpeed: number
  enduranceMin: number
  protocol: string
  firmware: string
  blurb: [string, string]
}

export interface SiteMapMeta {
  image: string
  resolution: number
  width: number
  height: number
  origin: [number, number]
  source: string
}

export interface SiteInfo {
  id: string
  name: string
  operator: string
  bounds: { x: number[]; z: number[] }
  map: SiteMapMeta | null
}

export type Role = 'viewer' | 'operator' | 'admin'

export interface SiteSummary {
  id: string
  name: string
  operator: string
  role: Role
  robots?: number
  openAlerts?: number
}

export interface Me {
  user: { username: string; displayName: string; roles: Record<string, Role> } | null
  sites: SiteSummary[]
}

export interface EventTypeDef {
  id: string
  label: string
  severity: Severity
  detail?: string
  category?: EventCategory
  builtin: boolean
}

export interface ApiKeyRec {
  id: string
  label: string
  /** masked display — the plaintext key is returned exactly once, on creation */
  prefix: string
  createdAt: number
  lastUsedAt?: number
}

export interface ExternalUnit {
  id: string
  serial: string
  callsign: string
  model: string
  level?: 'state-only' | 'dispatchable'
  lastSeen: number
  online: boolean
  mode?: string
}

export interface AdapterOrder {
  id: string
  robotId: string
  kind: 'goto' | 'mission' | 'announce'
  payload: { x?: number; z?: number; missionId?: string; name?: string; text?: string }
  state: 'pending' | 'acked' | 'done' | 'failed'
  createdAt: number
  updatedAt: number
}

export interface JointTemp {
  name: string
  c: number
}

export type RobotMode = 'idle' | 'navigating' | 'executing' | 'teleop' | 'charging' | 'offline'

export interface Telemetry {
  id: string
  x: number
  z: number
  heading: number
  speed: number
  battery: number
  rssi: number
  latency: number
  mode: RobotMode
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

export type Severity = 'critical' | 'high' | 'info' | 'low'
/** open vocabulary — built-in detection models plus site-registered custom event types */
export type DetectionModel = string

export type EventCategory = 'security' | 'fire' | 'env' | 'equipment' | 'robot-fault'
export type EventLifecycle = 'new' | 'acked' | 'resolved' | 'dismissed'
export type DetectorKind = 'sim' | 'onboard-cv' | 'cloud-cv' | 'threshold' | 'external'

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
  snapshot?: string
  evidence: EventEvidence[]
  lifecycle: EventLifecycle
  acked: boolean
  runId?: string
  x: number
  z: number
}

export interface DetectionRule {
  id: string
  name: string
  model: DetectionModel
  kind: DetectorKind
  source: string
  sourceName: string
  zone: string
  threshold: number
  severity: Severity
  enabled: boolean
  robotId?: string
  builtin: boolean
  metric?: string
  op?: '>' | '<'
  bound?: number
  lastFiredAt?: number
  firedCount: number
}

// ---------- channels + stream sessions ----------

export type ChannelRole = 'front' | 'optical' | 'ptz' | 'thermal' | 'ogi' | 'audio' | 'fixed'

export interface Channel {
  id: string
  robotId?: string
  payloadId?: string
  role: ChannelRole
  label: string
  codec: 'h264' | 'h265' | 'mjpeg' | 'opus'
  source: { kind: 'file'; file: string } | { kind: 'rtsp' | 'hls' | 'webrtc'; url: string }
  streamKey?: string
}

export interface StreamSession {
  id: string
  channelId: string
  url: string
  protocol: 'file' | 'hls' | 'webrtc' | 'rtsp' | 'mse'
  /** mse only: false → MEDIA_RELAY (go2rtc) not configured server-side */
  relayOnline?: boolean
  createdAt: number
  expiresAt: number | null
}

// ---------- payload readings ----------

export interface MetricDef {
  id: string
  label: string
  unit: string
  kind: 'gauge' | 'counter'
  nominal?: [number, number]
  decimals: number
}

export interface Reading {
  robotId: string
  payloadId: string
  metric: string
  value: number
  ts: number
  quality?: 'ok' | 'degraded' | 'stale'
  wp?: string
}

// ---------- mission templates + schedules ----------

export interface MissionTemplate {
  id: string
  name: string
  steps: MissionStep[]
  requires: PayloadSpec['kind'][]
  builtin: boolean
  createdAt: number
}

export type Cadence =
  | { kind: 'once'; at?: number }
  | { kind: 'interval'; everyMin: number }
  | { kind: 'weekly'; days: number[]; at: string }

export interface Schedule {
  id: string
  templateId: string
  assign: { kind: 'auto' } | { kind: 'robot'; robotId: string }
  cadence: Cadence
  priority: 1 | 2 | 3
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
}

// ---------- maps + commands ----------

export interface MapAsset {
  id: string
  kind: 'occupancy' | 'splat' | 'aerial'
  name: string
  url: string
  occupancy?: { resolution: number; origin: [number, number]; width: number; height: number }
}

export interface FrameTransform {
  from: string
  to: string
  params: { s: number; thetaRad: number; t: [number, number] }
  note?: string
}

export type Command =
  | { type: 'goto'; wp?: string; x?: number; z?: number }
  | { type: 'dock' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'abort' }
  | { type: 'announce'; text: string; priority?: number }
  | { type: 'ptz'; channelId: string; pan?: number; tilt?: number; zoom?: number }

export interface CommandRecord {
  id: string
  robotId: string
  ts: number
  by: string
  command: Command
  accepted: boolean
  reason?: string
}

export type ActionType =
  | 'capture_photo'
  | 'thermal_scan'
  | 'ogi_scan'
  | 'gas_sample'
  | 'acoustic_scan'
  | 'gauge_read'
  | 'wait'

export interface MissionStep {
  waypointId: string
  actions: { type: ActionType; durationS: number }[]
}

export interface MissionResult {
  ts: number
  stepIdx: number
  waypointId: string
  action: ActionType
  ok: boolean
  note: string
  snapshot?: string
}

export type MissionStatus = 'queued' | 'active' | 'done' | 'failed' | 'aborted'

export interface Mission {
  id: string
  name: string
  priority: 1 | 2 | 3
  requestedRobot: string
  robotId?: string
  recurring: boolean
  status: MissionStatus
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

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--color-crit)',
  high: 'var(--color-warn)',
  info: 'var(--color-ink-2)',
  low: 'var(--color-low)',
}

export const ACTION_TYPES: ActionType[] = [
  'capture_photo',
  'thermal_scan',
  'ogi_scan',
  'gas_sample',
  'acoustic_scan',
  'gauge_read',
  'wait',
]
