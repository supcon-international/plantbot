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
  blurb: [string, string, string]
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
  builtin: boolean
}

export interface ApiKeyRec {
  id: string
  label: string
  key: string
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
  kind: 'goto' | 'mission'
  payload: { x?: number; z?: number; missionId?: string; name?: string }
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
export const BUILTIN_MODELS = ['person', 'smoking', 'thermal', 'gauge', 'ppe', 'motion', 'acoustic', 'ogi'] as const

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

export interface DetectionRule {
  id: string
  name: string
  model: DetectionModel
  source: string
  sourceName: string
  zone: string
  threshold: number
  severity: Severity
  enabled: boolean
  robotId?: string
  builtin: boolean
  lastFiredAt?: number
  firedCount: number
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
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--color-crit)',
  high: 'var(--color-warn)',
  info: 'var(--color-ink-2)',
  low: 'var(--color-low)',
}

export const MODE_LABEL: Record<RobotMode, string> = {
  idle: 'standby',
  navigating: 'navigating',
  executing: 'inspecting',
  teleop: 'teleop',
  charging: 'charging',
  offline: 'offline',
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
