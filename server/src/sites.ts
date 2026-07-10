// Site registry — one SiteDef per yard. Everything a World needs to boot:
// geometry, seed fleet, planner obstacles, seed rules/missions.
// Plant 07 is the original demo yard; Plant 12 is a compact harbor terminal
// that proves per-site isolation (own fleet, rules, missions, planner grid).

import type {
  Building,
  RobotSpec,
  Severity,
  SiteCamera,
  SiteMapMeta,
  Waypoint,
  Zone,
  MissionStep,
  ActionType,
  DetectionModel,
} from './fleet.js'
import type { PlannerDef } from './planner.js'

const PUB = process.env.PUBLIC_BASE ?? ''
const media = (f: string) => `${PUB}/media/${f}`

export interface RuleSeed {
  name: string
  model: DetectionModel
  source: string
  sourceName: string
  zone: string
  threshold: number
  severity: Severity
  robotId?: string
  /** producer kind — defaults to 'sim' (simulated CV) */
  kind?: 'sim' | 'onboard-cv' | 'cloud-cv' | 'threshold' | 'external'
  /** threshold detectors: fire when latest `metric` reading crosses `bound` */
  metric?: string
  op?: '>' | '<'
  bound?: number
}

export interface SeedMissionDef {
  name: string
  priority: 1 | 2 | 3
  requestedRobot: string
  recurring?: boolean
  /** schedule cadence for recurring seeds (minutes); default 4-6 */
  everyMin?: number
  steps: MissionStep[]
  /** backdated completed run for believable history */
  done?: {
    agoH: number
    durMin: number
    results: { stepIdx: number; waypointId: string; action: ActionType; note: string; atMin: number }[]
  }
}

export interface SiteDef {
  id: string
  name: string
  operator: string
  bounds: { x: [number, number]; z: [number, number] }
  map: SiteMapMeta | null
  waypoints: Waypoint[]
  zones: Zone[]
  buildings: Building[]
  cameras: SiteCamera[]
  robots: RobotSpec[]
  planner: PlannerDef
  /** low-battery return dock */
  dockWp: string
  ruleSeeds: RuleSeed[]
  missionSeeds: SeedMissionDef[]
  /** minutes-ago offsets for the seeded event history */
  eventSeedMins: number[]
  /** 3DGS scan of the yard, if one exists — listed as a first-class map asset */
  splat?: { name: string; url: string }
  /** site-specific event vocabulary, registered at boot (integration systems can post these) */
  eventTypeSeeds?: { id: string; label: string; severity: Severity; detail?: string }[]
}

const A = (type: ActionType, durationS: number) => ({ type, durationS })

// ============================================================ Plant 07

const plant07: SiteDef = {
  id: 'plant-07',
  name: 'Plant 07',
  operator: 'Plantbot Operations',
  bounds: { x: [-16, 16], z: [-9, 9] },
  map: {
    image: `${PUB}/assets/maps/yard-07.png`,
    resolution: 0.05,
    width: 640,
    height: 360,
    origin: [-16, -9],
    source: 'slam_toolbox · JY·L3-01 · 2026-06-30',
  },
  dockWp: 'WP-09',
  waypoints: [
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
  ],
  buildings: [
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
  ],
  zones: [
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
  ],
  planner: {
    bounds: { x: [-16, 16], z: [-9, 9] },
    rects: [
      [-5.6, -3.5, 5.6, 1.1], // parked truck (+margin)
      [-10.1, -1.4, -8.3, 0.7], // pallet stack W
      [7.6, 1.2, 9.9, 3.3], // pallet stack E
      [-3.1, 2.6, -0.8, 4.7], // pallet stack S
      [-14.8, 4.4, -10.2, 8.5], // substation
      [8.0, -7.4, 13.8, -4.9], // workshop
      [-15.4, -8.0, -12.4, -5.8], // charge depot walls
    ],
    circles: [
      [13.7, 6.2, 1.5],
      [13.8, 2.9, 1.3],
    ],
    carve: [[-14.4, -7.6, -12.4, -6.2]], // dock approach
  },
  robots: [
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
          file: media('switchgear.mp4'),
          detail: 'H.264 1080p25 · gimbal-stabilized · IR-cut',
        },
        {
          id: 'thermal',
          name: 'Thermal Imager',
          kind: 'thermal',
          model: '640×512 radiometric · <40mK NETD',
          stream: 'lite3-thermal',
          file: media('thermal.mp4'),
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
          file: media('substation.mp4'),
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
          file: media('ogi.mp4'),
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
          file: media('corridor.mp4'),
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
  ],
  cameras: [
    {
      id: 'perimeter-cam',
      name: 'Perimeter — Gate Yard',
      place: 'North fence, container sector',
      stream: 'perimeter-cam',
      file: media('perimeter.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'workshop-cam',
      name: 'Dock Camera',
      place: 'Robot staging area, fixed mount',
      stream: 'workshop-cam',
      file: media('staging.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'mast-cam',
      name: 'Mast — Plant Overview',
      place: '30 m mast, wide sector',
      stream: 'mast-cam',
      file: media('plant_aerial.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'tank-cam',
      name: 'Tank Farm — South Rack',
      place: 'ATEX zone pole mount',
      stream: 'tank-cam',
      file: media('tanknight.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
  ],
  ruleSeeds: [
    { name: 'Unbadged person in substation', model: 'person', kind: 'onboard-cv', source: 'x30-optical', sourceName: 'X30-01 · Optical', zone: 'Substation bay S-1', threshold: 0.7, severity: 'critical', robotId: 'x30-01' },
    { name: 'Smoking behavior', model: 'smoking', kind: 'cloud-cv', source: 'workshop-cam', sourceName: 'Dock Camera', zone: 'Robot staging area', threshold: 0.75, severity: 'critical' },
    { name: 'Stack thermal anomaly', model: 'thermal', kind: 'onboard-cv', source: 'lite3-thermal', sourceName: 'Lite3-01 · Thermal', zone: 'Boiler stack, sector N', threshold: 0.65, severity: 'high', robotId: 'lite3-01' },
    { name: 'Fugitive emission (OGI)', model: 'ogi', kind: 'onboard-cv', source: 'agx-ogi', sourceName: 'HSK·W1 · OGI', zone: 'Tank farm — ATEX', threshold: 0.6, severity: 'high', robotId: 'agx-w1' },
    { name: 'Analog gauge OCR', model: 'gauge', kind: 'onboard-cv', source: 'lite3-front', sourceName: 'Lite3-01 · PTZ', zone: 'Valve manifold VM-4', threshold: 0.6, severity: 'info', robotId: 'lite3-01' },
    { name: 'PPE compliance', model: 'ppe', kind: 'cloud-cv', source: 'workshop-cam', sourceName: 'Dock Camera', zone: 'Robot staging area', threshold: 0.6, severity: 'info' },
    { name: 'Perimeter motion', model: 'motion', kind: 'sim', source: 'perimeter-cam', sourceName: 'Perimeter — Reservoir Gate', zone: 'North fence, waterline', threshold: 0.55, severity: 'low' },
    { name: 'Partial discharge signature', model: 'acoustic', kind: 'onboard-cv', source: 'x30-optical', sourceName: 'X30-01 · Acoustic imager', zone: 'Transformer bay T-1', threshold: 0.7, severity: 'high', robotId: 'x30-01' },
    { name: 'CH₄ ceiling — tank farm', model: 'ogi', kind: 'threshold', source: 'agx-ogi', sourceName: 'HSK·W1 · Gas detector', zone: 'Tank farm — ATEX', threshold: 1, severity: 'high', robotId: 'agx-w1', metric: 'ch4.ppm', op: '>', bound: 6 },
    { name: 'ΔT ceiling — thermal imager', model: 'thermal', kind: 'threshold', source: 'lite3-thermal', sourceName: 'Lite3-01 · Thermal', zone: 'Boiler stack, sector N', threshold: 1, severity: 'high', robotId: 'lite3-01', metric: 'dt.max.c', op: '>', bound: 14 },
  ],
  missionSeeds: [
    {
      // 外部接入的 Spot（bosdyn adapter）——排程钉死给它，注册前任务留队自愈
      name: 'Spot switchgear anchors',
      priority: 2,
      requestedRobot: 'ext-bd-91250107',
      recurring: true,
      everyMin: 18,
      steps: [
        { waypointId: 'WP-05', actions: [A('capture_photo', 4)] },
        { waypointId: 'WP-02', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-13', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'North corridor patrol',
      priority: 2,
      requestedRobot: 'lite3-01',
      recurring: true,
      steps: [
        { waypointId: 'WP-01', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-02', actions: [A('gauge_read', 6), A('capture_photo', 3)] },
        { waypointId: 'WP-11', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-03', actions: [A('thermal_scan', 8)] },
        { waypointId: 'WP-04', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-10', actions: [A('wait', 3)] },
      ],
    },
    {
      name: 'Substation acoustic round',
      priority: 2,
      requestedRobot: 'x30-01',
      recurring: true,
      steps: [
        { waypointId: 'WP-05', actions: [A('acoustic_scan', 10), A('capture_photo', 3)] },
        { waypointId: 'WP-06', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-13', actions: [A('capture_photo', 4)] },
        { waypointId: 'WP-07', actions: [A('acoustic_scan', 8)] },
      ],
    },
    {
      name: 'OGI leak survey — tank farm',
      priority: 1,
      requestedRobot: 'agx-w1',
      recurring: true,
      steps: [
        { waypointId: 'WP-07', actions: [A('ogi_scan', 12)] },
        { waypointId: 'WP-08', actions: [A('ogi_scan', 14), A('gas_sample', 8)] },
        { waypointId: 'WP-12', actions: [A('ogi_scan', 10)] },
      ],
    },
    {
      name: 'Manifold VM-4 recheck',
      priority: 1,
      requestedRobot: 'auto',
      steps: [{ waypointId: 'WP-02', actions: [A('gauge_read', 8), A('capture_photo', 3)] }],
    },
    {
      name: 'Dawn thermal sweep',
      priority: 2,
      requestedRobot: 'x30-01',
      steps: [
        { waypointId: 'WP-03', actions: [A('thermal_scan', 8)] },
        { waypointId: 'WP-07', actions: [A('thermal_scan', 8)] },
      ],
      done: {
        agoH: 5.2,
        durMin: 14,
        results: [
          { stepIdx: 0, waypointId: 'WP-03', action: 'thermal_scan', note: 'Max ΔT +6.2 °C vs. baseline', atMin: 5 },
          { stepIdx: 1, waypointId: 'WP-07', action: 'thermal_scan', note: 'Max ΔT +4.8 °C vs. baseline', atMin: 12 },
        ],
      },
    },
    {
      name: 'Perimeter integrity check',
      priority: 3,
      requestedRobot: 'lite3-01',
      steps: [
        { waypointId: 'WP-01', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-11', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-04', actions: [A('capture_photo', 3)] },
      ],
      done: {
        agoH: 9.6,
        durMin: 22,
        results: [
          { stepIdx: 0, waypointId: 'WP-01', action: 'capture_photo', note: 'Frame archived · exposure auto', atMin: 4 },
          { stepIdx: 1, waypointId: 'WP-11', action: 'capture_photo', note: 'Frame archived · exposure auto', atMin: 11 },
          { stepIdx: 2, waypointId: 'WP-04', action: 'capture_photo', note: 'Frame archived · exposure auto', atMin: 20 },
        ],
      },
    },
  ],
  eventSeedMins: [3, 7, 12, 19, 26, 34, 47, 58, 73, 95, 121, 148, 176, 204],
  splat: { name: 'Warehouse 3DGS scan', url: 'assets/scenes/plant_yard.splat' },
}

// ============================================================ Plant 12 — Harbor Terminal

const plant12: SiteDef = {
  id: 'plant-12',
  name: 'Plant 12 · Harbor Terminal',
  operator: 'Plantbot Operations',
  bounds: { x: [-13, 13], z: [-8, 8] },
  map: null, // no occupancy underlay yet — upload one via the integration API
  dockWp: 'HB-08',
  waypoints: [
    { id: 'HB-01', name: 'Gatehouse', x: -10.5, z: -5.2, kind: 'nav' },
    { id: 'HB-02', name: 'Pipe rack west', x: -4.5, z: -4.6, kind: 'inspect' },
    { id: 'HB-03', name: 'Loading arms', x: 3.5, z: -4.8, kind: 'inspect' },
    { id: 'HB-04', name: 'Berth apron', x: 9.5, z: -3.6, kind: 'inspect' },
    { id: 'HB-05', name: 'Tank row south', x: 8.5, z: 4.4, kind: 'inspect' },
    { id: 'HB-06', name: 'Warehouse door', x: -2.5, z: 4.8, kind: 'nav' },
    { id: 'HB-07', name: 'Control room', x: -9.0, z: 4.2, kind: 'nav' },
    { id: 'HB-08', name: 'Charge bay', x: -11.0, z: 6.4, kind: 'dock' },
    { id: 'HB-09', name: 'Manifold skid', x: 1.0, z: 0.6, kind: 'inspect' },
  ],
  buildings: [
    { id: 'control', kind: 'box', x0: -11.8, z0: 2.6, x1: -7.6, z1: 5.4, h: 2.2, name: 'CONTROL' },
    { id: 'warehouse', kind: 'box', x0: -5.4, z0: 2.8, x1: 3.2, z1: 7.2, h: 3.0, name: 'WAREHOUSE' },
    { id: 'charge-bay', kind: 'box', x0: -12.6, z0: 5.6, x1: -9.8, z1: 7.4, h: 1.3, name: 'CHARGE' },
    { id: 'tank-c', kind: 'cyl', cx: 7.4, cz: 2.6, r: 1.2, h: 3.0, name: 'TK·C' },
    { id: 'tank-d', kind: 'cyl', cx: 10.6, cz: 2.8, r: 1.2, h: 3.0, name: 'TK·D' },
    { id: 'tank-e', kind: 'cyl', cx: 9.0, cz: 6.0, r: 1.0, h: 2.4, name: 'TK·E' },
    { id: 'pipe-rack', kind: 'box', x0: -6.0, z0: -3.4, x1: 6.0, z1: -2.2, h: 1.1, tone: 'mid', name: 'PIPE RACK' },
    { id: 'skid', kind: 'box', x0: 0.2, z0: -0.4, x1: 2.2, z1: 1.4, h: 0.8, tone: 'mid' },
    { id: 'berth-crane', kind: 'box', x0: 10.8, z0: -7.2, x1: 12.4, z1: -5.2, h: 3.6, tone: 'mid', name: 'CRANE' },
  ],
  zones: [
    {
      id: 'HZ-01',
      name: 'Berth — exclusion',
      kind: 'restricted',
      label: { x: 9.2, z: -7.0 },
      polygon: [
        [6.4, -7.6],
        [12.6, -7.6],
        [12.6, -4.6],
        [6.4, -4.6],
      ],
    },
    {
      id: 'HZ-02',
      name: 'Tank row — ATEX',
      kind: 'inspection',
      label: { x: 12.4, z: 7.4, anchor: 'end' },
      polygon: [
        [5.8, 1.2],
        [12.4, 1.2],
        [12.4, 7.4],
        [5.8, 7.4],
      ],
    },
    {
      id: 'HZ-03',
      name: 'Charge bay',
      kind: 'charging',
      label: null,
      polygon: [
        [-12.6, 5.6],
        [-9.8, 5.6],
        [-9.8, 7.4],
        [-12.6, 7.4],
      ],
    },
  ],
  planner: {
    bounds: { x: [-13, 13], z: [-8, 8] },
    rects: [
      [-12.0, 2.4, -7.4, 5.6], // control room (+margin)
      [-5.6, 2.6, 3.4, 7.4], // warehouse
      [-12.8, 5.4, -9.6, 7.6], // charge bay walls
      [-6.2, -3.6, 6.2, -2.0], // pipe rack
      [0.0, -0.6, 2.4, 1.6], // manifold skid
      [10.6, -7.4, 12.6, -5.0], // crane base
    ],
    circles: [
      [7.4, 2.6, 1.55],
      [10.6, 2.8, 1.55],
      [9.0, 6.0, 1.35],
    ],
    carve: [[-11.8, 6.0, -9.8, 7.0]], // charge bay approach
  },
  robots: [
    {
      id: 'x30-02',
      callsign: 'JY·X30-02',
      vendor: 'DEEP Robotics 云深处科技',
      model: 'Jueying X30',
      family: 'quadruped',
      urdf: 'x30',
      serial: 'DR-X30-2503-0044',
      firmware: 'v3.1.0',
      ip: '10.12.8.30',
      protocol: 'ROS2 / DDS · 5G-U',
      massKg: 56,
      ipRating: 'IP67',
      maxSpeed: 4.0,
      enduranceMin: 150,
      batteryStart: 78,
      color: '#b4b4ac',
      home: { x: -9.0, z: 4.2 },
      payloads: [
        {
          id: 'optical',
          name: 'Optical Zoom Camera',
          kind: 'camera',
          model: '4K · 30× hybrid zoom',
          stream: 'x30b-optical',
          file: media('substation.mp4'),
          detail: 'Person / PPE / behavior analytics on-board',
        },
        {
          id: 'thermal',
          name: 'Thermal Imager',
          kind: 'thermal',
          model: '640×512 radiometric',
          stream: 'x30b-thermal',
          file: media('thermal.mp4'),
          detail: 'Radiometric video, ΔT alarm thresholds',
        },
        {
          id: 'gas',
          name: 'Gas Detector',
          kind: 'gas',
          model: 'CH₄ · CO · H₂S · O₂',
          detail: 'Pump-sampled, 1 Hz, auto-calibrating',
        },
      ],
    },
    {
      id: 'go2-02',
      callsign: 'UT·GO2-02',
      vendor: 'Unitree 宇树科技',
      model: 'Go2 EDU',
      family: 'quadruped',
      urdf: 'go2',
      serial: 'UT-GO2-2611-0102',
      firmware: 'v1.1.5',
      ip: '10.12.8.41',
      protocol: 'ROS2 / DDS · Wi-Fi 6',
      massKg: 15,
      ipRating: 'IP55',
      maxSpeed: 3.7,
      enduranceMin: 120,
      batteryStart: 88,
      color: '#d6d6ce',
      home: { x: -2.5, z: 4.8 },
      payloads: [
        {
          id: 'front-cam',
          name: 'Front Wide Camera',
          kind: 'camera',
          model: '2K · 120° FOV',
          stream: 'go2b-front',
          file: media('corridor.mp4'),
          detail: 'H.264 1440p30 · rack sweep preset',
        },
        {
          id: 'lidar-l1',
          name: '4D LiDAR L1',
          kind: 'lidar',
          model: '360°×90° hemispherical',
          detail: '21.6k pts/s · SLAM + terrain mapping',
        },
      ],
    },
  ],
  cameras: [
    {
      id: 'berth-cam',
      name: 'Berth — Gate Yard',
      place: 'Crane mast, berth sector',
      stream: 'berth-cam',
      file: media('perimeter.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'tankrow-cam',
      name: 'Tank Row — Night Watch',
      place: 'ATEX pole mount',
      stream: 'tankrow-cam',
      file: media('tanknight.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
  ],
  ruleSeeds: [
    { name: 'Tank row thermal anomaly', model: 'thermal', kind: 'onboard-cv', source: 'x30b-thermal', sourceName: 'X30-02 · Thermal', zone: 'Tank row — ATEX', threshold: 0.65, severity: 'high', robotId: 'x30-02' },
    { name: 'Person on berth apron', model: 'person', kind: 'cloud-cv', source: 'berth-cam', sourceName: 'Berth camera', zone: 'Berth — exclusion', threshold: 0.7, severity: 'critical' },
    { name: 'Berth motion watch', model: 'motion', kind: 'sim', source: 'berth-cam', sourceName: 'Berth camera', zone: 'Berth — exclusion', threshold: 0.55, severity: 'low' },
    { name: 'Warehouse PPE compliance', model: 'ppe', kind: 'cloud-cv', source: 'go2b-front', sourceName: 'GO2-02 · Front', zone: 'Warehouse aisle', threshold: 0.6, severity: 'info', robotId: 'go2-02' },
    { name: 'Manifold gauge OCR', model: 'gauge', kind: 'onboard-cv', source: 'x30b-optical', sourceName: 'X30-02 · Optical', zone: 'Manifold skid', threshold: 0.6, severity: 'info', robotId: 'x30-02' },
    { name: 'CH₄ ceiling — tank row', model: 'ogi', kind: 'threshold', source: 'x30b-thermal', sourceName: 'X30-02 · Gas detector', zone: 'Tank row — ATEX', threshold: 1, severity: 'high', robotId: 'x30-02', metric: 'ch4.ppm', op: '>', bound: 6 },
  ],
  missionSeeds: [
    {
      // 外部接入的绝影 X30（robotserver adapter）——1003 原生多点任务
      name: 'X30 berth sweep (external)',
      priority: 2,
      requestedRobot: 'ext-x30-jy-2024-0007',
      recurring: true,
      everyMin: 24,
      steps: [
        { waypointId: 'HB-02', actions: [A('capture_photo', 3)] },
        { waypointId: 'HB-04', actions: [A('thermal_scan', 8)] },
        { waypointId: 'HB-05', actions: [A('thermal_scan', 6)] },
      ],
    },
    {
      name: 'Tank row thermal round',
      priority: 1,
      requestedRobot: 'x30-02',
      recurring: true,
      steps: [
        { waypointId: 'HB-09', actions: [A('gauge_read', 6)] },
        { waypointId: 'HB-05', actions: [A('thermal_scan', 10), A('gas_sample', 6)] },
        { waypointId: 'HB-04', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Warehouse rack sweep',
      priority: 2,
      requestedRobot: 'go2-02',
      recurring: true,
      steps: [
        { waypointId: 'HB-06', actions: [A('capture_photo', 3)] },
        { waypointId: 'HB-02', actions: [A('capture_photo', 3)] },
        { waypointId: 'HB-03', actions: [A('capture_photo', 4)] },
      ],
    },
    {
      name: 'Berth apron check',
      priority: 2,
      requestedRobot: 'auto',
      steps: [{ waypointId: 'HB-04', actions: [A('capture_photo', 4), A('wait', 3)] }],
    },
  ],
  eventSeedMins: [4, 11, 21, 38, 55, 79, 110, 150, 190],
}

// ============================================================ Campus East — security patrol
// Dense mixed-robot security scenario: 8 sim units here plus 2 virtual
// Gosuncn GS Patrol F2 units that join through the integration API at boot
// (see gosim.ts) — 10 units, 6 models, one dispatcher.

const campus: SiteDef = {
  id: 'campus-east',
  name: 'Campus East · Security',
  operator: 'Plantbot Operations · University FM',
  bounds: { x: [-20, 20], z: [-11, 11] },
  map: null,
  dockWp: 'DOCK-C',
  waypoints: [
    { id: 'CP-01', name: 'Main gate check', x: 0, z: 7.8, kind: 'inspect' },
    { id: 'CP-02', name: 'Library entrance', x: 0, z: 3.4, kind: 'inspect' },
    { id: 'CP-03', name: 'Dorm quad check', x: -8.5, z: -5.4, kind: 'inspect' },
    { id: 'CP-04', name: 'Lab loading dock', x: 9.2, z: -0.2, kind: 'inspect' },
    { id: 'CP-05', name: 'Stadium gate', x: 8.2, z: 4.2, kind: 'inspect' },
    { id: 'CP-06', name: 'Canteen plaza', x: 5, z: -5.6, kind: 'inspect' },
    { id: 'WP-N1', name: 'Fence NW', x: -18.6, z: -10.1, kind: 'nav' },
    { id: 'WP-N2', name: 'Fence NE', x: 18.6, z: -10.1, kind: 'nav' },
    { id: 'WP-S2', name: 'Fence SE', x: 18.6, z: 10.1, kind: 'nav' },
    { id: 'WP-S1', name: 'Fence SW', x: -18.6, z: 10.1, kind: 'nav' },
    { id: 'WP-X1', name: 'Main walk W', x: -5.2, z: 4.6, kind: 'nav' },
    { id: 'WP-X2', name: 'Main walk E', x: 5.4, z: 6.4, kind: 'nav' },
    { id: 'LOT-1', name: 'Parking row A', x: -12, z: 7.6, kind: 'inspect' },
    { id: 'LOT-2', name: 'Parking row B', x: -9, z: 6.2, kind: 'nav' },
    { id: 'DOCK-C', name: 'Charge dock', x: -18.4, z: 0.3, kind: 'dock' },
  ],
  buildings: [
    { id: 'dorm-1', kind: 'box', x0: -16, z0: -10, x1: -9.2, z1: -6.6, h: 3.2, name: 'DORM D1' },
    { id: 'dorm-2', kind: 'box', x0: -7.6, z0: -10, x1: -0.8, z1: -6.6, h: 3.2, name: 'DORM D2' },
    { id: 'canteen', kind: 'box', x0: 1.8, z0: -10, x1: 8.2, z1: -6.9, h: 2.2, name: 'CANTEEN' },
    { id: 'teach-a', kind: 'box', x0: -18.2, z0: -4.2, x1: -13.2, z1: 1.8, h: 3.6, name: 'TEACHING A' },
    { id: 'teach-b', kind: 'box', x0: -11.6, z0: -4.2, x1: -6.8, z1: 0.8, h: 2.9, name: 'TEACHING B' },
    { id: 'library', kind: 'box', x0: -3.4, z0: -3.2, x1: 3.4, z1: 2.4, h: 4.2, name: 'LIBRARY' },
    { id: 'lab', kind: 'box', x0: 6.6, z0: -4.6, x1: 12.2, z1: -1.2, h: 3.0, name: 'LAB · CHEM' },
    { id: 'lab-tank', kind: 'cyl', cx: 13.4, cz: -3.4, r: 0.8, h: 1.9, tone: 'mid', name: 'N₂' },
    { id: 'stadium-field', kind: 'box', x0: 9.4, z0: 3.4, x1: 18.2, z1: 9.6, h: 0.35, tone: 'light', name: 'STADIUM' },
    { id: 'stand', kind: 'box', x0: 9.4, z0: 2.2, x1: 18.2, z1: 3.2, h: 1.7, tone: 'mid', order: 1 },
    { id: 'gatehouse', kind: 'box', x0: -1.8, z0: 8.9, x1: 1.8, z1: 10.4, h: 1.6, name: 'MAIN GATE' },
    { id: 'charge-c', kind: 'box', x0: -19.4, z0: -1.2, x1: -17.4, z1: 1.8, h: 1.3, name: 'CHARGE' },
    { id: 'kiosk', kind: 'box', x0: 4.4, z0: 1.4, x1: 5.6, z1: 2.4, h: 1.0, tone: 'mid' },
    { id: 'bikes', kind: 'box', x0: -2.4, z0: 6.9, x1: 0.4, z1: 7.8, h: 0.7, tone: 'mid' },
  ],
  zones: [
    {
      id: 'ZC-01',
      name: 'North fence — restricted',
      kind: 'restricted',
      label: { x: 0, z: -10.55 },
      polygon: [
        [-19.4, -10.8],
        [19.4, -10.8],
        [19.4, -10.2],
        [-19.4, -10.2],
      ],
    },
    {
      id: 'ZC-02',
      name: 'Chemical storage',
      kind: 'restricted',
      label: { x: 14.3, z: -4.9, anchor: 'end' },
      polygon: [
        [12.4, -4.6],
        [14.6, -4.6],
        [14.6, -2.2],
        [12.4, -2.2],
      ],
    },
    {
      id: 'ZC-03',
      name: 'Parking P1',
      kind: 'inspection',
      label: { x: -16.7, z: 5.35 },
      polygon: [
        [-17, 5.6],
        [-7.2, 5.6],
        [-7.2, 9.6],
        [-17, 9.6],
      ],
    },
    {
      id: 'ZC-04',
      name: 'Fire lane — keep clear',
      kind: 'restricted',
      label: { x: -6.55, z: 6.45 },
      polygon: [
        [-6.6, 5.9],
        [-3.0, 5.9],
        [-3.0, 8.2],
        [-6.6, 8.2],
      ],
    },
    {
      id: 'ZC-05',
      name: 'Charge dock',
      kind: 'charging',
      label: null,
      polygon: [
        [-19.4, -1.2],
        [-17.4, -1.2],
        [-17.4, 1.8],
        [-19.4, 1.8],
      ],
    },
  ],
  planner: {
    bounds: { x: [-20, 20], z: [-11, 11] },
    rects: [
      [-16, -10, -9.2, -6.6], // dorm 1
      [-7.6, -10, -0.8, -6.6], // dorm 2
      [1.8, -10, 8.2, -6.9], // canteen
      [-18.2, -4.2, -13.2, 1.8], // teaching A
      [-11.6, -4.2, -6.8, 0.8], // teaching B
      [-3.4, -3.2, 3.4, 2.4], // library
      [6.6, -4.6, 12.2, -1.2], // lab
      [9.4, 2.2, 18.2, 3.2], // stadium stand
      [-1.8, 8.9, 1.8, 10.4], // gatehouse
      [-19.4, -1.2, -17.4, 1.8], // charge shed walls
      [-2.4, 6.9, 0.4, 7.8], // bike racks (south of the library, clear of the fire lane)
    ],
    circles: [[13.4, -3.4, 1.1]],
    carve: [[-18.9, -0.6, -17.4, 1.2]], // dock approach
  },
  cameras: [
    {
      id: 'gate-cam',
      name: 'Main gate camera',
      place: 'Gatehouse mast',
      stream: 'gate-cam',
      file: media('campus_gate.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'perimeter-cam-c',
      name: 'North fence camera',
      place: 'Fence pole 7',
      stream: 'perimeter-cam-c',
      file: media('intruder.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'stadium-cam',
      name: 'Stadium mast camera',
      place: 'Stadium light mast',
      stream: 'stadium-cam',
      file: media('stadium_field.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
    {
      id: 'lot-cam',
      name: 'Parking P1 camera',
      place: 'Lot pole 2',
      stream: 'lot-cam',
      file: media('parking_night.mp4'),
      live: false,
      source: 'NVR loop · demo footage',
    },
  ],
  robots: [
    {
      id: 'go2-c1',
      callsign: 'GO2·C1',
      vendor: 'Unitree 宇树科技',
      model: 'Go2 EDU',
      family: 'quadruped',
      urdf: 'go2',
      serial: 'UT-GO2-2601-0311',
      firmware: 'v1.1.5',
      ip: '10.9.40.11',
      protocol: 'ROS2 / DDS · Wi-Fi 6',
      massKg: 15,
      ipRating: 'IP55',
      maxSpeed: 3.7,
      enduranceMin: 120,
      batteryStart: 88,
      color: '#ebebe8',
      home: { x: -1.2, z: 6.4 },
      payloads: [
        {
          id: 'front',
          name: 'Front Camera',
          kind: 'camera',
          model: '4MP wide · EIS',
          stream: 'go2c1-front',
          file: media('campus_walk.mp4'),
          detail: 'Person / fall / behavior analytics on-board',
        },
        { id: 'lidar', name: '3D LiDAR', kind: 'lidar', model: 'Mid-360', detail: 'SLAM + obstacle avoidance' },
      ],
    },
    {
      id: 'go2-c2',
      callsign: 'GO2·C2',
      vendor: 'Unitree 宇树科技',
      model: 'Go2 EDU',
      family: 'quadruped',
      urdf: 'go2',
      serial: 'UT-GO2-2601-0312',
      firmware: 'v1.1.5',
      ip: '10.9.40.12',
      protocol: 'ROS2 / DDS · Wi-Fi 6',
      massKg: 15,
      ipRating: 'IP55',
      maxSpeed: 3.7,
      enduranceMin: 120,
      batteryStart: 74,
      color: '#d6d6ce',
      home: { x: 0.4, z: 3.2 },
      payloads: [
        {
          id: 'front',
          name: 'Front Camera',
          kind: 'camera',
          model: '4MP wide · EIS',
          stream: 'go2c2-front',
          file: media('library_aisle.mp4'),
          detail: 'After-hours motion watch in the stacks',
        },
      ],
    },
    {
      id: 'lite3-c1',
      callsign: 'JY·L3-C1',
      vendor: 'DEEP Robotics 云深处科技',
      model: 'Jueying Lite3',
      family: 'quadruped',
      urdf: 'lite3',
      serial: 'DR-L3-2417-0126',
      firmware: 'v2.4.1-rc3',
      ip: '10.9.40.21',
      protocol: 'ROS2 / DDS · 5G-U',
      massKg: 12,
      ipRating: 'IP54',
      maxSpeed: 2.5,
      enduranceMin: 90,
      batteryStart: 81,
      color: '#b4b4ac',
      home: { x: -8.5, z: -5.4 },
      payloads: [
        {
          id: 'front',
          name: 'Front PTZ Camera',
          kind: 'camera',
          model: '4MP · 25× zoom',
          stream: 'lite3c-front',
          file: media('library_aisle.mp4'),
          detail: 'Dorm-block corridor rounds',
        },
        { id: 'imu', name: 'IMU / Odometry', kind: 'imu', model: '6-axis · 200 Hz', detail: 'Fused legged odometry' },
      ],
    },
    {
      id: 'x30-c1',
      callsign: 'JY·X30-C1',
      vendor: 'DEEP Robotics 云深处科技',
      model: 'Jueying X30',
      family: 'quadruped',
      urdf: 'x30',
      serial: 'DR-X30-2409-0058',
      firmware: 'v3.1.0',
      ip: '10.9.40.31',
      protocol: 'ROS2 / DDS · Wi-Fi 6 mesh',
      massKg: 56,
      ipRating: 'IP67',
      maxSpeed: 4.0,
      enduranceMin: 150,
      batteryStart: 91,
      color: '#8a8a82',
      home: { x: -18.6, z: -10.1 },
      payloads: [
        {
          id: 'optical',
          name: 'Optical Zoom Camera',
          kind: 'camera',
          model: '4K · 30× hybrid zoom',
          stream: 'x30c1-optical',
          file: media('night_walkway.mp4'),
          detail: 'Night perimeter — person / climb detection',
        },
        {
          id: 'thermal',
          name: 'Thermal Imager',
          kind: 'thermal',
          model: '640×512 radiometric',
          stream: 'x30c1-thermal',
          file: media('thermal.mp4'),
          detail: 'Fence-line thermal contrast at night',
        },
      ],
    },
    {
      id: 'x30-c2',
      callsign: 'JY·X30-C2',
      vendor: 'DEEP Robotics 云深处科技',
      model: 'Jueying X30',
      family: 'quadruped',
      urdf: 'x30',
      serial: 'DR-X30-2409-0059',
      firmware: 'v3.1.0',
      ip: '10.9.40.32',
      protocol: 'ROS2 / DDS · Wi-Fi 6 mesh',
      massKg: 56,
      ipRating: 'IP67',
      maxSpeed: 4.0,
      enduranceMin: 150,
      batteryStart: 66,
      color: '#c2c2ba',
      home: { x: 1.6, z: 7.6 },
      payloads: [
        {
          id: 'optical',
          name: 'Optical Zoom Camera',
          kind: 'camera',
          model: '4K · 30× hybrid zoom',
          stream: 'x30c2-optical',
          file: media('campus_gate.mp4'),
          detail: 'Gate rush hours — tailgating watch',
        },
        { id: 'acoustic', name: 'Acoustic Imager', kind: 'acoustic', model: '124-mic array', detail: 'Glass-break / shout localization' },
      ],
    },
    {
      id: 'hsk-c1',
      callsign: 'HSK·C1',
      vendor: 'Clearpath Robotics',
      model: 'Husky A200',
      family: 'ugv',
      urdf: 'husky',
      serial: 'CP-HSK-2311-0502',
      firmware: 'v2.1.4',
      ip: '10.9.40.41',
      protocol: 'ROS2 / DDS · Ethernet',
      massKg: 50,
      ipRating: 'IP44',
      maxSpeed: 1.0,
      enduranceMin: 180,
      batteryStart: 79,
      color: '#ebebe8',
      home: { x: -12, z: 7.6 },
      payloads: [
        {
          id: 'front',
          name: 'Front Camera',
          kind: 'camera',
          model: '4MP · IR-cut',
          stream: 'hskc1-front',
          file: media('parking_night.mp4'),
          detail: 'Parking rows — plate & fire-lane watch',
        },
        { id: 'lidar', name: '3D LiDAR', kind: 'lidar', model: 'Mid-360', detail: 'SLAM + obstacle avoidance' },
      ],
    },
    {
      id: 'hsk-c2',
      callsign: 'HSK·C2',
      vendor: 'Clearpath Robotics',
      model: 'Husky A200',
      family: 'ugv',
      urdf: 'husky',
      serial: 'CP-HSK-2311-0503',
      firmware: 'v2.1.4',
      ip: '10.9.40.42',
      protocol: 'ROS2 / DDS · Ethernet',
      massKg: 50,
      ipRating: 'IP44',
      maxSpeed: 1.0,
      enduranceMin: 180,
      batteryStart: 84,
      color: '#b4b4ac',
      home: { x: 5.4, z: 6.4 },
      payloads: [
        {
          id: 'front',
          name: 'Front Camera',
          kind: 'camera',
          model: '4MP · IR-cut',
          stream: 'hskc2-front',
          file: media('campus_quad.mp4'),
          detail: 'Main walk — crowding & left-object watch',
        },
      ],
    },
    {
      id: 'any-c1',
      callsign: 'ANY·C1',
      vendor: 'ANYbotics',
      model: 'ANYmal C',
      family: 'quadruped',
      urdf: 'anymal',
      serial: 'AB-ANY-2405-0071',
      firmware: 'v23.04',
      ip: '10.9.40.51',
      protocol: 'ROS2 / DDS · LTE',
      massKg: 50,
      ipRating: 'IP67',
      maxSpeed: 1.3,
      enduranceMin: 120,
      batteryStart: 71,
      color: '#8a8a82',
      home: { x: 9.2, z: -0.2 },
      payloads: [
        {
          id: 'front',
          name: 'Inspection Camera',
          kind: 'camera',
          model: '4K · pan-tilt',
          stream: 'anyc-front',
          file: media('corridor.mp4'),
          detail: 'Lab utility corridors, Ex-rated build',
        },
        {
          id: 'gas',
          name: 'Gas Detector',
          kind: 'gas',
          model: 'CH₄ · CO · H₂S · O₂',
          stream: 'anyc-gas',
          file: media('ogi.mp4'),
          detail: 'Chemical-storage sniffing round',
        },
      ],
    },
  ],
  ruleSeeds: [
    { name: 'Perimeter crossing at night', model: 'person', kind: 'onboard-cv', source: 'x30c1-optical', sourceName: 'X30-C1 · Optical', zone: 'North fence — restricted', threshold: 0.7, severity: 'critical', robotId: 'x30-c1' },
    { name: 'Unattended bag — gate', model: 'unattended-bag', kind: 'cloud-cv', source: 'gate-cam', sourceName: 'Main gate camera', zone: 'Main gate check', threshold: 0.6, severity: 'high' },
    { name: 'Crowding — canteen rush', model: 'crowding', kind: 'cloud-cv', source: 'hskc2-front', sourceName: 'HSK·C2 · Front', zone: 'Canteen plaza', threshold: 0.55, severity: 'info', robotId: 'hsk-c2' },
    { name: 'Fall detection — walkways', model: 'fall', kind: 'onboard-cv', source: 'go2c1-front', sourceName: 'GO2·C1 · Front', zone: 'Main walk', threshold: 0.65, severity: 'high', robotId: 'go2-c1' },
    { name: 'E-bike in fire lane', model: 'ebike-blocking', kind: 'cloud-cv', source: 'lot-cam', sourceName: 'Parking P1 camera', zone: 'Fire lane — keep clear', threshold: 0.6, severity: 'high' },
    { name: 'Tailgating at gate', model: 'tailgating', kind: 'onboard-cv', source: 'x30c2-optical', sourceName: 'X30-C2 · Optical', zone: 'Main gate check', threshold: 0.65, severity: 'high', robotId: 'x30-c2' },
    { name: 'Smoking near lab dock', model: 'smoking', kind: 'onboard-cv', source: 'anyc-front', sourceName: 'ANY·C1 · Camera', zone: 'Chemical storage', threshold: 0.75, severity: 'critical', robotId: 'any-c1' },
    { name: 'After-hours motion — library', model: 'motion', kind: 'sim', source: 'go2c2-front', sourceName: 'GO2·C2 · Front', zone: 'Library entrance', threshold: 0.55, severity: 'low', robotId: 'go2-c2' },
    { name: 'Gauge — lab gas manifold', model: 'gauge', kind: 'onboard-cv', source: 'anyc-gas', sourceName: 'ANY·C1 · Gas', zone: 'Chemical storage', threshold: 0.6, severity: 'info', robotId: 'any-c1' },
    { name: 'VOC ceiling — chem storage', model: 'ogi', kind: 'threshold', source: 'anyc-gas', sourceName: 'ANY·C1 · Gas detector', zone: 'Chemical storage', threshold: 1, severity: 'high', robotId: 'any-c1', metric: 'ch4.ppm', op: '>', bound: 6 },
  ],
  missionSeeds: [
    {
      name: 'Gate–Library–Dorm checkpoint round',
      priority: 1,
      requestedRobot: 'go2-c1',
      recurring: true,
      everyMin: 6,
      steps: [
        { waypointId: 'CP-01', actions: [A('wait', 6), A('capture_photo', 3)] },
        { waypointId: 'CP-02', actions: [A('wait', 5), A('capture_photo', 3)] },
        { waypointId: 'CP-06', actions: [A('capture_photo', 3)] },
        { waypointId: 'CP-03', actions: [A('wait', 5), A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Perimeter night sweep',
      priority: 1,
      requestedRobot: 'x30-c1',
      recurring: true,
      everyMin: 8,
      steps: [
        { waypointId: 'WP-N1', actions: [A('thermal_scan', 7), A('capture_photo', 3)] },
        { waypointId: 'WP-N2', actions: [A('thermal_scan', 7)] },
        { waypointId: 'WP-S2', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-S1', actions: [A('thermal_scan', 6)] },
      ],
    },
    {
      name: 'Parking & fire-lane patrol',
      priority: 2,
      requestedRobot: 'hsk-c1',
      recurring: true,
      everyMin: 7,
      steps: [
        { waypointId: 'LOT-1', actions: [A('wait', 4), A('capture_photo', 3)] },
        { waypointId: 'LOT-2', actions: [A('capture_photo', 3)] },
        { waypointId: 'CP-01', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Lab utilities gas round',
      priority: 2,
      requestedRobot: 'any-c1',
      recurring: true,
      everyMin: 9,
      steps: [
        { waypointId: 'CP-04', actions: [A('gas_sample', 8), A('gauge_read', 6)] },
        { waypointId: 'WP-X2', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Library closing round',
      priority: 3,
      requestedRobot: 'go2-c2',
      recurring: true,
      everyMin: 10,
      steps: [
        { waypointId: 'CP-02', actions: [A('wait', 4), A('capture_photo', 3)] },
        { waypointId: 'WP-X1', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Stadium event sweep',
      priority: 2,
      requestedRobot: 'auto',
      steps: [
        { waypointId: 'CP-05', actions: [A('wait', 5), A('capture_photo', 3)] },
        { waypointId: 'WP-S2', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Morning gate rush watch',
      priority: 2,
      requestedRobot: 'x30-c2',
      steps: [
        { waypointId: 'CP-01', actions: [A('capture_photo', 4)] },
        { waypointId: 'CP-02', actions: [A('capture_photo', 3)] },
      ],
      done: {
        agoH: 3.4,
        durMin: 18,
        results: [
          { stepIdx: 0, waypointId: 'CP-01', action: 'capture_photo', note: 'Gate flow nominal · 240 entries logged', atMin: 6 },
          { stepIdx: 1, waypointId: 'CP-02', action: 'capture_photo', note: 'Frame archived · exposure auto', atMin: 15 },
        ],
      },
    },
  ],
  eventSeedMins: [2, 5, 9, 14, 21, 29, 39, 52, 66, 84, 105, 130, 158, 188, 218],
  eventTypeSeeds: [
    { id: 'unattended-bag', label: 'Unattended bag', severity: 'high', detail: 'Static bag, no owner in radius — left-object protocol' },
    { id: 'crowding', label: 'Crowd density', severity: 'info', detail: 'Queue/crowd density above comfort threshold' },
    { id: 'fall', label: 'Person fallen', severity: 'high', detail: 'Person down and not recovering — medical dispatch check' },
    { id: 'ebike-blocking', label: 'E-bike blocking', severity: 'high', detail: 'E-bike parked in a fire lane / egress route' },
    { id: 'tailgating', label: 'Tailgating', severity: 'high', detail: 'Multiple entries on a single credential at a gate' },
  ],
}

export const SITES: SiteDef[] = [plant07, plant12, campus]
