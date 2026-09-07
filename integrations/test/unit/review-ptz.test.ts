import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'plantbot-ptz-review-'))
process.env.PB_DATA_DIR = temp
process.env.SESSION_SECRET = 'ptz-review-test-session'
const { PtzService } = await import('../../../server/src/ptz.js')
const { World } = await import('../../../server/src/world.js')
const { db } = await import('../../../server/src/db.js')
const { makePersist, createSiteRow } = await import('../../../server/src/config.js')
after(() => {
  db.close()
  rmSync(temp, { recursive: true, force: true })
})

test('confirmed PTZ dwell survives eviction of its completed order from the hot order window', () => {
  const rt = {
    id: 'review-dwell',
    name: 'Review',
    operator: 'test',
    bounds: { x: [0, 20] as [number, number], z: [0, 20] as [number, number] },
    dockWp: '',
    buildings: [],
    cameras: [],
    waypoints: [],
    zones: [],
    transforms: [],
    map: null,
  }
  createSiteRow({ ...rt, demo: false })
  const w = new World(rt, { persist: makePersist(rt.id) })
  const robot = w.registerExternal({
    serial: 'review-camera',
    model: 'Test adapter',
    level: 'dispatchable',
    streams: [
      {
        id: 'camera',
        name: 'Camera',
        kind: 'camera',
        ptz: { absolute: true, pan: [-180, 180], tilt: [-90, 90], zoom: [1, 20] },
      },
    ],
  })
  let now = Date.now()
  const service = new PtzService(new Map([[rt.id, w]]), () => now)
  const preset = service.preset(w, { name: 'Panel view', channelId: w.channels()[0].id, pan: 15, tilt: 5, zoom: 2 })
  const plan = service.plan(w, {
    name: 'Read panel',
    channelId: preset.channelId,
    enabled: false,
    cadence: { kind: 'interval', everyMin: 60 },
    steps: [{ presetId: preset.id, dwellS: 10 }],
  })
  const run = service.runPlan(w, plan.id, 'reviewer')
  const order = w.pullOrders(robot.id)[0]
  w.setOrderStatus(order.id, 'done', 'Measured position confirmed')
  service.tick()
  assert.equal(service.state(w).runs[0].steps[0].arrivedAt, now)
  // Other camera/mission traffic may retire a completed order while its
  // inspection still dwells. Arrival is already durable on the run itself.
  for (let i = 0; i < 200; i++) {
    const other = w.enqueueOrder(robot.id, 'announce', { text: `Other order ${i}` })
    w.setOrderStatus(other.id, 'done')
  }
  assert.equal(
    w.orders.some((o) => o.id === order.id),
    false,
  )
  now += 10_000
  service.tick()
  const restored = service.state(w).runs.find((r) => r.id === run.id)!
  assert.equal(restored.status, 'done')
  assert.equal(restored.steps[0].completedAt, now)
  assert.equal(restored.steps[0].note, 'Measured position confirmed')
})

test('direct semantic PTZ commands validate explicit modes and declared capability ranges', () => {
  const rt = {
    id: 'review-command',
    name: 'Review',
    operator: 'test',
    bounds: { x: [0, 20] as [number, number], z: [0, 20] as [number, number] },
    dockWp: '',
    buildings: [],
    cameras: [],
    waypoints: [],
    zones: [],
    transforms: [],
    map: null,
  }
  createSiteRow({ ...rt, demo: false })
  const w = new World(rt, { persist: makePersist(rt.id) })
  const robot = w.registerExternal({
    serial: 'review-directional',
    model: 'Test adapter',
    level: 'dispatchable',
    streams: [
      {
        id: 'ptz',
        name: 'Directional camera',
        kind: 'camera',
        ptz: { absolute: false, pan: [-90, 90], tilt: [-90, 90], zoom: [-9, 9] },
      },
      { id: 'fixed', name: 'Fixed camera', kind: 'camera' },
    ],
  })
  const ptz = w.channels().find((c) => c.streamKey === 'ptz')!,
    fixed = w.channels().find((c) => c.streamKey === 'fixed')!
  assert.equal(w.command(robot.id, { type: 'ptz', channelId: ptz.id, mode: 'typo', pan: 1 } as any).accepted, false)
  assert.equal(w.command(robot.id, { type: 'ptz', channelId: ptz.id, mode: 'relative', pan: 1e12 }).accepted, false)
  assert.equal(w.command(robot.id, { type: 'ptz', channelId: fixed.id, mode: 'relative', pan: 1 }).accepted, false)
  assert.equal(w.command(robot.id, { type: 'ptz', channelId: ptz.id, mode: 'relative', pan: 10 }).accepted, true)
})
