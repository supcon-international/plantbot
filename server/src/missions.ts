// Mission engine: missions are ordered sequences of waypoint + actions.
// Operators define goals; each robot's nav stack (planner.ts as stand-in)
// computes the actual route. The dispatcher assigns queued missions to
// available robots by priority, battery and distance.

import { ROBOTS, WAYPOINTS, type RobotSpec } from './fleet.js'
import { planPath, pathLength } from './planner.js'

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
  onResult?: (m: Mission, r: MissionResult) => void
}

const wpById = new Map(WAYPOINTS.map((w) => [w.id, w]))
export const missions: Mission[] = []
let seq = 100

export const nav = new Map<string, NavState>()
for (const r of ROBOTS) {
  nav.set(r.id, {
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

export function createMission(
  data: {
    name: string
    priority?: 1 | 2 | 3
    requestedRobot?: string
    recurring?: boolean
    steps: MissionStep[]
  },
  status: Mission['status'] = 'queued',
): Mission {
  const m: Mission = {
    id: `M-${seq++}`,
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
  }
  missions.push(m)
  return m
}

export function abortMission(id: string) {
  const m = missions.find((x) => x.id === id)
  if (!m || (m.status !== 'active' && m.status !== 'queued')) return m
  if (m.status === 'active' && m.robotId) {
    const s = nav.get(m.robotId)!
    s.state = 'idle'
    s.path = []
    s.missionId = undefined
  }
  m.status = 'aborted'
  m.endedAt = Date.now()
  return m
}

export function teleopGoto(robotId: string, x: number, z: number) {
  const s = nav.get(robotId)
  if (!s) return false
  s.teleopTarget = { x, z }
  s.state = 'teleop'
  s.path = planPath(s.x, s.z, x, z)
  s.pathRemaining = pathLength(s.path)
  s.actionLeft = 0
  return true
}

// ---------- dispatcher ----------

function assignQueued() {
  const queued = missions
    .filter((m) => m.status === 'queued')
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
  for (const m of queued) {
    const candidates = ROBOTS.filter((r) => {
      const s = nav.get(r.id)!
      if (s.state !== 'idle') return false
      if (s.battery < 25) return false
      if (m.requestedRobot !== 'auto' && m.requestedRobot !== r.id) return false
      return true
    })
    if (!candidates.length) continue
    // nearest-first among candidates
    const first = wpById.get(m.steps[0]?.waypointId)
    candidates.sort((a, b) => {
      if (!first) return 0
      const sa = nav.get(a.id)!
      const sb = nav.get(b.id)!
      return Math.hypot(sa.x - first.x, sa.z - first.z) - Math.hypot(sb.x - first.x, sb.z - first.z)
    })
    const robot = candidates[0]
    const s = nav.get(robot.id)!
    m.robotId = robot.id
    m.status = 'active'
    m.startedAt = Date.now()
    m.currentStep = 0
    m.progress = 0
    s.missionId = m.id
    beginLeg(robot, s, m)
  }
}

function beginLeg(robot: RobotSpec, s: NavState, m: Mission) {
  const step = m.steps[m.currentStep]
  const wp = step && wpById.get(step.waypointId)
  if (!wp) {
    finishMission(s, m)
    return
  }
  s.state = 'navigating'
  s.targetWp = wp.id
  s.path = planPath(s.x, s.z, wp.x, wp.z)
  s.pathRemaining = pathLength(s.path)
  s.actionIdx = 0
  s.actionLeft = 0
}

const recurCooldown = () => 35_000 + Math.random() * 55_000

function finishMission(s: NavState, m: Mission) {
  m.progress = 1
  m.endedAt = Date.now()
  s.missionId = undefined
  s.state = 'idle'
  s.path = []
  if (m.recurring) {
    // same mission object cycles back into the queue after a cooldown,
    // keeping history clean and the schedule believable
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

// ---------- movement integration ----------

function followPath(s: NavState, max: number, dt: number) {
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
  s.pathRemaining = pathLength([{ x: s.x, z: s.z }, ...s.path])
  return s.path.length === 0
}

const ACTION_NOTES: Record<ActionType, (r: RobotSpec) => { ok: boolean; note: string }> = {
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

export function grabSnapshotHook(
  fn: (stream: string, missionId: string) => Promise<string | undefined>,
) {
  snapshotFn = fn
}
let snapshotFn: ((stream: string, missionId: string) => Promise<string | undefined>) | null = null

/** advance all robots; returns per-robot nav state (mutated in place) */
export function tickMissions(dt: number) {
  assignQueued()
  for (const robot of ROBOTS) {
    const s = nav.get(robot.id)!
    const cruise = robot.family === 'ugv' ? robot.maxSpeed * 0.85 : robot.maxSpeed * 0.38

    // battery drain / charge
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

    // low battery → abort to dock
    if (s.battery < 18 && s.state !== 'teleop') {
      const m = s.missionId && missions.find((x) => x.id === s.missionId)
      if (m && m.status === 'active') {
        m.status = 'queued' // hand back for another unit
        m.robotId = undefined
        s.missionId = undefined
      }
      const dock = wpById.get('WP-09')!
      s.state = 'teleop'
      s.teleopTarget = { x: dock.x, z: dock.z }
      s.path = planPath(s.x, s.z, dock.x, dock.z)
    }

    if (s.state === 'teleop') {
      s.speed += (cruise - s.speed) * Math.min(1, dt * 2)
      const arrived = followPath(s, s.speed, dt)
      if (arrived) {
        s.teleopTarget = undefined
        const nearDock = Math.hypot(s.x - wpById.get('WP-09')!.x, s.z - wpById.get('WP-09')!.z) < 1.2
        if (s.battery < 30 && nearDock) {
          s.state = 'charging'
        } else if (s.missionId) {
          const m = missions.find((x) => x.id === s.missionId)
          if (m) beginLeg(robot, s, m)
          else s.state = 'idle'
        } else {
          s.state = 'idle'
        }
      }
      continue
    }

    const m = s.missionId ? missions.find((x) => x.id === s.missionId) : undefined
    if (!m || m.status !== 'active') {
      s.state = 'idle'
      s.speed = Math.max(0, s.speed - dt * 2)
      continue
    }

    if (s.state === 'navigating') {
      s.speed += (cruise - s.speed) * Math.min(1, dt * 2)
      const arrived = followPath(s, s.speed, dt)
      if (arrived) {
        s.state = 'executing'
        s.speed = 0
        s.actionIdx = 0
        const step = m.steps[m.currentStep]
        s.actionLeft = step.actions[0]?.durationS ?? 0
      }
    } else if (s.state === 'executing') {
      s.speed = 0
      s.actionLeft -= dt
      const step = m.steps[m.currentStep]
      if (s.actionLeft <= 0 && step) {
        const action = step.actions[s.actionIdx]
        if (action) {
          const { ok, note } = ACTION_NOTES[action.type](robot)
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
          if (src && snapshotFn) {
            snapshotFn(src, m.id).then((snap) => {
              if (snap) res.snapshot = snap
            })
          }
          s.onResult?.(m, res)
        }
        s.actionIdx++
        const nextAction = step.actions[s.actionIdx]
        if (nextAction) {
          s.actionLeft = nextAction.durationS
        } else {
          m.currentStep++
          m.progress = +(m.currentStep / m.steps.length).toFixed(3)
          if (m.currentStep >= m.steps.length) finishMission(s, m)
          else beginLeg(robot, s, m)
        }
      }
    } else {
      // idle with an assigned mission — begin
      beginLeg(robot, s, m)
    }
  }
}

// ---------- seed ----------

const A = (type: ActionType, durationS: number) => ({ type, durationS })

export function seedMissions() {
  // recurring patrols (one per robot)
  const north = createMission(
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
    'queued',
  )
  const south = createMission(
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
    'queued',
  )
  const ogi = createMission(
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
    'queued',
  )
  // a queued one-shot for the dispatcher to hand out
  createMission({
    name: 'Manifold VM-4 recheck',
    priority: 1,
    requestedRobot: 'auto',
    steps: [
      { waypointId: 'WP-02', actions: [A('gauge_read', 8), A('capture_photo', 3)] },
    ],
  })
  // completed history
  const done1 = createMission(
    {
      name: 'Dawn thermal sweep',
      priority: 2,
      requestedRobot: 'x30-01',
      steps: [
        { waypointId: 'WP-03', actions: [A('thermal_scan', 8)] },
        { waypointId: 'WP-07', actions: [A('thermal_scan', 8)] },
      ],
    },
    'done',
  )
  done1.robotId = 'x30-01'
  done1.createdAt = Date.now() - 5.2 * 3600_000
  done1.startedAt = done1.createdAt + 60_000
  done1.endedAt = done1.startedAt + 14 * 60_000
  done1.progress = 1
  done1.results = [
    { ts: done1.startedAt + 5 * 60_000, stepIdx: 0, waypointId: 'WP-03', action: 'thermal_scan', ok: true, note: 'Max ΔT +6.2 °C vs. baseline' },
    { ts: done1.startedAt + 12 * 60_000, stepIdx: 1, waypointId: 'WP-07', action: 'thermal_scan', ok: true, note: 'Max ΔT +4.8 °C vs. baseline' },
  ]
  const done2 = createMission(
    {
      name: 'Perimeter integrity check',
      priority: 3,
      requestedRobot: 'lite3-01',
      steps: [
        { waypointId: 'WP-01', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-11', actions: [A('capture_photo', 3)] },
        { waypointId: 'WP-04', actions: [A('capture_photo', 3)] },
      ],
    },
    'done',
  )
  done2.robotId = 'lite3-01'
  done2.createdAt = Date.now() - 9.6 * 3600_000
  done2.startedAt = done2.createdAt + 30_000
  done2.endedAt = done2.startedAt + 22 * 60_000
  done2.progress = 1
  done2.results = [
    { ts: done2.startedAt + 4 * 60_000, stepIdx: 0, waypointId: 'WP-01', action: 'capture_photo', ok: true, note: 'Frame archived · exposure auto' },
    { ts: done2.startedAt + 11 * 60_000, stepIdx: 1, waypointId: 'WP-11', action: 'capture_photo', ok: true, note: 'Frame archived · exposure auto' },
    { ts: done2.startedAt + 20 * 60_000, stepIdx: 2, waypointId: 'WP-04', action: 'capture_photo', ok: true, note: 'Frame archived · exposure auto' },
  ]
  return { north, south, ogi }
}
