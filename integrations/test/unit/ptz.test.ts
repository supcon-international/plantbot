import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const temp = mkdtempSync(join(tmpdir(), 'plantbot-ptz-test-'))
process.env.PB_DATA_DIR = temp
process.env.SESSION_SECRET = 'ptz-test-session'
const { PtzService, nextPtzRun, registerPtz } = await import('../../../server/src/ptz.js')
const { World } = await import('../../../server/src/world.js')
const { db } = await import('../../../server/src/db.js')
const { makePersist, createSiteRow, deleteSiteRow, createUser, loadSiteOps, loadSeqs } = await import(
  '../../../server/src/config.js'
)
const { issueSession } = await import('../../../server/src/auth.js')
const { default: Fastify } = await import('fastify')
after(() => {
  db.close()
  rmSync(temp, { recursive: true, force: true })
})
let seq = 0
function fixture(absolute = true) {
  const id = `ptz-${seq++}`,
    rt = {
      id,
      name: id,
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
  const w = new World(rt, { persist: makePersist(id) })
  const factsheet = {
    serial: `test-${id}`,
    model: 'PTZ test adapter',
    level: 'dispatchable' as const,
    streams: [
      {
        id: 'camera',
        name: 'Calibrated PTZ',
        kind: 'camera' as const,
        url: 'rtsp://private:secret@camera/stream',
        ptz: {
          absolute,
          pan: [-180, 180] as [number, number],
          tilt: [-90, 90] as [number, number],
          zoom: [1, 30] as [number, number],
        },
      },
    ],
  }
  const robot = w.registerExternal(factsheet),
    ch = w.channels()[0].id
  let clock = Date.now(),
    worlds = new Map([[id, w]])
  const service = new PtzService(worlds, () => clock, 1000)
  const preset = (name: string, pan = 0) => service.preset(w, { name, channelId: ch, pan, tilt: 0, zoom: 1 })
  const plan = (ids: string[], enabled = false) =>
    service.plan(w, {
      name: 'Patrol',
      channelId: ch,
      steps: ids.map((presetId) => ({ presetId, dwellS: 2 })),
      cadence: { kind: 'interval', everyMin: 1 },
      enabled,
    })
  return {
    w,
    ch,
    robot,
    service,
    preset,
    plan,
    worlds,
    rt,
    factsheet,
    advance: (ms: number) => {
      clock += ms
      service.tick()
    },
    current: () => service.state(w).runs[0],
  }
}

test('ordered patrol waits for done receipt, dwells and retains immutable pose snapshots', () => {
  const f = fixture(),
    a = f.preset('First', -20),
    b = f.preset('Second', 30),
    p = f.plan([a.id, b.id])
  const run = f.service.runPlan(f.w, p.id, 'operator')
  assert.equal(f.w.orders.length, 1)
  assert.equal(f.w.orders[0].payload.mode, 'absolute')
  assert.equal(f.w.command(f.robot.id, { type: 'ptz', channelId: f.ch, pan: 1 }).accepted, false)
  f.w.pullOrders(f.robot.id)
  f.advance(500)
  assert.equal(f.current().steps[0].arrivedAt, undefined)
  f.w.setOrderStatus(f.w.orders[0].id, 'done', 'position confirmed')
  f.advance(0)
  f.service.preset(f.w, { ...a, pan: 80 }, a.id)
  assert.equal(f.current().steps[0].pan, -20)
  f.advance(1999)
  assert.equal(f.w.orders.length, 1)
  f.advance(1)
  assert.equal(f.w.orders.length, 2)
  assert.equal(f.w.orders[1].payload.pan, 30)
  f.w.pullOrders(f.robot.id)
  f.w.setOrderStatus(f.w.orders[1].id, 'done')
  f.advance(0)
  f.advance(2000)
  assert.equal(f.current().status, 'done')
  assert.equal(f.w.ptzLocks.size, 0)
  assert.equal(f.current().id, run.id)
})

test('unsupported adapter can keep disabled drafts but cannot enable or execute presets', () => {
  const f = fixture(false),
    a = f.preset('Prepared'),
    p = f.plan([a.id])
  assert.throws(() => f.service.runPlan(f.w, p.id, 'op'), /does not support absolute/)
  assert.throws(() => f.plan([a.id], true), /save this plan disabled/)
  assert.equal(f.w.orders.length, 0)
  assert.throws(() => f.service.manual(f.w, { channelId: f.ch, mode: 'relative', pan: 30 }, 'op'), /safe stop/)
  const r = f.service.manual(f.w, { channelId: f.ch, mode: 'home' }, 'op')
  assert.equal(r.mode, 'home')
  f.w.pullOrders(f.robot.id)
  f.w.setOrderStatus(f.w.orders[0].id, 'done', 'vendor accepted; position not verified')
  f.advance(0)
  assert.equal(f.current().steps[0].note, 'vendor accepted; position not verified')
})

test('failure receipt ends patrol and never dispatches the next stop', () => {
  const f = fixture(),
    a = f.preset('One'),
    p = f.plan([a.id, a.id])
  f.service.runPlan(f.w, p.id, 'op')
  f.w.pullOrders(f.robot.id)
  f.w.setOrderStatus(f.w.orders[0].id, 'failed', 'motor fault')
  f.advance(0)
  assert.equal(f.current().status, 'failed')
  assert.equal(f.current().note, 'motor fault')
  assert.equal(f.w.orders.length, 1)
})

test('cancel pending is retractable; cancel delivered control interlocks until verified', () => {
  const f = fixture(),
    a = f.preset('One')
  let run = f.service.runPreset(f.w, a.id, 'op')
  f.service.cancel(f.w, run.id)
  assert.equal(f.w.pullOrders(f.robot.id).length, 0)
  assert.equal(f.w.ptzLocks.size, 0)
  run = f.service.runPreset(f.w, a.id, 'op')
  f.w.pullOrders(f.robot.id)
  f.service.cancel(f.w, run.id)
  assert.equal(f.current().interlocked, true)
  assert.throws(() => f.service.runPreset(f.w, a.id, 'op'), /camera is busy/)
  f.w.setOrderStatus(f.w.orders.at(-1)!.id, 'done', 'late')
  assert.equal(f.w.orders.at(-1)!.state, 'failed')
  f.service.release(f.w, run.id, 'inspector')
  assert.equal(f.w.ptzLocks.size, 0)
  assert.match(f.current().note!, /inspector/)
  assert.equal(f.service.runPreset(f.w, a.id, 'op').status, 'running')
})

test('cancel during dwell preserves successful arrival and releases camera', () => {
  const f = fixture(),
    a = f.preset('One'),
    p = f.plan([a.id]),
    run = f.service.runPlan(f.w, p.id, 'op')
  f.w.pullOrders(f.robot.id)
  f.w.setOrderStatus(f.w.orders[0].id, 'done', 'at preset')
  f.advance(0)
  f.service.cancel(f.w, run.id)
  assert.equal(f.w.orders[0].state, 'done')
  assert.equal(f.w.orders[0].note, 'at preset')
  assert.equal(f.current().status, 'cancelled')
  assert.equal(f.w.ptzLocks.size, 0)
})

test('timeout fails a delivered order and persists the camera interlock', () => {
  const f = fixture(),
    a = f.preset('One')
  f.service.runPreset(f.w, a.id, 'op')
  f.w.pullOrders(f.robot.id)
  f.advance(1000)
  assert.equal(f.current().status, 'failed')
  assert.equal(f.current().interlocked, true)
  assert.match(f.current().note!, /Timed out/)
  f.w.ptzLocks.clear()
  new PtzService(f.worlds)
  assert.equal(f.w.ptzLocks.size, 1)
})

test('restart recovery retracts replayed orders and records indeterminate position', () => {
  const f = fixture(),
    a = f.preset('One')
  f.service.runPreset(f.w, a.id, 'op')
  f.w.pullOrders(f.robot.id)
  const rebooted = new World(f.rt, { persist: makePersist(f.w.id) })
  rebooted.registerExternal(f.factsheet, { online: false })
  rebooted.hydrate(loadSiteOps(f.w.id) as Parameters<typeof rebooted.hydrate>[0], loadSeqs(f.w.id))
  const service = new PtzService(new Map([[f.w.id, rebooted]]))
  const run = service.state(rebooted).runs[0]
  assert.equal(run.status, 'failed')
  assert.equal(run.interlocked, true)
  assert.equal(rebooted.pullOrders(f.robot.id).length, 0)
})

test('plans validate channel references, ranges and scheduled times; referenced presets cannot be deleted', () => {
  const f = fixture(),
    a = f.preset('One'),
    p = f.plan([a.id])
  assert.throws(() => f.preset('Outside', 181), /pan/)
  assert.throws(() => f.service.preset(f.w, { ...a, pan: null }), /pan/)
  assert.throws(() => f.service.plan(f.w, { ...p, steps: [{ presetId: a.id, dwellS: 0 }] }), /dwell/)
  assert.throws(() => f.service.plan(f.w, { ...p, cadence: { kind: 'weekly', at: '24:00', days: [1] } }), /cadence/)
  assert.throws(() => f.service.plan(f.w, { ...p, cadence: { kind: 'once', at: 100 }, enabled: true }), /future/)
  assert.throws(() => f.service.deletePreset(f.w, a.id), /used by/)
  f.service.deletePlan(f.w, p.id)
  f.service.deletePreset(f.w, a.id)
  assert.equal(f.service.state(f.w).presets.length, 0)
})

test('weekly scheduling uses UTC; interval schedules avoid overlapping movement', () => {
  const monday = Date.UTC(2026, 8, 7, 8, 0)
  assert.equal(nextPtzRun({ kind: 'weekly', days: [1], at: '09:00' }, monday), Date.UTC(2026, 8, 7, 9, 0))
  assert.equal(nextPtzRun({ kind: 'weekly', days: [1], at: '09:00' }, monday + 3600000), Date.UTC(2026, 8, 14, 9, 0))
  const f = fixture(),
    a = f.preset('One')
  f.plan([a.id], true)
  f.advance(60000)
  assert.equal(f.w.orders.length, 1)
  assert.equal(f.current().by, 'schedule')
  f.w.pullOrders(f.robot.id)
  f.advance(60000)
  assert.equal(f.w.orders.length, 1)
})

test('archive cursor reaches all records, isolates sites and site deletion cascades', () => {
  const f = fixture(),
    other = fixture(),
    a = f.preset('One')
  for (let i = 0; i < 5; i++) {
    const r = f.service.runPreset(f.w, a.id, 'op')
    f.service.cancel(f.w, r.id)
  }
  const first = f.service.records(f.w, { limit: '2' }),
    second = f.service.records(f.w, { limit: '2', before: String(first.nextCursor) }),
    third = f.service.records(f.w, { limit: '2', before: String(second.nextCursor) })
  assert.equal(new Set([...first.runs, ...second.runs, ...third.runs].map((r) => r.id)).size, 5)
  assert.equal(third.nextCursor, null)
  assert.equal(f.service.records(other.w, {}).runs.length, 0)
  assert.equal(f.service.records(f.w, { since: String(Date.now() + 99999) }).runs.length, 0)
  assert.throws(() => f.service.records(f.w, { before: 'NaN' }), /invalid/)
  deleteSiteRow(f.w.id)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ptz_runs WHERE site_id=?').get(f.w.id) as any).n, 0)
})

test('HTTP routes enforce operator RBAC and expose redacted camera data', async () => {
  const f = fixture(),
    app = Fastify()
  registerPtz(app, f.worlds)
  createUser({ username: 'ptz-op', password: 'test', roles: { [f.w.id]: 'operator' } })
  app.get('/session', (req, reply) => {
    issueSession(req, reply, 'ptz-op')
    return { ok: true }
  })
  const url = `/api/sites/${f.w.id}/ptz`
  assert.equal(
    (await app.inject({ method: 'POST', url: `${url}/presets`, payload: { name: 'No access' } })).statusCode,
    401,
  )
  const state = await app.inject(url)
  assert.equal(state.statusCode, 200)
  assert.ok(!state.body.includes('secret'))
  const session = await app.inject('/session'),
    cookie = String(session.headers['set-cookie']).split(';')[0]
  const saved = await app.inject({
    method: 'POST',
    url: `${url}/presets`,
    headers: { cookie },
    payload: { name: 'HTTP preset', channelId: f.ch, pan: 0, tilt: 0, zoom: 1 },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().preset.name, 'HTTP preset')
  const missing = await app.inject({
    method: 'POST',
    url: `${url}/runs/missing/release`,
    headers: { cookie },
    payload: {},
  })
  assert.equal(missing.statusCode, 400)
  assert.equal((await app.inject({ method: 'GET', url: '/api/sites/missing/ptz' })).statusCode, 404)
  await app.close()
})

test('receipt evicted before the next PTZ tick is recovered from the durable order store', () => {
  const f = fixture(),
    a = f.preset('One')
  f.service.runPreset(f.w, a.id, 'op')
  f.w.pullOrders(f.robot.id)
  f.w.setOrderStatus(f.w.orders[0].id, 'done', 'measured arrival')
  for (let i = 0; i < 200; i++) f.w.enqueueOrder(f.robot.id, 'announce', { text: 'other work' })
  assert.equal(
    f.w.orders.some((o) => o.kind === 'ptz'),
    false,
  )
  f.advance(0)
  assert.equal(f.current().status, 'done')
  assert.equal(f.current().steps[0].note, 'measured arrival')
})
