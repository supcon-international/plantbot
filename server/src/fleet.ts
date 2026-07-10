// Shared fleet types + the cross-site provisioning catalogs.
// Per-site data (yards, waypoints, seed fleets) lives in sites.ts;
// runtime state lives in world.ts (one World instance per site).

// sub-path deploys: URLs handed to the client get this prefix (e.g. /robots)
const PUB = process.env.PUBLIC_BASE ?? ''
const media = (f: string) => `${PUB}/media/${f}`

export interface PayloadSpec {
  id: string
  name: string
  kind: 'camera' | 'thermal' | 'ogi' | 'lidar' | 'gas' | 'acoustic' | 'imu'
  model: string
  stream?: string
  /** loop-demo file served from /media — plays natively, zero transcode */
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
  /** 'sim' (built-in twin) or 'external' (integration API — VDA5050-style adapter) */
  adapter?: 'sim' | 'external'
  /** external units: Open-RMF-style mixed control levels */
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
  /** label anchor on the map — null suppresses (a roof label carries the name) */
  label?: { x: number; z: number; anchor?: 'start' | 'middle' | 'end' } | null
}

/** clay-model massing for the ops map (screen-space extruded) */
export type Building =
  | { id: string; kind: 'box'; x0: number; z0: number; x1: number; z1: number; h: number; tone?: 'light' | 'mid'; name?: string; order?: number }
  | { id: string; kind: 'cyl'; cx: number; cz: number; r: number; h: number; tone?: 'light' | 'mid'; name?: string; order?: number }

/** ROS map_server-style occupancy underlay (top-left pixel at origin, x→east, z→south) */
export interface SiteMapMeta {
  image: string
  resolution: number // m / px
  width: number // px
  height: number // px
  origin: [number, number] // scene coords of the image's top-left pixel
  source: string
}

export interface SiteInfo {
  id: string
  name: string
  operator: string
  bounds: { x: [number, number]; z: [number, number] }
  map: SiteMapMeta | null
}

// ---------- shared detection / mission vocab ----------

export type Severity = 'critical' | 'high' | 'info' | 'low'

/** open string — built-ins below plus site-registered custom event types */
export type DetectionModel = string
export const BUILTIN_MODELS = ['person', 'smoking', 'thermal', 'gauge', 'ppe', 'motion', 'acoustic', 'ogi'] as const

/** business stream an event belongs to — robot-fault is the health stream, the rest are operational */
export type EventCategory = 'security' | 'fire' | 'env' | 'equipment' | 'robot-fault'
export const MODEL_CATEGORY: Record<string, EventCategory> = {
  person: 'security',
  motion: 'security',
  ppe: 'security',
  smoking: 'fire',
  thermal: 'equipment',
  gauge: 'equipment',
  acoustic: 'equipment',
  ogi: 'env',
  fault: 'robot-fault',
}

// ---------- channels (video/audio surfaces, one robot exposes several) ----------

export type ChannelRole = 'front' | 'optical' | 'ptz' | 'thermal' | 'ogi' | 'audio' | 'fixed'

export interface Channel {
  id: string // 'go2-01:cam-front' | 'cam:perimeter-cam'
  robotId?: string // absent → fixed site camera
  payloadId?: string
  role: ChannelRole
  label: string
  codec: 'h264' | 'h265' | 'mjpeg' | 'opus'
  /** how the platform reaches it — the UI never sees this, only sessions */
  source: { kind: 'file'; file: string } | { kind: 'rtsp' | 'hls' | 'webrtc'; url: string }
  /** snapshot / legacy stream key (frames.ts SOURCE table) */
  streamKey?: string
}

/** explicit playback lease — GoRobot's implicit 10-second URL, made a resource */
export interface StreamSession {
  id: string
  channelId: string
  url: string
  protocol: 'file' | 'hls' | 'webrtc' | 'rtsp'
  createdAt: number
  /** null → static demo loop, never expires */
  expiresAt: number | null
}

// ---------- payload readings (stable envelope + metric registry) ----------

export interface MetricDef {
  id: string // 'ch4.ppm'
  label: string
  unit: string
  kind: 'gauge' | 'counter'
  /** normal band — UI shades it, threshold detectors reference it */
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
  /** waypoint the robot was at, when captured during a mission step */
  wp?: string
}

export const METRIC_DEFS: MetricDef[] = [
  { id: 'ch4.ppm', label: 'CH₄', unit: 'ppm', kind: 'gauge', nominal: [0, 6], decimals: 2 },
  { id: 'h2s.ppm', label: 'H₂S', unit: 'ppm', kind: 'gauge', nominal: [0, 1], decimals: 2 },
  { id: 'co.ppm', label: 'CO', unit: 'ppm', kind: 'gauge', nominal: [0, 9], decimals: 1 },
  { id: 'o2.pct', label: 'O₂', unit: '%', kind: 'gauge', nominal: [19.5, 23], decimals: 2 },
  { id: 'dt.max.c', label: 'max ΔT', unit: '°C', kind: 'gauge', nominal: [0, 14], decimals: 1 },
  { id: 'uls.db', label: '38 kHz band', unit: 'dB', kind: 'gauge', nominal: [0, 11], decimals: 1 },
  { id: 'ch4.ppmm', label: 'CH₄ column', unit: 'ppm·m', kind: 'gauge', nominal: [0, 600], decimals: 0 },
  { id: 'vib.g', label: 'vibration', unit: 'g', kind: 'gauge', nominal: [0, 0.4], decimals: 3 },
  // ambient set — service-patrol units (e.g. Gosuncn F2) report these
  { id: 'amb.temp.c', label: 'ambient', unit: '°C', kind: 'gauge', nominal: [-5, 38], decimals: 1 },
  { id: 'amb.rh.pct', label: 'humidity', unit: '%RH', kind: 'gauge', nominal: [20, 85], decimals: 0 },
  { id: 'noise.db', label: 'noise', unit: 'dB(A)', kind: 'gauge', nominal: [30, 70], decimals: 1 },
]

/** which metrics a payload kind emits — new sensors are data, not schema */
export const PAYLOAD_METRICS: Partial<Record<PayloadSpec['kind'], string[]>> = {
  gas: ['ch4.ppm', 'h2s.ppm', 'co.ppm', 'o2.pct'],
  thermal: ['dt.max.c'],
  acoustic: ['uls.db'],
  ogi: ['ch4.ppmm'],
  imu: ['vib.g'],
}

// ---------- commands (semantic, server-validated) ----------

export type Command =
  | { type: 'goto'; wp?: string; x?: number; z?: number }
  | { type: 'dock' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'abort' }
  | { type: 'announce'; text: string; priority?: number }
  | { type: 'ptz'; channelId: string; pan?: number; tilt?: number; zoom?: number }
  | { type: 'velocity'; vx: number; wz: number }

export interface CommandRecord {
  id: string
  robotId: string
  ts: number
  by: string
  command: Command
  accepted: boolean
  reason?: string
}

// ---------- maps (first-class assets + explicit calibration) ----------

export interface MapAsset {
  id: string
  kind: 'occupancy' | 'splat' | 'aerial'
  name: string
  /** starts with '/' → server URL (PUB applied); else web-relative (client prepends BASE) */
  url: string
  occupancy?: { resolution: number; origin: [number, number]; width: number; height: number }
}

/** similarity transform between frames: p' = s·R(θ)·p + t */
export interface FrameTransform {
  from: string // 'map:<id>' | 'world' | 'wgs84'
  to: string
  params: { s: number; thetaRad: number; t: [number, number] }
  note?: string
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

/** which payload kinds a step's actions need — drives auto-assignment */
export const ACTION_REQUIRES: Partial<Record<ActionType, PayloadSpec['kind']>> = {
  thermal_scan: 'thermal',
  ogi_scan: 'ogi',
  gas_sample: 'gas',
  acoustic_scan: 'acoustic',
}

// ---------- mission three-layer split: template (route) / schedule / run ----------

/** reusable route — site-level, never bound to one robot (contra GoRobot) */
export interface MissionTemplate {
  id: string
  name: string
  steps: MissionStep[]
  /** payload kinds a runner must carry (derived from steps at creation) */
  requires: PayloadSpec['kind'][]
  builtin: boolean
  createdAt: number
}

export type Cadence =
  | { kind: 'once'; at?: number }
  | { kind: 'interval'; everyMin: number }
  | { kind: 'weekly'; days: number[]; at: string } // days 0-6 (Sun-Sat), at 'HH:MM'

export interface Schedule {
  id: string
  templateId: string
  /** auto → capability match (requires ⊆ payload kinds); robot → pinned */
  assign: { kind: 'auto' } | { kind: 'robot'; robotId: string }
  cadence: Cadence
  priority: 1 | 2 | 3
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
}

/** site-registered custom event type (integration API vocabulary) */
export interface EventTypeDef {
  id: string
  label: string
  severity: Severity
  detail?: string
  builtin: boolean
}

// ---------- provisioning catalog (InOrbit-Connect-style directory) ----------

export interface RobotModelSpec {
  model: string
  vendor: string
  family: 'quadruped' | 'ugv'
  /** empty string → no 3D twin yet, UI falls back to a silhouette */
  urdf: string
  massKg: number
  ipRating: string
  maxSpeed: number
  enduranceMin: number
  protocol: string
  firmware: string
  blurb: [string, string] // en / zh
}

export const ROBOT_CATALOG: RobotModelSpec[] = [
  {
    model: 'Jueying Lite3',
    vendor: 'DEEP Robotics 云深处科技',
    family: 'quadruped',
    urdf: 'lite3',
    massKg: 12,
    ipRating: 'IP54',
    maxSpeed: 2.5,
    enduranceMin: 90,
    protocol: 'ROS2 / DDS · 5G-U',
    firmware: 'v2.4.1-rc3',
    blurb: [
      'Agile indoor/yard patrol quadruped',
      '轻型敏捷四足,适合室内与场区巡逻',
    ],
  },
  {
    model: 'Jueying X30',
    vendor: 'DEEP Robotics 云深处科技',
    family: 'quadruped',
    urdf: 'x30',
    massKg: 56,
    ipRating: 'IP67',
    maxSpeed: 4.0,
    enduranceMin: 150,
    protocol: 'ROS2 / DDS · Wi-Fi 6 mesh',
    firmware: 'v3.1.0',
    blurb: [
      'Industrial all-weather inspection flagship',
      '全天候工业巡检旗舰,防护等级 IP67',
    ],
  },
  {
    model: 'Lynx M20',
    vendor: 'DEEP Robotics 云深处科技',
    family: 'quadruped',
    urdf: '',
    massKg: 33,
    ipRating: 'IP66',
    maxSpeed: 5.0,
    enduranceMin: 180,
    protocol: 'ROS2 / DDS · 5G-U',
    firmware: 'v1.2.0',
    blurb: [
      'Wheel-legged hybrid for rough terrain · 3D twin pending',
      '轮足复合构型,复杂地形通行 · 3D 模型待接入',
    ],
  },
  {
    model: 'Go2 EDU',
    vendor: 'Unitree 宇树科技',
    family: 'quadruped',
    urdf: 'go2',
    massKg: 15,
    ipRating: 'IP55',
    maxSpeed: 3.7,
    enduranceMin: 120,
    protocol: 'ROS2 / DDS · Wi-Fi 6',
    firmware: 'v1.1.5',
    blurb: [
      'Agile quadruped for corridor and rack inspection',
      '敏捷四足,适合廊道与机柜巡检',
    ],
  },
  {
    model: 'ANYmal C',
    vendor: 'ANYbotics',
    family: 'quadruped',
    urdf: 'anymal',
    massKg: 50,
    ipRating: 'IP67',
    maxSpeed: 1.3,
    enduranceMin: 120,
    protocol: 'ROS2 / DDS · LTE',
    firmware: 'v23.04',
    blurb: [
      'Autonomous industrial inspection benchmark, Ex-proof option',
      '工业巡检标杆机型,可选防爆版本',
    ],
  },
  {
    model: 'Husky A200',
    vendor: 'Clearpath Robotics',
    family: 'ugv',
    urdf: 'husky',
    massKg: 50,
    ipRating: 'IP44',
    maxSpeed: 1.0,
    enduranceMin: 180,
    protocol: 'ROS2 / DDS · Ethernet',
    firmware: 'v2.1.4',
    blurb: [
      'Proven payload mule for heavy sensor stacks',
      '成熟轮式平台,适合重型传感器载荷',
    ],
  },
  {
    model: 'GS Patrol F2',
    vendor: 'Gosuncn Robotics 高新兴',
    family: 'ugv',
    urdf: '', // third-party unit — connects via the integration API, silhouette twin
    massKg: 150,
    ipRating: 'IP55',
    maxSpeed: 1.6,
    enduranceMin: 480,
    protocol: 'Integration API v1 (vendor adapter)',
    firmware: 'GRobot 5.x',
    blurb: [
      'Security service-patrol UGV — PTZ mast, loudspeaker, ambient sensing',
      '安保服务巡逻机器人——云台桅杆、喊话器、环境感知,经集成 API 接入',
    ],
  },
]

/** payload directory — instances are cloned onto robots at install time */
export const PAYLOAD_CATALOG: PayloadSpec[] = [
  {
    id: 'ptz-4mp',
    name: 'Front PTZ Camera',
    kind: 'camera',
    model: '4MP · 25× optical zoom',
    file: media('switchgear.mp4'),
    detail: 'H.264 1080p25 · gimbal-stabilized · IR-cut',
  },
  {
    id: 'optical-4k',
    name: 'Optical Zoom Camera',
    kind: 'camera',
    model: '4K · 30× hybrid zoom',
    file: media('substation.mp4'),
    detail: 'Person / PPE / behavior analytics on-board',
  },
  {
    id: 'thermal-640',
    name: 'Thermal Imager',
    kind: 'thermal',
    model: '640×512 radiometric · <40mK NETD',
    file: media('thermal.mp4'),
    detail: 'Radiometric video, ΔT alarm thresholds',
  },
  {
    id: 'ogi-320',
    name: 'OGI Gas Camera',
    kind: 'ogi',
    model: '320×240 cooled InSb · CH₄/VOC',
    file: media('ogi.mp4'),
    detail: 'Optical gas imaging, ppm·m quantification',
  },
  {
    id: 'lidar-m360',
    name: '3D LiDAR',
    kind: 'lidar',
    model: 'Mid-360 · 360°×59° FOV',
    detail: '200k pts/s · SLAM + obstacle avoidance',
  },
  {
    id: 'gas-4in1',
    name: 'Gas Detector',
    kind: 'gas',
    model: 'CH₄ · CO · H₂S · O₂',
    detail: 'Pump-sampled, 1 Hz, auto-calibrating',
  },
  {
    id: 'acoustic-124',
    name: 'Acoustic Imager',
    kind: 'acoustic',
    model: '124-mic array · 2–48 kHz',
    detail: 'Partial discharge & gas-leak localization',
  },
  {
    id: 'imu-6x',
    name: 'IMU / Odometry',
    kind: 'imu',
    model: '6-axis · 200 Hz',
    detail: 'Fused odometry, slip detection',
  },
]

export const UNIT_COLORS = ['#ebebe8', '#b4b4ac', '#8a8a82', '#d6d6ce', '#c2c2ba']
export const MODEL_CODE: Record<string, string> = {
  'Jueying Lite3': 'L3',
  'Jueying X30': 'X30',
  'Lynx M20': 'M20',
  'Husky A200': 'HSK',
  'Go2 EDU': 'GO2',
  'ANYmal C': 'ANY',
}
