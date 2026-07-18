// Managed-connector e2e: the platform itself spawns and supervises the vendor
// adapter. One real dr sim + one real platform; the adapter child process is
// created by the platform's supervisor from a console POST — exactly the
// deployment story the INTEG panel sells.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPlatform, spawnProc, waitFor, api, fleetRobot, simsAvailable } from './harness.js'

const PORT = 8971
const SIM_PORT = 31971
const SITE = 'plant-07'
const SERIAL = 'X30-CONN-E2E'
const ROBOT_ID = 'ext-x30-conn-e2e'

test('managed connector：建→托管进程拉起→机器人上线（rtsp 流已脱敏）→停→启→删', { skip: !simsAvailable(), timeout: 180_000 }, async () => {
  const stack = await bootPlatform(PORT)
  const sim = spawnProc('deeprobotics/sim/main.ts', { DR_SIM_PORT: String(SIM_PORT) }, 'dr-sim:conn')
  try {
    // -- create: the platform spawns the adapter as a supervised child
    const created = await api(stack, 'POST', `/api/sites/${SITE}/connectors`, {
      vendor: 'deeprobotics',
      name: 'conn e2e',
      config: {
        serial: SERIAL,
        callsign: 'X30·CONN',
        host: '127.0.0.1',
        port: SIM_PORT,
        dockX: -11,
        dockZ: -6,
        streams: [{ name: 'Front optical', url: 'rtsp://svc:secret@10.9.9.9:554/ch1' }],
      },
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.connector.id as string

    // -- the robot registers through the loopback integration API
    const robot = await waitFor(() => fleetRobot(stack, SITE, SERIAL), 40_000, 'connector robot registered')
    assert.equal(robot.callsign, 'X30·CONN')

    // -- credential hygiene: the admin fleet view may carry the rtsp URL, the
    //    anonymous surfaces must not (payloads + channels are both stripped)
    const anonFleet = await (await fetch(`${stack.base}/api/sites/${SITE}/fleet`)).json()
    const anonRobot = anonFleet.robots.find((r: any) => r.serial === SERIAL)
    assert.ok(anonRobot, 'robot visible anonymously')
    for (const p of anonRobot.payloads) assert.ok(!p.file || !String(p.file).includes('secret'), 'payload url stripped')
    const anonChannels = await (await fetch(`${stack.base}/api/sites/${SITE}/channels`)).json()
    const ch = anonChannels.channels.find((c: any) => c.id.startsWith(ROBOT_ID))
    assert.ok(ch, 'robot channel listed')
    assert.equal(ch.source.kind, 'rtsp')
    assert.equal(ch.source.url, '', 'channel rtsp url redacted')

    // -- runtime status is live
    const list1 = await api(stack, 'GET', `/api/sites/${SITE}/connectors`)
    const c1 = list1.body.connectors.find((c: any) => c.id === id)
    assert.equal(c1.runtime.status, 'running')
    assert.ok(c1.runtime.pid > 0)

    // -- logs captured from the child
    const logs = await waitFor(async () => {
      const r = await api(stack, 'GET', `/api/sites/${SITE}/connectors/${id}/logs`)
      return (r.body.lines ?? []).some((l: string) => l.includes('registered')) ? r.body.lines : null
    }, 15_000, 'adapter log captured')
    assert.ok(logs.length > 0)

    // -- stop: intent is immediate, the child goes away
    const stopped = await api(stack, 'POST', `/api/sites/${SITE}/connectors/${id}/stop`)
    assert.equal(stopped.body.connector.runtime.status, 'stopped')
    assert.equal(stopped.body.connector.enabled, false)
    // the robot record survives a stopped connector (it just goes stale)
    assert.ok(await fleetRobot(stack, SITE, SERIAL), 'robot record survives stop')

    // -- start again: process comes back, registration refreshes
    await api(stack, 'POST', `/api/sites/${SITE}/connectors/${id}/start`)
    await waitFor(async () => {
      const r = await api(stack, 'GET', `/api/sites/${SITE}/connectors`)
      const c = r.body.connectors.find((x: any) => x.id === id)
      return c.runtime.status === 'running' ? c : null
    }, 20_000, 'connector back to running')

    // -- delete: row gone, process gone
    const del = await api(stack, 'DELETE', `/api/sites/${SITE}/connectors/${id}`)
    assert.equal(del.status, 200)
    const list2 = await api(stack, 'GET', `/api/sites/${SITE}/connectors`)
    assert.equal(list2.body.connectors.length, 0)

    // -- authz: viewers can't even list connectors (credentials live in config)
    const anon = await fetch(`${stack.base}/api/sites/${SITE}/connectors`)
    assert.equal(anon.status, 401)
  } finally {
    sim.kill('SIGTERM')
    stack.stop()
  }
})
