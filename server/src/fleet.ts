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
}

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
  { id: 'WP-05', name: 'Substation apron', x: -11, z: 4.6, kind: 'inspect' },
  { id: 'WP-06', name: 'Bay B2 door', x: -3, z: 5.0, kind: 'nav' },
  { id: 'WP-07', name: 'Transfer pumps', x: 5, z: 4.7, kind: 'inspect' },
  { id: 'WP-08', name: 'Tank farm', x: 11, z: 5.0, kind: 'inspect' },
  { id: 'WP-09', name: 'Charge dock', x: -13.6, z: -6.9, kind: 'dock' },
  { id: 'WP-10', name: 'Workshop ramp', x: 10.5, z: -4.8, kind: 'nav' },
  { id: 'WP-11', name: 'North fence mid', x: 0, z: -7.2, kind: 'nav' },
  { id: 'WP-12', name: 'South fence mid', x: 0, z: 7.2, kind: 'nav' },
  { id: 'WP-13', name: 'Truck bay', x: 7.2, z: -1.2, kind: 'inspect' },
]

export const ZONES: Zone[] = [
  {
    id: 'ZN-01',
    name: 'Vehicle exclusion',
    kind: 'restricted',
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
    polygon: [
      [12.9, 1.6],
      [15.6, 1.6],
      [15.6, 7.6],
      [12.9, 7.6],
    ],
  },
  {
    id: 'ZN-03',
    name: 'Substation',
    kind: 'inspection',
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
    polygon: [
      [-15.4, -8.5],
      [-12.4, -8.5],
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
    color: '#e8edf2',
    home: { x: -13.6, z: -6.9 },
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
    color: '#aeb9c4',
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
    color: '#7c8895',
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
]

export const SITE_CAMERAS: SiteCamera[] = [
  {
    id: 'perimeter-cam',
    name: 'Perimeter — Reservoir Gate',
    place: 'North fence, waterline sector',
    stream: 'perimeter-cam',
    live: true,
    source: 'Public RTSP · stream.strba.sk (live)',
  },
  {
    id: 'workshop-cam',
    name: 'Dock Camera',
    place: 'Robot staging area, fixed mount',
    stream: 'workshop-cam',
    file: '/media/staging.mp4',
    live: false,
    source: 'RTSP loop · local relay',
  },
  {
    id: 'mast-cam',
    name: 'Mast — Plant Overview',
    place: '30 m mast, wide sector',
    stream: 'mast-cam',
    file: '/media/plant_aerial.mp4',
    live: false,
    source: 'RTSP loop · local relay',
  },
]

// go2rtc stream table. exec loops republish local public-license footage
// through go2rtc's RTSP server, so every consumer path is genuine RTSP→MSE.
export function streamTable(mediaDir: string, ffmpeg: string) {
  const loop = (file: string, extra = '-c:v copy -an') =>
    `exec:${ffmpeg} -hide_banner -loglevel error -re -stream_loop -1 -i ${mediaDir}/${file} ${extra} -rtsp_transport tcp -f rtsp {output}`
  const thermal = (file: string) =>
    loop(
      file,
      '-vf format=gray,format=gbrp,pseudocolor=preset=inferno,scale=640:-2 -r 15 -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p -an',
    )
  const ogi = (file: string) =>
    loop(
      file,
      '-vf format=gray,eq=contrast=1.55:brightness=-0.06,unsharp=5:5:0.8,noise=alls=5:allf=t,scale=640:-2 -r 15 -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p -an',
    )
  return {
    'perimeter-cam': 'rtsp://stream.strba.sk:1935/strba/VYHLAD_JAZERO.stream',
    'lite3-front': loop('switchgear.mp4'),
    'lite3-thermal': thermal('smokestack.mp4'),
    'x30-optical': loop('substation.mp4'),
    'agx-ogi': ogi('pumpjack.mp4'),
    'workshop-cam': loop('staging.mp4'),
    'mast-cam': loop('plant_aerial.mp4'),
  } as Record<string, string>
}
