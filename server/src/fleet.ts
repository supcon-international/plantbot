// Fleet registry — robots, payloads, site cameras, waypoints, zones.
// Scene frame: meters, origin at yard center, x → east, z → south.

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

export const SITE = {
  id: 'plant-07',
  name: 'Plant 07',
  operator: 'Plantbot Operations',
  bounds: { x: [-16, 16], z: [-9, 9] },
  map: {
    image: '/assets/maps/yard-07.png',
    resolution: 0.05,
    width: 640,
    height: 360,
    origin: [-16, -9],
    source: 'slam_toolbox · JY·L3-01 · 2026-06-30',
  },
}

export const WAYPOINTS: Waypoint[] = [
  { id: 'WP-01', name: 'North gate', x: -12, z: -4.9, kind: 'nav' },
  { id: 'WP-02', name: 'Manifold VM-4', x: -4, z: -5.3, kind: 'inspect' },
  { id: 'WP-03', name: 'Stack cluster N', x: 4, z: -4.9, kind: 'inspect' },
  { id: 'WP-04', name: 'East switch', x: 12, z: -4.6, kind: 'nav' },
  { id: 'WP-05', name: 'Substation apron', x: -9.4, z: 4.9, kind: 'inspect' },
  { id: 'WP-06', name: 'Bay B2 door', x: -3, z: 5.0, kind: 'nav' },
  { id: 'WP-07', name: 'Transfer pumps', x: 5, z: 4.7, kind: 'inspect' },
  { id: 'WP-08', name: 'Tank farm', x: 11, z: 5.0, kind: 'inspect' },
  { id: 'WP-09', name: 'Charge dock', x: -11.5, z: -6.9, kind: 'dock' },
  { id: 'WP-10', name: 'Workshop ramp', x: 10.5, z: -4.2, kind: 'nav' },
  { id: 'WP-11', name: 'North fence mid', x: 0, z: -7.2, kind: 'nav' },
  { id: 'WP-12', name: 'South fence mid', x: 0, z: 7.2, kind: 'nav' },
  { id: 'WP-13', name: 'Truck bay', x: 7.2, z: -1.2, kind: 'inspect' },
]

// massing mirrors planner.ts RECTS / gen_occupancy.py
export const BUILDINGS: Building[] = [
  { id: 'substation', kind: 'box', x0: -14.8, z0: 4.4, x1: -10.2, z1: 8.5, h: 2.4, name: 'SUBSTATION' },
  { id: 'substation-gear', kind: 'box', x0: -14.2, z0: 5.0, x1: -12.8, z1: 6.2, h: 3.4, tone: 'mid', order: 1 },
  { id: 'workshop', kind: 'box', x0: 8.0, z0: -7.4, x1: 13.8, z1: -4.9, h: 2.6, name: 'WORKSHOP' },
  { id: 'charge-depot', kind: 'box', x0: -15.4, z0: -8.0, x1: -12.4, z1: -5.8, h: 1.4, name: 'CHARGE DEPOT' },
  { id: 'tank-a', kind: 'cyl', cx: 13.7, cz: 6.2, r: 1.15, h: 2.8, name: 'TK·A' },
  { id: 'tank-b', kind: 'cyl', cx: 13.8, cz: 2.9, r: 0.95, h: 2.3, name: 'TK·B' },
  { id: 'truck-bed', kind: 'box', x0: -3.2, z0: -3.0, x1: 5.0, z1: 0.6, h: 0.9, tone: 'mid' },
  { id: 'truck-cab', kind: 'box', x0: -5.0, z0: -2.6, x1: -3.2, z1: 0.2, h: 1.5, tone: 'mid' },
  { id: 'pallet-w', kind: 'box', x0: -9.5, z0: -0.8, x1: -8.4, z1: 0.1, h: 0.55, tone: 'mid' },
  { id: 'pallet-e', kind: 'box', x0: 8.2, z0: 1.8, x1: 9.3, z1: 2.7, h: 0.55, tone: 'mid' },
  { id: 'pallet-s', kind: 'box', x0: -2.5, z0: 3.2, x1: -1.4, z1: 4.1, h: 0.55, tone: 'mid' },
]

export const ZONES: Zone[] = [
  {
    id: 'ZN-01',
    name: 'Vehicle exclusion',
    kind: 'restricted',
    label: { x: 0, z: -4.05 },
    polygon: [
      [-5.9, -3.7],
      [5.9, -3.7],
      [5.9, 1.3],
      [-5.9, 1.3],
    ],
  },
  {
    id: 'ZN-02',
    name: 'Tank farm — ATEX',
    kind: 'inspection',
    label: { x: 14.55, z: 8.25, anchor: 'end' },
    polygon: [
      [12.4, 1.6],
      [15.6, 1.6],
      [15.6, 7.6],
      [12.4, 7.6],
    ],
  },
  {
    id: 'ZN-03',
    name: 'Substation',
    kind: 'inspection',
    label: null,
    polygon: [
      [-14.8, 4.4],
      [-10.2, 4.4],
      [-10.2, 8.5],
      [-14.8, 8.5],
    ],
  },
  {
    id: 'ZN-04',
    name: 'Charge depot',
    kind: 'charging',
    label: null,
    polygon: [
      [-15.4, -8.0],
      [-12.4, -8.0],
      [-12.4, -5.8],
      [-15.4, -5.8],
    ],
  },
]

export const ROBOTS: RobotSpec[] = [
  {
    id: 'lite3-01',
    callsign: 'JY·L3-01',
    vendor: 'DEEP Robotics 云深处科技',
    model: 'Jueying Lite3',
    family: 'quadruped',
    urdf: 'lite3',
    serial: 'DR-L3-2417-0082',
    firmware: 'v2.4.1-rc3',
    ip: '10.7.31.21',
    protocol: 'ROS2 / DDS · 5G-U',
    massKg: 12,
    ipRating: 'IP54',
    maxSpeed: 2.5,
    enduranceMin: 90,
    batteryStart: 86,
    color: '#ebebe8',
    home: { x: -11.5, z: -6.9 },
    payloads: [
      {
        id: 'ptz',
        name: 'Front PTZ Camera',
        kind: 'camera',
        model: '4MP · 25× optical zoom',
        stream: 'lite3-front',
        file: '/media/switchgear.mp4',
        detail: 'H.264 1080p25 · gimbal-stabilized · IR-cut',
      },
      {
        id: 'thermal',
        name: 'Thermal Imager',
        kind: 'thermal',
        model: '640×512 radiometric · <40mK NETD',
        stream: 'lite3-thermal',
        file: '/media/thermal.mp4',
        detail: 'Radiometric video, ΔT alarm thresholds',
      },
      {
        id: 'lidar',
        name: '3D LiDAR',
        kind: 'lidar',
        model: 'Mid-360 · 360°×59° FOV',
        detail: '200k pts/s · SLAM + obstacle avoidance',
      },
      {
        id: 'imu',
        name: 'IMU / Odometry',
        kind: 'imu',
        model: '6-axis · 200 Hz',
        detail: 'Fused legged odometry, slip detection',
      },
    ],
  },
  {
    id: 'x30-01',
    callsign: 'JY·X30-01',
    vendor: 'DEEP Robotics 云深处科技',
    model: 'Jueying X30',
    family: 'quadruped',
    urdf: 'x30',
    serial: 'DR-X30-2409-0017',
    firmware: 'v3.1.0',
    ip: '10.7.31.34',
    protocol: 'ROS2 / DDS · Wi-Fi 6 mesh',
    massKg: 56,
    ipRating: 'IP67',
    maxSpeed: 4.0,
    enduranceMin: 150,
    batteryStart: 62,
    color: '#b4b4ac',
    home: { x: -3, z: 5 },
    payloads: [
      {
        id: 'optical',
        name: 'Optical Zoom Camera',
        kind: 'camera',
        model: '4K · 30× hybrid zoom',
        stream: 'x30-optical',
        file: '/media/substation.mp4',
        detail: 'Person / PPE / behavior analytics on-board',
      },
      {
        id: 'acoustic',
        name: 'Acoustic Imager',
        kind: 'acoustic',
        model: '124-mic array · 2–48 kHz',
        detail: 'Partial discharge & gas-leak localization',
      },
      {
        id: 'gas',
        name: 'Gas Detector',
        kind: 'gas',
        model: 'CH₄ · CO · H₂S · O₂',
        detail: 'Pump-sampled, 1 Hz, auto-calibrating',
      },
      {
        id: 'lidar',
        name: '3D LiDAR',
        kind: 'lidar',
        model: 'RS-Helios 32-beam',
        detail: 'Long-range mapping, 150 m',
      },
    ],
  },
  {
    id: 'agx-w1',
    callsign: 'HSK·W1',
    vendor: 'Clearpath Robotics',
    model: 'Husky A200 UGV',
    family: 'ugv',
    urdf: 'husky',
    serial: 'CPR-A200-2311-0416',
    firmware: 'v1.8.2',
    ip: '10.7.31.52',
    protocol: 'ROS2 / DDS · LTE bond',
    massKg: 50,
    ipRating: 'IP44',
    maxSpeed: 1.0,
    enduranceMin: 180,
    batteryStart: 74,
    color: '#8a8a82',
    home: { x: 11, z: 5 },
    payloads: [
      {
        id: 'ogi',
        name: 'OGI Gas Camera',
        kind: 'ogi',
        model: 'MWIR 3.2–3.4 µm cooled',
        stream: 'agx-ogi',
        file: '/media/ogi.mp4',
        detail: 'Fugitive CH₄/VOC plume visualization',
      },
      {
        id: 'gas',
        name: 'Quant. Gas Sampler',
        kind: 'gas',
        model: 'TDLAS point sensor',
        detail: 'ppm·m quantification for OGI hits',
      },
      {
        id: 'acoustic',
        name: 'Ultrasonic Leak Probe',
        kind: 'acoustic',
        model: '20–100 kHz array',
        detail: 'Pressurized-line leak pinpointing',
      },
      {
        id: 'lidar',
        name: '3D LiDAR',
        kind: 'lidar',
        model: 'OS1-64',
        detail: 'Nav stack: Nav2 + MPPI controller',
      },
    ],
  },
  {
    id: 'go2-01',
    callsign: 'UT·GO2-01',
    vendor: 'Unitree 宇树科技',
    model: 'Go2 EDU',
    family: 'quadruped',
    urdf: 'go2',
    serial: 'UT-GO2-2605-0043',
    firmware: 'v1.1.5',
    ip: '10.7.31.44',
    protocol: 'ROS2 / DDS · Wi-Fi 6',
    massKg: 15,
    ipRating: 'IP55',
    maxSpeed: 3.7,
    enduranceMin: 120,
    batteryStart: 91,
    color: '#d6d6ce',
    home: { x: 5, z: 4.7 },
    payloads: [
      {
        id: 'front-cam',
        name: 'Front Wide Camera',
        kind: 'camera',
        model: '2K · 120° FOV',
        stream: 'go2-front',
        file: '/media/corridor.mp4',
        detail: 'H.264 1440p30 · corridor sweep preset',
      },
      {
        id: 'lidar-l1',
        name: '4D LiDAR L1',
        kind: 'lidar',
        model: '360°×90° hemispherical',
        detail: '21.6k pts/s · SLAM + terrain mapping',
      },
      {
        id: 'imu',
        name: 'IMU / Odometry',
        kind: 'imu',
        model: '6-axis · 500 Hz',
        detail: 'Fused legged odometry',
      },
    ],
  },
]

export const SITE_CAMERAS: SiteCamera[] = [
  {
    id: 'perimeter-cam',
    name: 'Perimeter — Gate Yard',
    place: 'North fence, container sector',
    stream: 'perimeter-cam',
    file: '/media/perimeter.mp4',
    live: false,
    source: 'NVR loop · demo footage',
  },
  {
    id: 'workshop-cam',
    name: 'Dock Camera',
    place: 'Robot staging area, fixed mount',
    stream: 'workshop-cam',
    file: '/media/staging.mp4',
    live: false,
    source: 'NVR loop · demo footage',
  },
  {
    id: 'mast-cam',
    name: 'Mast — Plant Overview',
    place: '30 m mast, wide sector',
    stream: 'mast-cam',
    file: '/media/plant_aerial.mp4',
    live: false,
    source: 'NVR loop · demo footage',
  },
  {
    id: 'tank-cam',
    name: 'Tank Farm — South Rack',
    place: 'ATEX zone pole mount',
    stream: 'tank-cam',
    file: '/media/tanknight.mp4',
    live: false,
    source: 'NVR loop · demo footage',
  },
]

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
  blurb: [string, string, string] // en / zh / es
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
      'Cuadrúpedo ágil para patrulla',
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
      'Buque insignia de inspección industrial',
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
      'Híbrido rueda-pata para terreno difícil',
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
      'Cuadrúpedo ágil para pasillos',
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
      'Referencia en inspección industrial autónoma',
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
      'Plataforma UGV para cargas pesadas',
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
    file: '/media/switchgear.mp4',
    detail: 'H.264 1080p25 · gimbal-stabilized · IR-cut',
  },
  {
    id: 'optical-4k',
    name: 'Optical Zoom Camera',
    kind: 'camera',
    model: '4K · 30× hybrid zoom',
    file: '/media/substation.mp4',
    detail: 'Person / PPE / behavior analytics on-board',
  },
  {
    id: 'thermal-640',
    name: 'Thermal Imager',
    kind: 'thermal',
    model: '640×512 radiometric · <40mK NETD',
    file: '/media/thermal.mp4',
    detail: 'Radiometric video, ΔT alarm thresholds',
  },
  {
    id: 'ogi-320',
    name: 'OGI Gas Camera',
    kind: 'ogi',
    model: '320×240 cooled InSb · CH₄/VOC',
    file: '/media/ogi.mp4',
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

const UNIT_COLORS = ['#ebebe8', '#b4b4ac', '#8a8a82', '#d6d6ce', '#c2c2ba']
const MODEL_CODE: Record<string, string> = {
  'Jueying Lite3': 'L3',
  'Jueying X30': 'X30',
  'Lynx M20': 'M20',
  'Husky A200': 'HSK',
  'Go2 EDU': 'GO2',
  'ANYmal C': 'ANY',
}

/** provision a new unit from the catalog — id/serial/callsign are minted here */
export function registerRobot(input: {
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
  const siblings = ROBOTS.filter((r) => r.model === spec.model).length
  const seq = String(siblings + 1).padStart(2, '0')
  const base = code.toLowerCase().replace(/[^a-z0-9]/g, '')
  let id = `${base}-${seq}`
  while (ROBOTS.some((r) => r.id === id)) id = `${base}-${String(Number(id.split('-')[1]) + 1).padStart(2, '0')}`
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
    color: UNIT_COLORS[ROBOTS.length % UNIT_COLORS.length],
    home: input.home,
  }
  ROBOTS.push(robot)
  return robot
}

export function installPayload(robotId: string, payloadId: string): PayloadSpec | null {
  const robot = ROBOTS.find((r) => r.id === robotId)
  const item = PAYLOAD_CATALOG.find((p) => p.id === payloadId)
  if (!robot || !item) return null
  let pid = item.id
  let n = 2
  while (robot.payloads.some((p) => p.id === pid)) pid = `${item.id}-${n++}`
  const inst = { ...item, id: pid }
  robot.payloads.push(inst)
  return inst
}

export function removePayload(robotId: string, payloadId: string): boolean {
  const robot = ROBOTS.find((r) => r.id === robotId)
  if (!robot) return false
  const i = robot.payloads.findIndex((p) => p.id === payloadId)
  if (i < 0) return false
  robot.payloads.splice(i, 1)
  return true
}
