import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawnProc, waitFor, api } from './harness.js'

test(
  'vision: eleven presets, leases, config versions, RBAC, evidence, deduplication and restart',
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-vision-')),
      base = 'http://127.0.0.1:8986',
      env = {
        API_PORT: '8986',
        PB_DATA_DIR: dir,
        PB_DEMO: '1',
        PB_DEV_KEYS: '1',
        SESSION_SECRET: 'vision-test',
        PUBLIC_BASE: '/robots',
      }
    let proc = spawnProc('server/src/index.ts', env, 'vision')
    const stop = async () => {
      if (proc.exitCode === null) {
        const exit = once(proc, 'exit')
        proc.kill('SIGTERM')
        await exit
      }
    }
    const ready = () => waitFor(async () => (await fetch(base + '/api/sites')).ok, 15000, 'platform')
    const login = async (username: string) => {
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'plantbot' }),
      })
      return { base, cookie: r.headers.get('set-cookie')!.split(';')[0] }
    }
    const route = '/api/sites/plant-07/vision'
    const hb = {
      adapterId: 'edge-one',
      runtimeId: 'runtime-one',
      name: 'Edge One',
      sources: [
        { id: 'gate', label: 'Gate', view: 'fixed', status: 'ready' },
        { id: 'robot', label: 'Robot', view: 'mobile', status: 'paused' },
      ],
      models: { detector: 'test-fixture', ocr: 'test-fixture' },
    }
    let token = ''
    const send = async (path: string, body: any, key = 'pbk_dev_plant07') => {
      const r = await fetch(base + '/api/integration/v1/vision' + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'x-vision-token': token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as any }
    }
    try {
      await ready()
      const admin = await login('admin'),
        viewer = await login('viewer'),
        operator = await login('operator')
      const heartbeat = await send('/heartbeat', hb)
      assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body))
      token = heartbeat.body.token
      assert.equal((await send('/heartbeat', { ...hb, runtimeId: 'collision' })).status, 409)
      const config = {
        name: 'Gate intrusion',
        preset: 'intrusion',
        adapterId: hb.adapterId,
        sourceId: 'gate',
        enabled: true,
        durationS: 0,
      }
      assert.equal((await api(viewer, 'POST', route + '/configs', config)).status, 403)
      assert.equal((await api(operator, 'POST', route + '/configs', config)).status, 403)
      assert.equal(
        (
          await api(admin, 'POST', route + '/configs', {
            ...config,
            sourceId: 'robot',
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await api(admin, 'POST', route + '/configs', {
            ...config,
            region: [
              [0, 0],
              [0.1, 0.1],
              [0.2, 0.2],
            ],
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await api(admin, 'POST', route + '/configs', {
            ...config,
            schedule: { days: [9], start: '00:00', end: '23:00' },
          })
        ).status,
        400,
      )
      const created = await api(admin, 'POST', route + '/configs', config)
      assert.equal(created.status, 201)
      let c = created.body
      const catalog = (await api(admin, 'GET', route)).body.presets
      assert.equal(catalog.length, 11)
      for (const p of catalog) {
        const r = await api(admin, 'POST', route + '/configs', {
          ...config,
          name: p.en,
          preset: p.id,
          enabled: false,
        })
        assert.equal(r.status, 201)
      }
      const result = {
        id: randomUUID(),
        adapterId: hb.adapterId,
        configId: c.id,
        revision: c.revision,
        capturedAt: Date.now(),
        status: 'alert',
        value: 1,
        note: 'person entered',
        model: 'explicit-simulation-fixture',
        observationId: 'observation-one',
        image: readFileSync(new URL('../vision/tests/fixtures/evidence.jpg', import.meta.url)).toString(
          'base64',
        ),
        annotations: [{ label: 'person', score: 0.9, box: [0.1, 0.1, 0.3, 0.9] }],
      }
      const accepted = await send('/results', result)
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
      assert.ok(accepted.body.eventId)
      assert.equal((await send('/results', result)).body.duplicate, true)
      const again = await send('/results', {
        ...result,
        id: randomUUID(),
        capturedAt: Date.now() + 1,
      })
      assert.equal(again.body.eventId, accepted.body.eventId)
      const crossSite = await send('/results', { ...result, id: randomUUID() }, 'pbk_dev_plant12')
      assert.equal(crossSite.status, 409)
      const snapshot = (await api(viewer, 'GET', route)).body
      assert.equal(snapshot.results.length, 2)
      assert.equal(
        snapshot.results[0].evidence,
        `/robots/api/sites/plant-07/vision/evidence/${snapshot.results[0].id}`,
      )
      const photo = await fetch(base + route + '/evidence/' + result.id, {
        headers: { cookie: viewer.cookie },
      })
      assert.equal(photo.status, 200)
      assert.equal(photo.headers.get('content-type'), 'image/jpeg')
      assert.equal((await api(admin, 'GET', '/api/sites/plant-12/vision/evidence/' + result.id)).status, 404)
      const trial = await api(operator, 'POST', route + '/test', config)
      assert.equal(trial.status, 201)
      const tested = await send('/results', {
        ...result,
        id: randomUUID(),
        jobId: trial.body.id,
        revision: 1,
      })
      assert.equal(tested.status, 200)
      assert.equal(tested.body.eventId, '')
      const late = await send('/results', {
        ...result,
        id: randomUUID(),
        capturedAt: Date.now() - 120000,
      })
      assert.equal(late.body.eventId, '')
      const edit = await api(admin, 'PUT', route + '/configs/' + c.id, {
        ...c,
        enabled: false,
      })
      assert.equal(edit.status, 200)
      c = edit.body
      assert.equal(
        (
          await api(admin, 'PUT', route + '/configs/' + c.id, {
            ...c,
            revision: 1,
          })
        ).status,
        409,
      )
      assert.equal((await send('/results', { ...result, id: randomUUID() })).status, 409)
      await stop()
      // Simulate evidence at its storage budget and colliding external IDs in two sites.
      // Trimming one site's image must never overwrite the other site's record.
      const database = new DatabaseSync(join(dir, 'plantbot.db'))
      const trimId = randomUUID()
      const insert = database.prepare('INSERT INTO vision_results(site_id,id,data,ts) VALUES(?,?,?,?)')
      for (const [site, size, offset] of [
        ['plant-07', 1025 * 1024 * 1024, -3600000],
        ['plant-12', 1, 0],
      ] as const) {
        insert.run(
          site,
          trimId,
          JSON.stringify({
            id: trimId,
            config: { ...c, name: site },
            file: trimId + '.jpg',
            fileSize: size,
            evidence: '/' + site,
          }),
          Date.now() + offset,
        )
      }
      database.close()
      proc = spawnProc('server/src/index.ts', env, 'vision-restart')
      await ready()
      const restored = (await api(admin, 'GET', route)).body
      assert.equal(restored.configs.length, 12)
      assert.equal(restored.adapters[0].online, false)
      assert.equal(restored.results.length, 5)
      assert.equal(restored.results.find((r: any) => r.id === trimId).evidenceExpired, true)
      const otherSite = (await api(admin, 'GET', '/api/sites/plant-12/vision')).body
      assert.equal(otherSite.results[0].config.name, 'plant-12')
      assert.equal(otherSite.results[0].evidence, '/plant-12')
      assert.equal((await send('/results', { ...result, id: randomUUID() })).status, 409)
      const newHeartbeat = await send('/heartbeat', hb)
      assert.equal(newHeartbeat.status, 200)
      assert.notEqual(newHeartbeat.body.token, token)
      assert.equal((await api(admin, 'DELETE', route + '/configs/' + c.id)).status, 200)
      assert.equal(
        (
          await fetch(base + route + '/evidence/' + result.id, {
            headers: { cookie: viewer.cookie },
          })
        ).status,
        200,
      )
    } finally {
      await stop()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
