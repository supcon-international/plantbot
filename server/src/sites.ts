// DEMO site seeds — imported into SQLite once, on the first boot with
// PB_DEMO=1 (the root `pnpm dev` script sets it). Production boots with an
// empty sites table and sites are created in the Site Builder UI; after the
// first import these defs are never read again (the DB is the source of
// truth, fully editable). No fleets live here — Plantbot is a pure
// integration layer, robots arrive through the vendor adapters and the seeds
// below pin their ext-* ids (self-healing: a pinned run stays queued until
// its adapter registers).

import type {
  Building,
  Severity,
  SiteCamera,
  SiteMapMeta,
  Waypoint,
  Zone,
  MissionStep,
  ActionType,
  DetectionModel,
  EventCategory,
} from './fleet.js'

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
  /** where the dock command sends units (adapters may swap in the vendor's own charge routine) */
  dockWp: string
  ruleSeeds: RuleSeed[]
  missionSeeds: SeedMissionDef[]
  /** minutes-ago offsets for the seeded event history */
  eventSeedMins: number[]
  /** 3DGS scan of the yard, if one exists — listed as a first-class map asset */
  splat?: { name: string; url: string }
  /** site-specific event vocabulary, registered at boot (integration systems can post these) */
  eventTypeSeeds?: { id: string; label: string; severity: Severity; detail?: string; category?: EventCategory }[]
  /** demo calibration transforms (e.g. the wgs84 anchor) — stored, editable in the calibration UI */
  transformSeeds?: { id: string; from: string; to: string; params: { s: number; thetaRad: number; t: [number, number] }; note?: string }[]
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
    { name: 'Unbadged person in substation', model: 'person', kind: 'onboard-cv', source: 'spot07-front', sourceName: 'SPOT·A · Fisheye', zone: 'Substation bay S-1', threshold: 0.7, severity: 'critical', robotId: 'ext-bd-91250107' },
    { name: 'Smoking behavior', model: 'smoking', kind: 'cloud-cv', source: 'workshop-cam', sourceName: 'Dock Camera', zone: 'Robot staging area', threshold: 0.75, severity: 'critical' },
    { name: 'Stack thermal anomaly', model: 'thermal', kind: 'onboard-cv', source: 'spot07-therm', sourceName: 'SPOT·A · Thermal', zone: 'Boiler stack, sector N', threshold: 0.65, severity: 'high', robotId: 'ext-bd-91250107' },
    { name: 'PPE compliance', model: 'ppe', kind: 'cloud-cv', source: 'workshop-cam', sourceName: 'Dock Camera', zone: 'Robot staging area', threshold: 0.6, severity: 'info' },
    { name: 'Perimeter motion', model: 'motion', kind: 'sim', source: 'perimeter-cam', sourceName: 'Perimeter — Gate Yard', zone: 'North fence, waterline', threshold: 0.55, severity: 'low' },
    { name: 'Fugitive emission (OGI)', model: 'ogi', kind: 'onboard-cv', source: 'tank-cam', sourceName: 'Tank farm camera', zone: 'Tank farm — ATEX', threshold: 0.6, severity: 'high' },
    { name: 'ΔT ceiling — thermal imager', model: 'thermal', kind: 'threshold', source: 'spot07-therm', sourceName: 'SPOT·A · Thermal', zone: 'Boiler stack, sector N', threshold: 1, severity: 'high', robotId: 'ext-bd-91250107', metric: 'dt.max.c', op: '>', bound: 14 },
  ],
  missionSeeds: [
    {
      // plant-07 外部接入的 Spot（bosdyn adapter）——排程钉死,注册前留队自愈
      name: 'Spot switchgear anchors',
      priority: 2,
      requestedRobot: 'ext-bd-91250107',
      recurring: true,
      everyMin: 12,
      steps: [
        { waypointId: 'WP-05', actions: [A('capture_photo', 4)] },
        { waypointId: 'WP-02', actions: [A('gauge_read', 6), A('capture_photo', 3)] },
        { waypointId: 'WP-13', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-07', actions: [A('thermal_scan', 8)] },
      ],
    },
    {
      name: 'Dawn thermal sweep',
      priority: 2,
      requestedRobot: 'ext-bd-91250107',
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
      requestedRobot: 'ext-bd-91250107',
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
  transformSeeds: [
    {
      id: 'wgs84-anchor',
      from: 'world',
      to: 'wgs84',
      params: { s: 1 / 111_320, thetaRad: 0, t: [121.474, 31.233] },
      note: 'lon = x·s + t[0] · lat = -z·s + t[1] (small-area approximation)',
    },
  ],
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
    { name: 'Tank row thermal anomaly', model: 'thermal', kind: 'onboard-cv', source: 'x30hb-therm', sourceName: 'X30·HB · Thermal', zone: 'Tank row — ATEX', threshold: 0.65, severity: 'high', robotId: 'ext-x30-jy-2024-0007' },
    { name: 'Person on berth apron', model: 'person', kind: 'cloud-cv', source: 'berth-cam', sourceName: 'Berth camera', zone: 'Berth — exclusion', threshold: 0.7, severity: 'critical' },
    { name: 'Berth motion watch', model: 'motion', kind: 'sim', source: 'berth-cam', sourceName: 'Berth camera', zone: 'Berth — exclusion', threshold: 0.55, severity: 'low' },
    { name: 'Manifold gauge OCR', model: 'gauge', kind: 'onboard-cv', source: 'x30hb-optical', sourceName: 'X30·HB · Optical', zone: 'Manifold skid', threshold: 0.6, severity: 'info', robotId: 'ext-x30-jy-2024-0007' },
    { name: 'Night watch — tank row', model: 'motion', kind: 'sim', source: 'tankrow-cam', sourceName: 'Tank row camera', zone: 'Tank row — ATEX', threshold: 0.55, severity: 'low' },
    { name: 'CH₄ ceiling — tank row', model: 'ogi', kind: 'threshold', source: 'x30hb-therm', sourceName: 'X30·HB · Gas detector', zone: 'Tank row — ATEX', threshold: 1, severity: 'high', robotId: 'ext-x30-jy-2024-0007', metric: 'ch4.ppm', op: '>', bound: 6 },
  ],
  missionSeeds: [
    {
      // plant-12 外部接入的绝影 X30（robotserver adapter）——1003 原生多点任务
      name: 'X30 berth sweep',
      priority: 2,
      requestedRobot: 'ext-x30-jy-2024-0007',
      recurring: true,
      everyMin: 10,
      steps: [
        { waypointId: 'HB-02', actions: [A('capture_photo', 3)] },
        { waypointId: 'HB-09', actions: [A('gauge_read', 6)] },
        { waypointId: 'HB-04', actions: [A('thermal_scan', 8)] },
        { waypointId: 'HB-05', actions: [A('thermal_scan', 6)] },
      ],
    },
    {
      name: 'Tank row thermal round',
      priority: 1,
      requestedRobot: 'ext-x30-jy-2024-0007',
      steps: [
        { waypointId: 'HB-09', actions: [A('gauge_read', 6)] },
        { waypointId: 'HB-05', actions: [A('thermal_scan', 10), A('gas_sample', 6)] },
      ],
      done: {
        agoH: 2.1,
        durMin: 12,
        results: [
          { stepIdx: 0, waypointId: 'HB-09', action: 'gauge_read', note: 'Pressure 6.4 bar — nominal band', atMin: 4 },
          { stepIdx: 1, waypointId: 'HB-05', action: 'thermal_scan', note: 'Max ΔT +5.1 °C vs. baseline', atMin: 10 },
        ],
      },
    },
  ],
  eventSeedMins: [4, 11, 21, 38, 55, 79, 110, 150, 190],
  transformSeeds: [
    {
      id: 'wgs84-anchor',
      from: 'world',
      to: 'wgs84',
      params: { s: 1 / 111_320, thetaRad: 0, t: [121.605, 31.37] },
      note: 'lon = x·s + t[0] · lat = -z·s + t[1] (small-area approximation)',
    },
  ],
}

// ============================================================ Campus East — security patrol
// Three vendors, three adapters, one dispatcher on one site: Boston Dynamics
// Spot (bosdyn gRPC) + DeepRobotics X30 (robotserver TCP) + Gosuncn GS Patrol
// F2 ×2 (GoRobot cloud) — every unit arrives through integrations/, none is
// platform-native. Seeds below pin their ext-* serials.

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
  ruleSeeds: [
    { name: 'Perimeter crossing at night', model: 'person', kind: 'onboard-cv', source: 'x30ce-optical', sourceName: 'X30·CE · Optical', zone: 'North fence — restricted', threshold: 0.7, severity: 'critical', robotId: 'ext-x30-jy-2024-0031' },
    { name: 'Unattended bag — gate', model: 'unattended-bag', kind: 'cloud-cv', source: 'gate-cam', sourceName: 'Main gate camera', zone: 'Main gate check', threshold: 0.6, severity: 'high' },
    { name: 'Crowding — canteen rush', model: 'crowding', kind: 'cloud-cv', source: 'spotce-front', sourceName: 'SPOT·CE · Fisheye', zone: 'Canteen plaza', threshold: 0.55, severity: 'info', robotId: 'ext-bd-91250203' },
    { name: 'Fall detection — walkways', model: 'fall', kind: 'onboard-cv', source: 'perimeter-cam-c', sourceName: 'Walkway camera', zone: 'Main walk', threshold: 0.65, severity: 'high' },
    { name: 'E-bike in fire lane', model: 'ebike-blocking', kind: 'cloud-cv', source: 'lot-cam', sourceName: 'Parking P1 camera', zone: 'Fire lane — keep clear', threshold: 0.6, severity: 'high' },
    { name: 'Tailgating at gate', model: 'tailgating', kind: 'onboard-cv', source: 'gate-cam', sourceName: 'Main gate camera', zone: 'Main gate check', threshold: 0.65, severity: 'high' },
    { name: 'After-hours motion — stadium', model: 'motion', kind: 'sim', source: 'stadium-cam', sourceName: 'Stadium camera', zone: 'Stadium gate', threshold: 0.55, severity: 'low' },
    { name: 'VOC ceiling — chem storage', model: 'ogi', kind: 'threshold', source: 'x30ce-therm', sourceName: 'X30·CE · Gas detector', zone: 'Chemical storage', threshold: 1, severity: 'high', robotId: 'ext-x30-jy-2024-0031', metric: 'ch4.ppm', op: '>', bound: 6 },
  ],
  missionSeeds: [
    {
      // 三厂商协同:Spot(bosdyn) / X30(robotserver) / GS·F2(GoRobot) 各一条排程
      name: 'Gate–Library–Dorm checkpoint round',
      priority: 1,
      requestedRobot: 'ext-bd-91250203',
      recurring: true,
      everyMin: 7,
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
      requestedRobot: 'ext-x30-jy-2024-0031',
      recurring: true,
      everyMin: 9,
      steps: [
        { waypointId: 'WP-N1', actions: [A('thermal_scan', 7), A('capture_photo', 3)] },
        { waypointId: 'WP-N2', actions: [A('thermal_scan', 7)] },
        { waypointId: 'WP-S2', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-S1', actions: [A('thermal_scan', 6)] },
      ],
    },
    {
      name: 'Service-patrol canteen loop',
      priority: 2,
      requestedRobot: 'ext-gscn-f2-2024-0117',
      recurring: true,
      everyMin: 11,
      steps: [
        { waypointId: 'CP-06', actions: [A('wait', 5), A('capture_photo', 3)] },
        { waypointId: 'CP-01', actions: [A('capture_photo', 3)] },
      ],
    },
    {
      name: 'Morning gate rush watch',
      priority: 2,
      requestedRobot: 'ext-bd-91250203',
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
    { id: 'unattended-bag', label: 'Unattended bag', severity: 'high', category: 'security', detail: 'Static bag, no owner in radius — left-object protocol' },
    { id: 'crowding', label: 'Crowd density', severity: 'info', category: 'security', detail: 'Queue/crowd density above comfort threshold' },
    { id: 'fall', label: 'Person fallen', severity: 'high', category: 'security', detail: 'Person down and not recovering — medical dispatch check' },
    { id: 'ebike-blocking', label: 'E-bike blocking', severity: 'high', category: 'security', detail: 'E-bike parked in a fire lane / egress route' },
    { id: 'tailgating', label: 'Tailgating', severity: 'high', category: 'security', detail: 'Multiple entries on a single credential at a gate' },
  ],
  transformSeeds: [
    {
      id: 'wgs84-anchor',
      from: 'world',
      to: 'wgs84',
      params: { s: 1 / 111_320, thetaRad: 0, t: [121.605, 31.37] },
      note: 'lon = x·s + t[0] · lat = -z·s + t[1] (small-area approximation)',
    },
  ],
}

export const DEMO_SITES: SiteDef[] = [plant07, plant12, campus]
