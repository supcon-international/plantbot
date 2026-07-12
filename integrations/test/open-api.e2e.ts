// Open read-API + camera CRUD e2e: the platform's operational data served to
// third parties over the same Bearer key, and the Video wall's fixed-camera
// lifecycle. Real platform, no mocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPlatform, api, integration } from './harness.js'

const PORT = 8973
const SITE = 'plant-07'
const KEY = 'pbk_dev_plant07' // seeded by PB_DEV_KEYS in the harness

test('open API：openapi.json / 只读数据面 / readings 往返 / 鉴权 / 相机 CRUD', { timeout: 60_000 }, async () => {
  const stack = await bootPlatform(PORT)
  try {
    // -- spec is served without auth and is a real 3.0 document
    const spec = await (await fetch(`${stack.base}/api/integration/v1/openapi.json`)).json()
    assert.equal(spec.openapi, '3.0.3')
    assert.ok(Object.keys(spec.paths).length >= 15, 'spec covers the surface')

    // -- everything else refuses without a key
    const noKey = await fetch(`${stack.base}/api/integration/v1/fleet`)
    assert.equal(noKey.status, 401)

    // -- fleet: robots + the same telemetry frame the console renders
    const fleet = await integration(stack.base, KEY, 'GET', '/fleet')
    assert.equal(fleet.status, 200)
    assert.ok(Array.isArray(fleet.body.robots) && Array.isArray(fleet.body.telemetry))

    // -- events: write → read round-trip over the same key
    const raised = await integration(stack.base, KEY, 'POST', '/events', {
      type: 'person', detail: 'read-api round-trip', severity: 'info', x: 1, z: 2,
    })
    assert.equal(raised.status, 200, JSON.stringify(raised.body))
    const evs = await integration(stack.base, KEY, 'GET', '/events?limit=5')
    assert.equal(evs.status, 200)
    assert.ok(evs.body.events.length > 0 && evs.body.events.length <= 5)
    assert.ok(evs.body.events.some((e: any) => e.detail === 'read-api round-trip'), 'raised event readable')

    // -- missions + schedules + channels (rtsp stays redacted)
    const ms = await integration(stack.base, KEY, 'GET', '/missions?limit=10')
    assert.equal(ms.status, 200)
    const sc = await integration(stack.base, KEY, 'GET', '/schedules')
    assert.ok(Array.isArray(sc.body.schedules) && Array.isArray(sc.body.templates))
    const ch = await integration(stack.base, KEY, 'GET', '/channels')
    for (const c of ch.body.channels)
      if (c.source.kind === 'rtsp') assert.equal(c.source.url, '', 'rtsp url redacted on read API')

    // -- readings round-trip through a registered robot
    await integration(stack.base, KEY, 'POST', '/robots', { serial: 'READ-01', model: 'GS Patrol F2', level: 'state-only' })
    const up = await integration(stack.base, KEY, 'POST', '/robots/READ-01/readings', {
      readings: [{ metric: 'batt.v', value: 52.1 }],
    })
    assert.equal(up.body.accepted, 1)
    const down = await integration(stack.base, KEY, 'GET', '/robots/READ-01/readings?metric=batt.v&limit=10')
    assert.equal(down.status, 200)
    assert.ok(down.body.readings.some((r: any) => r.metric === 'batt.v' && r.value === 52.1))
    // unknown robot → 404
    const ghost = await integration(stack.base, KEY, 'GET', '/robots/GHOST-9/readings')
    assert.equal(ghost.status, 404)

    // -- fixed camera CRUD (admin console routes)
    const created = await api(stack, 'POST', `/api/sites/${SITE}/cameras`, {
      name: 'CRUD cam', rtsp: 'rtsp://u:p@10.0.0.5:554/ch1', place: 'gate',
    })
    assert.equal(created.status, 200)
    const camId = created.body.camera.id as string
    assert.equal(created.body.camera.rtsp, undefined, 'create response carries no plaintext url')
    // bad source rejected
    const bad = await api(stack, 'PATCH', `/api/sites/${SITE}/cameras/${camId}`, { rtsp: 'http://nope' })
    assert.equal(bad.status, 400)
    // rename + clear source
    const patched = await api(stack, 'PATCH', `/api/sites/${SITE}/cameras/${camId}`, { name: 'CRUD cam 2', rtsp: '' })
    assert.equal(patched.status, 200)
    const fl = await api(stack, 'GET', `/api/sites/${SITE}/fleet`)
    const cam = fl.body.cameras.find((c: any) => c.id === camId)
    assert.equal(cam.name, 'CRUD cam 2')
    assert.equal(cam.rtsp, undefined)
    // delete → gone from fleet and channels
    const del = await api(stack, 'DELETE', `/api/sites/${SITE}/cameras/${camId}`)
    assert.equal(del.status, 200)
    const fl2 = await api(stack, 'GET', `/api/sites/${SITE}/fleet`)
    assert.ok(!fl2.body.cameras.some((c: any) => c.id === camId))
    const ch2 = await integration(stack.base, KEY, 'GET', '/channels')
    assert.ok(!ch2.body.channels.some((c: any) => c.id === `cam:${camId}`))
  } finally {
    stack.stop()
  }
})
