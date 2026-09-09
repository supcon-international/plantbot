import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnProc, waitFor, api, integration } from './harness.js'

async function freePort() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening')
  const port = (s.address() as { port: number }).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

test('monitoring: real thresholds, immutable provenance, lifecycle, legacy upgrade and retention', { timeout: 65_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-monitoring-')), port = await freePort(), base = `http://127.0.0.1:${port}`
  const env = { API_PORT: String(port), PB_DATA_DIR: dir, PB_DEMO: '1', PB_DEV_KEYS: '1', SESSION_SECRET: 'monitoring-test', PUBLIC_BASE: '/robots' }
  let proc = spawnProc('server/src/index.ts', env, 'monitoring-seed')
  const stop = async () => { if (proc.exitCode === null) { const exit = once(proc, 'exit'); proc.kill('SIGTERM'); await exit } }
  const ready = () => waitFor(async () => (await fetch(`${base}/api/health`)).ok, 15_000, 'monitoring platform')
  const login = async (username: string) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'plantbot' }) })
    assert.equal(r.status, 200); return { base, cookie: r.headers.get('set-cookie')!.split(';')[0] }
  }
  const site = '/api/sites/plant-07', vision = `${site}/vision`, key = 'pbk_dev_plant07'
  let token = ''
  const send = async (path: string, body: any) => {
    const r = await fetch(`${base}/api/integration/v1/vision${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-vision-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() as any }
  }
  const hb = { adapterId: 'monitor-edge', runtimeId: 'monitor-runtime', sources: [
    { id: 'gate', label: 'Gate camera', channelId: 'perimeter-cam', view: 'fixed', status: 'ready' },
    { id: 'unmapped', label: 'Standalone camera', view: 'fixed', status: 'ready' },
  ], models: { detector: 'explicit-integration-fixture' }, capabilities: { presets: ['intrusion', 'ocr'] } }
  try {
    await ready(); await stop() // seed geometry only, before the 6-second synthetic seed timer
    proc = spawnProc('server/src/index.ts', { ...env, PB_DEMO: '0' }, 'monitoring-production'); await ready()
    const admin = await login('admin'), operator = await login('operator'), viewer = await login('viewer')
    const snapshots = join(dir, 'snapshots')
    assert.ok(existsSync(snapshots), 'snapshot storage follows the isolated PB_DATA_DIR')
    const snapshot = readFileSync(new URL('../vision/tests/fixtures/evidence.jpg', import.meta.url))
    writeFileSync(join(snapshots, 'monitoring-isolation.jpg'), snapshot)
    const snapshotResponse = await fetch(`${base}/api/snapshots/monitoring-isolation.jpg`, { headers: { cookie: viewer.cookie } })
    assert.equal(snapshotResponse.status, 200, 'snapshot serving reads the isolated storage directory')
    assert.deepEqual(Buffer.from(await snapshotResponse.arrayBuffer()), snapshot)
    const event = async (id: string) => (await api(viewer, 'GET', `${site}/events/${id}`)).body.event
    const eventList = async () => (await api(viewer, 'GET', `${site}/events?limit=500`)).body.events as any[]
    const index = async () => (await api(viewer, 'GET', `${site}/monitoring-rules`)).body
    const first = await index()
    assert.equal(first.metrics.find((m: any) => m.id === 'ch4.ppm').eventType, 'threshold-ch4-ppm')
    assert.ok(first.rules.filter((r: any) => ['cloud-cv', 'onboard-cv'].includes(r.config.kind)).every((r: any) => r.legacy && r.runtime.status !== 'active'))
    for (const kind of [undefined, 'sim', 'onboard-cv', 'cloud-cv']) assert.equal((await api(admin, 'POST', `${site}/rules`, { name: 'Pretend CV', source: 'gate', model: 'person', kind })).status, 400)
    const registered = await integration(base, key, 'POST', '/robots', { serial: 'METRIC-ONE', model: 'External meter', callsign: 'Meter one', level: 'state-only', streams: [] })
    assert.equal(registered.status, 200)
    const threshold = { name: 'Methane alarm original', kind: 'threshold', robotId: registered.body.robot.id, metric: 'ch4.ppm', op: '>', bound: 10, severity: 'high', enabled: true }
    for (const user of [viewer, operator]) assert.equal((await api(user, 'POST', `${site}/rules`, threshold)).status, 403)
    for (const patch of [{ robotId: 'unknown' }, { metric: 'invented' }, { bound: '10' }]) assert.equal((await api(admin, 'POST', `${site}/rules`, { ...threshold, ...patch })).status, 400)
    const created = await api(admin, 'POST', `${site}/rules`, threshold)
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const rule = created.body.rule
    assert.equal(rule.model, 'threshold-ch4-ppm'); assert.equal(rule.revision, 1)
    assert.equal((await index()).rules.find((r: any) => r.id === rule.id).runtime.status, 'idle', 'enabled with no sample is not active')
    for (const patch of [{ kind: 'sim' }, { enabled: 'yes' }]) assert.equal((await api(admin, 'PATCH', `${site}/rules/${rule.id}`, patch)).status, 400)
    const readings = (value: number, quality = 'ok', ts = Date.now()) => integration(base, key, 'POST', '/robots/METRIC-ONE/readings', { readings: [{ metric: 'ch4.ppm', value, quality, ts, payloadId: 'gas-sensor' }] })
    const thresholdEvents = async () => (await eventList()).filter((e: any) => e.ruleId === rule.id)
    await readings(20, 'ok', Date.now() - 120_000); await delay(3300)
    assert.equal((await thresholdEvents()).length, 0, 'late readings cannot raise a current alarm')
    await readings(20, 'degraded'); await delay(3300)
    assert.equal((await thresholdEvents()).length, 0, 'degraded readings cannot raise a current alarm')
    const capturedAt = Date.now(); await readings(21.5, 'ok', capturedAt)
    const thresholdEvent = await waitFor(async () => (await thresholdEvents())[0], 6000, 'real threshold alarm', 150)
    assert.equal(thresholdEvent.confidence, null); assert.equal(thresholdEvent.x, null); assert.equal(thresholdEvent.z, null)
    assert.equal(thresholdEvent.snapshot, undefined)
    assert.deepEqual(thresholdEvent.evidence, [{ kind: 'reading', reading: { metric: 'ch4.ppm', value: 21.5, unit: 'ppm' } }])
    assert.equal(thresholdEvent.trigger.value, 21.5); assert.equal(thresholdEvent.trigger.capturedAt, capturedAt)
    assert.equal(thresholdEvent.trigger.condition, 'ch4.ppm > 10')
    assert.equal((await api(admin, 'PATCH', `${site}/rules/${rule.id}`, { name: 'Renamed methane', bound: 40, enabled: false })).body.rule.revision, 2)
    assert.equal((await event(thresholdEvent.id)).lifecycle, 'new')
    assert.equal((await event(thresholdEvent.id)).trigger.configSnapshot.name, threshold.name)
    assert.equal((await api(admin, 'DELETE', `${site}/rules/${rule.id}`)).status, 200)
    assert.equal((await event(thresholdEvent.id)).trigger.configSnapshot.bound, 10)
    const external = await integration(base, key, 'POST', '/events', { type: 'person', detail: 'External report', trigger: { ruleId: 'forged', ruleType: 'vision' } })
    assert.equal(external.body.event.confidence, null); assert.equal(external.body.event.x, null)
    assert.equal(external.body.event.trigger, undefined, 'integration input cannot forge rule provenance')

    token = (await send('/heartbeat', hb)).body.token
    const configInput = { name: 'Gate intrusion original', preset: 'intrusion', adapterId: hb.adapterId, sourceId: 'gate', enabled: true, region: [[0, 0], [1, 0], [1, 1], [0, 1]], line: [[0.5, 0], [0.5, 1]], durationS: 0, threshold: 0 }
    assert.equal((await api(admin, 'POST', `${vision}/configs`, { ...configInput, preset: 'crowding' })).status, 400)
    assert.equal((await api(operator, 'POST', `${vision}/configs`, configInput)).status, 403)
    const visualCreated = await api(admin, 'POST', `${vision}/configs`, configInput)
    assert.equal(visualCreated.status, 201, JSON.stringify(visualCreated.body))
    const config = visualCreated.body
    const unmapped = (await api(admin, 'POST', `${vision}/configs`, { ...configInput, sourceId: 'unmapped' })).body
    assert.equal((await index()).rules.find((r: any) => r.id === unmapped.id).channelId, undefined)
    assert.equal((await index()).rules.find((r: any) => r.id === config.id).channelId, 'perimeter-cam')
    assert.equal((await index()).rules.find((r: any) => r.id === config.id).runtime.status, 'idle')
    await send('/heartbeat', { ...hb, sources: hb.sources.map((s) => ({ ...s, status: 'unavailable', note: 'Capture failed' })) })
    assert.equal((await index()).rules.find((r: any) => r.id === config.id).runtime.status, 'unavailable')
    await send('/heartbeat', hb)
    const image = readFileSync(new URL('../vision/tests/fixtures/evidence.jpg', import.meta.url)).toString('base64')
    let capture = Date.now()
    const result = (status: string, extra: any = {}) => ({ id: randomUUID(), adapterId: hb.adapterId, configId: config.id, revision: config.revision, capturedAt: ++capture, status, value: 1, model: 'explicit-integration-fixture', observationId: 'gate-epoch', image, annotations: [{ label: 'person', box: [0.1, 0.1, 0.5, 0.8], score: 0.98 }], ...extra })
    const firstAlert = result('alert'), accepted = await send('/results', firstAlert)
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    const visualEvent = await event(accepted.body.eventId)
    assert.equal(visualEvent.confidence, null, 'annotation scores are not aggregate confidence'); assert.equal(visualEvent.x, null)
    for (const [field, value] of Object.entries({ resultId: firstAlert.id, observationId: 'gate-epoch', adapterId: hb.adapterId, sourceId: 'gate', channelId: 'perimeter-cam' })) assert.equal(visualEvent.trigger[field], value)
    assert.equal(visualEvent.trigger.configSnapshot.name, configInput.name)
    assert.ok(visualEvent.snapshot.startsWith('/robots/api/sites/plant-07/vision/evidence/'))
    assert.equal((await send('/results', firstAlert)).body.duplicate, true)
    assert.equal((await api(viewer, 'GET', `${vision}/results/${firstAlert.id}`)).body.confidence, null)
    assert.equal((await api(viewer, 'GET', `${vision}?configId=${config.id}&resultId=${firstAlert.id}`)).body.results.length, 1)
    assert.equal((await api(viewer, 'GET', `/api/sites/plant-12/vision/results/${firstAlert.id}`)).status, 404)
    assert.equal((await fetch(base + visualEvent.snapshot.replace('/robots', ''), { headers: { cookie: viewer.cookie } })).status, 200)
    await send('/results', result('unknown'))
    assert.equal((await send('/results', result('alert'))).body.eventId, visualEvent.id, 'unknown does not recover')
    await send('/results', result('failed')); await send('/results', result('normal', { capturedAt: Date.now() - 120_000 }))
    assert.equal((await send('/results', result('alert'))).body.eventId, visualEvent.id, 'late and failed do not recover')
    await send('/results', result('normal'))
    const nextAlert = await send('/results', result('alert', { confidence: 0.73 }))
    assert.notEqual(nextAlert.body.eventId, visualEvent.id); assert.equal((await event(nextAlert.body.eventId)).confidence, 0.73)
    assert.equal((await event(visualEvent.id)).lifecycle, 'new', 'normal never closes workflow events')
    const trial = await api(operator, 'POST', `${vision}/test`, configInput)
    assert.equal(trial.status, 201)
    assert.equal((await send('/results', result('alert', { jobId: trial.body.id, configId: undefined, revision: 1 }))).body.eventId, '')
    const disabled = await api(admin, 'PUT', `${vision}/configs/${config.id}`, { ...config, name: 'Renamed disabled gate', enabled: false })
    assert.equal(disabled.status, 200); assert.equal((await send('/results', result('alert'))).status, 409)
    assert.equal((await event(visualEvent.id)).lifecycle, 'new')
    assert.equal((await api(viewer, 'GET', `${vision}/configs/${config.id}/revisions/1`)).body.name, configInput.name)
    assert.equal((await api(viewer, 'GET', `${vision}/configs/${config.id}/revisions/2`)).body.enabled, false)
    const resumed = await api(admin, 'PUT', `${vision}/configs/${config.id}`, { ...disabled.body, enabled: true })
    assert.equal(resumed.body.revision, 3); assert.equal((await event(visualEvent.id)).lifecycle, 'new')
    assert.equal((await api(admin, 'DELETE', `${vision}/configs/${config.id}`)).status, 200)
    assert.equal((await api(viewer, 'GET', `${vision}/configs/${config.id}/revisions/1`)).body.name, configInput.name)
    assert.equal((await api(viewer, 'GET', `${vision}/results/${firstAlert.id}`)).body.config.name, configInput.name)
    await send('/heartbeat', { ...hb, sources: [], capabilities: { presets: [] } })
    assert.equal((await api(admin, 'PUT', `${vision}/configs/${unmapped.id}`, { ...unmapped, enabled: false })).status, 200, 'missing source/capability cannot prevent disabling')
    assert.equal((await api(admin, 'PUT', `${vision}/configs/${unmapped.id}`, { ...unmapped, revision: 2, enabled: true })).status, 400)
    await send('/heartbeat', hb)
    assert.equal((await api(admin, 'PUT', `${vision}/configs/${unmapped.id}`, { ...unmapped, revision: 2, enabled: true })).status, 200)
    await stop()

    // Prior release shapes: only actual frozen observations may backfill history.
    const database = new DatabaseSync(join(dir, 'plantbot.db')), oldTs = Date.now() - 8 * 86400_000
    const old = JSON.parse((database.prepare('SELECT data FROM vision_results WHERE site_id=? AND id=?').get('plant-07', firstAlert.id) as { data: string }).data)
    delete old.triggeredEvent; delete old.confidence; delete old.sourceId; delete old.channelId; old.capturedAt = oldTs
    database.prepare('UPDATE vision_results SET data=?,ts=? WHERE site_id=? AND id=?').run(JSON.stringify(old), oldTs, 'plant-07', old.id)
    const oldEvent = { ...visualEvent, ts: oldTs, confidence: 1, x: 0, z: 0, ruleId: 'EXT' }; delete oldEvent.trigger
    database.prepare('UPDATE events SET data=?,ts=? WHERE site_id=? AND id=?').run(JSON.stringify(oldEvent), oldTs, 'plant-07', oldEvent.id)
    database.prepare('DELETE FROM vision_config_revisions WHERE site_id=? AND id=?').run('plant-07', config.id)
    const ordinary = { ...old, id: 'expired-non-trigger', eventId: '', status: 'normal', file: '', fileSize: 0, evidence: '' }
    database.prepare('INSERT INTO vision_results(site_id,id,data,ts) VALUES(?,?,?,?)').run('plant-07', ordinary.id, JSON.stringify(ordinary), oldTs)
    const missingTriggerEvent = { ...oldEvent, id: 'EV-9000' }
    database.prepare('INSERT INTO events(site_id,id,ts,data) VALUES(?,?,?,?)').run('plant-07', missingTriggerEvent.id, oldTs, JSON.stringify(missingTriggerEvent))
    const continuation = { ...old, id: 'retained-continuation', capturedAt: Date.now() - 1000, eventId: missingTriggerEvent.id, file: '', fileSize: 0, evidence: '' }
    database.prepare('INSERT INTO vision_results(site_id,id,data,ts) VALUES(?,?,?,?)').run('plant-07', continuation.id, JSON.stringify(continuation), continuation.capturedAt)
    database.close()
    proc = spawnProc('server/src/index.ts', { ...env, PB_DEMO: '0' }, 'monitoring-upgrade'); await ready()
    const retained = await api(viewer, 'GET', `${vision}/results/${firstAlert.id}`)
    assert.equal(retained.status, 200); assert.equal(retained.body.evidenceExpired, true); assert.equal(retained.body.evidence, ''); assert.equal(retained.body.triggeredEvent, true)
    assert.equal((await api(viewer, 'GET', `${vision}/results/expired-non-trigger`)).status, 404)
    assert.equal((await api(viewer, 'GET', `${vision}/configs/${config.id}/revisions/1`)).body.name, configInput.name)
    const upgraded = await event(visualEvent.id)
    assert.equal(upgraded.confidence, null); assert.equal(upgraded.x, null); assert.equal(upgraded.trigger.resultId, firstAlert.id)
    assert.equal(upgraded.trigger.channelId, undefined, 'upgrade cannot infer historical channels from current settings')
    assert.equal(upgraded.trigger.configSnapshot.name, configInput.name); assert.equal(upgraded.lifecycle, 'new')
    assert.equal((await event(missingTriggerEvent.id)).trigger, undefined, 'a retained continuation cannot replace an expired trigger')
    assert.equal((await event(missingTriggerEvent.id)).confidence, null)
    assert.equal((await api(viewer, 'GET', `/api/sites/plant-12/events/${visualEvent.id}`)).status, 404)
    assert.equal((await index()).rules.find((r: any) => r.id === unmapped.id).runtime.status, 'offline')
    const afterDelete = await api(admin, 'POST', `${site}/rules`, { ...threshold, name: 'Another methane rule' })
    assert.equal(afterDelete.status, 200)
    assert.notEqual(afterDelete.body.rule.id, rule.id, 'deleted historical rule ids are not reused after restart')
    const integrationEvents = await integration(base, key, 'GET', '/events?limit=500')
    assert.equal(integrationEvents.body.events.find((e: any) => e.id === visualEvent.id).trigger.resultId, firstAlert.id)
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})
