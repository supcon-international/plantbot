// Virtual Gosuncn (高新兴) GS Patrol F2 adapter — two service-patrol units that
// join Campus East through the SAME World entry points the HTTP integration
// API uses (registerExternal / ingestState / ingestReadings / ingestEvent /
// pullOrders / setOrderStatus). Everything an on-prem vendor adapter would do
// over /api/integration/v1 happens here in-process, so the demo always shows a
// live third-party fleet: motion, ambient readings, order round-trips, and the
// signature "unattended bag" reports (low-confidence ones hit the LLM trust
// gate before operators ever see them).

import type { World } from './world.js'
import type { RobotSpec } from './fleet.js'

const PUB = process.env.PUBLIC_BASE ?? ''
const media = (f: string) => `${PUB}/media/${f}`

interface Unit {
  robot: RobotSpec
  loop: { x: number; z: number }[]
  leg: number
  t: number // 0..1 along the current leg
  dwellUntil: number
  battery: number
  /** an accepted goto order temporarily overrides the loop */
  order?: { id: string; x: number; z: number }
}

const SPEED = 0.85 // m/s
const DWELL_MS = 9000

export function startGosim(w: World) {
  const gs1 = w.registerExternal({
    serial: 'GSCN-F2-2024-0117',
    model: 'GS Patrol F2',
    vendor: 'Gosuncn Robotics 高新兴',
    callsign: 'GS·F2-01',
    family: 'ugv',
    level: 'dispatchable',
    protocol: 'GRobot adapter · Integration API v1',
    home: { x: 0, z: 7.2 },
    streams: [
      { id: 'gs1-front', name: 'Front PTZ', kind: 'camera', url: media('campus_quad.mp4') },
      { id: 'gs1-rear', name: 'Rear camera', kind: 'camera', url: media('theft_cctv.mp4') },
    ],
  })
  const gs2 = w.registerExternal({
    serial: 'GSCN-F2-2024-0118',
    model: 'GS Patrol F2',
    vendor: 'Gosuncn Robotics 高新兴',
    callsign: 'GS·F2-02',
    family: 'ugv',
    level: 'state-only',
    protocol: 'GRobot adapter · Integration API v1',
    home: { x: 5, z: -5.6 },
    streams: [{ id: 'gs2-front', name: 'Front PTZ', kind: 'camera', url: media('campus_walk.mp4') }],
  })

  const units: Unit[] = [
    {
      robot: gs1,
      // main-walk / gate / stadium service loop
      loop: [
        { x: 0, z: 7.2 },
        { x: -5.2, z: 4.6 },
        { x: -9, z: 6.2 },
        { x: -12, z: 7.6 },
        { x: -9, z: 6.2 },
        { x: -5.2, z: 4.6 },
        { x: 0, z: 7.2 },
        { x: 5.4, z: 6.4 },
        { x: 8.2, z: 4.2 },
        { x: 5.4, z: 6.4 },
      ],
      leg: 0,
      t: 0,
      dwellUntil: 0,
      battery: 87,
    },
    {
      robot: gs2,
      // dorm / canteen quad loop
      loop: [
        { x: 5, z: -5.6 },
        { x: 0, z: -5.2 },
        { x: -4, z: -5.5 },
        { x: -8.5, z: -5.4 },
        { x: -4, z: -5.5 },
        { x: 0, z: -5.2 },
      ],
      leg: 0,
      t: 0,
      dwellUntil: 0,
      battery: 72,
    },
  ]

  // ---- 1 Hz: drive the loop, report state, honor pulled orders ----
  setInterval(() => {
    const now = Date.now()
    for (const u of units) {
      // dispatchable unit: pull pending orders exactly like an HTTP adapter would
      if (u.robot.integrationLevel === 'dispatchable' && !u.order) {
        const [o] = w.pullOrders(u.robot.id)
        if (o?.kind === 'goto' && typeof o.payload.x === 'number' && typeof o.payload.z === 'number')
          u.order = { id: o.id, x: o.payload.x, z: o.payload.z }
        else if (o?.kind === 'announce') w.setOrderStatus(o.id, 'done', `Played: “${o.payload.text ?? ''}”`)
        else if (o) w.setOrderStatus(o.id, 'failed', 'unsupported order kind for service unit')
      }

      const nav = w.nav.get(u.robot.id)
      if (!nav) continue
      const from = { x: nav.x, z: nav.z }
      const target = u.order ?? u.loop[(u.leg + 1) % u.loop.length]
      let mode: string = 'navigating'
      let speed = SPEED

      if (!u.order && now < u.dwellUntil) {
        mode = 'executing' // checkpoint dwell — camera sweep
        speed = 0
      } else {
        const dx = target.x - from.x
        const dz = target.z - from.z
        const d = Math.hypot(dx, dz)
        if (d < 0.15) {
          if (u.order) {
            w.setOrderStatus(u.order.id, 'done', 'Arrived · 360° capture complete')
            u.order = undefined
          } else {
            u.leg = (u.leg + 1) % u.loop.length
            u.dwellUntil = now + DWELL_MS * (0.5 + Math.random())
          }
          speed = 0
          mode = 'executing'
        } else {
          const step = Math.min(SPEED, d)
          from.x += (dx / d) * step
          from.z += (dz / d) * step
        }
      }

      u.battery = u.battery <= 24 ? 88 : u.battery - 0.006 // hot-swap pack at the depot
      w.ingestState(u.robot.id, {
        x: +from.x.toFixed(2),
        z: +from.z.toFixed(2),
        heading: Math.atan2(-(target.z - from.z), target.x - from.x),
        speed,
        battery: +u.battery.toFixed(1),
        mode,
      })
    }
  }, 1000)

  // ---- 5 s: ambient readings (the F2's service-payload set) ----
  setInterval(() => {
    const t = Date.now()
    for (const [i, u] of units.entries()) {
      w.ingestReadings(u.robot.id, [
        { metric: 'amb.temp.c', value: +(24.5 + 3.5 * Math.sin(t / 900_000 + i) + Math.random() * 0.4).toFixed(1) },
        { metric: 'amb.rh.pct', value: Math.round(58 + 12 * Math.sin(t / 1_300_000 + i * 2) + Math.random() * 2) },
        { metric: 'noise.db', value: +(48 + 9 * Math.sin(t / 240_000 + i) + Math.random() * 3).toFixed(1) },
      ])
    }
  }, 5000)

  // ---- the signature report: unattended-bag sightings from the rear camera ----
  const bagReport = async () => {
    const u = units[0] // the dispatchable unit carries the rear analytics camera
    const nav = w.nav.get(u.robot.id)
    const snap = await w.missionSnapshot('gs1-rear', 'GS-BAG').catch(() => undefined)
    const confidence = +(0.58 + Math.random() * 0.34).toFixed(2) // low ones hit the trust gate
    w.ingestEvent({
      type: 'unattended-bag',
      robotId: u.robot.id,
      sourceName: 'GS·F2-01 · rear cam',
      detail: `Backpack static ${(2 + Math.random() * 6).toFixed(0)} min on patrol pass · no owner within ${(3 + Math.random() * 5).toFixed(0)} m · re-check queued`,
      severity: 'high',
      confidence,
      snapshotUrl: snap,
      x: nav?.x,
      z: nav?.z,
    })
    setTimeout(bagReport, 200_000 + Math.random() * 280_000)
  }
  setTimeout(bagReport, 45_000 + Math.random() * 30_000)
}
