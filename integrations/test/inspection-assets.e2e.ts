import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { spawnProc, waitFor, api, integration } from './harness.js'

test(
  'equipment, tag bindings and defects: lifecycle, validation, RBAC, isolation, export and restart',
  { timeout: 90_000 },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pb-assets-'))
    const base = 'http://127.0.0.1:8983'
    const env = {
      API_PORT: '8983',
      PB_DATA_DIR: dataDir,
      PB_DEV_KEYS: '1',
      PB_DEMO: '1',
      SESSION_SECRET: 'inspection-assets-test-secret',
    }
    let proc = spawnProc('server/src/index.ts', env, 'assets-test')
    const stop = async () => {
      if (proc.exitCode === null) {
        const ended = once(proc, 'exit')
        proc.kill('SIGTERM')
        await ended
      }
    }
    const cookieFor = async (username: string, password = 'plantbot') => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      assert.equal(response.status, 200)
      return response.headers.get('set-cookie')!.split(';')[0]
    }
    try {
      await waitFor(async () => (await fetch(`${base}/api/sites`)).ok, 20_000, 'assets platform up')
      const admin = { base, cookie: await cookieFor('admin') },
        operator = { base, cookie: await cookieFor('operator') },
        viewer = { base, cookie: await cookieFor('viewer') }
      const S = '/api/sites/plant-07',
        B = '/api/sites/plant-12'
      const fleet = await api(admin, 'GET', `${S}/fleet`),
        point = fleet.body.waypoints[0].id
      const input = {
        name: '=Transformer 01',
        kind: 'transformer',
        location: 'North yard',
        waypointId: point,
        notes: 'Inspection record',
      }
      assert.equal((await api({ base, cookie: '' }, 'POST', `${S}/assets`, input)).status, 401)
      assert.equal((await api(viewer, 'POST', `${S}/assets`, input)).status, 403)
      assert.equal((await api(operator, 'POST', `${S}/assets`, input)).status, 403)
      assert.equal((await api(admin, 'POST', `${S}/assets`, { ...input, name: '' })).status, 400)
      assert.equal((await api(admin, 'POST', `${S}/assets`, { ...input, waypointId: 'wrong-site-point' })).status, 400)
      assert.equal((await api(admin, 'POST', `${S}/assets`, { ...input, injected: true })).status, 400)
      const asset = await api(admin, 'POST', `${S}/assets`, input)
      assert.equal(asset.status, 201, JSON.stringify(asset.body))
      const assetId = asset.body.id
      assert.equal((await api(viewer, 'GET', `${S}/assets`)).body.items.length, 1)
      assert.equal((await api(admin, 'GET', `${B}/assets`)).body.items.length, 0)
      assert.equal((await api(admin, 'PATCH', `${B}/assets/${assetId}`, { name: 'cross-site' })).status, 404)
      const tagInput = {
        assetId,
        name: 'TT-101',
        waypointId: point,
        dataType: 'number',
        unit: '°C',
        address: 'plant/transformer/temperature',
        source: 'manual',
      }
      assert.equal((await api(admin, 'POST', `${B}/asset-tags`, tagInput)).status, 400)
      assert.equal(
        (
          await api(admin, 'POST', `${S}/asset-tags`, {
            ...tagInput,
            source: 'adapter',
            robotId: 'unknown',
            metric: 'dt.max.c',
          })
        ).status,
        400,
      )
      const tag = await api(admin, 'POST', `${S}/asset-tags`, tagInput)
      assert.equal(tag.status, 201, JSON.stringify(tag.body))
      const tagId = tag.body.id
      assert.equal((await api(admin, 'POST', `${S}/asset-tags`, { ...tagInput, name: 'tt-101' })).status, 409)
      assert.equal((await api(admin, 'DELETE', `${S}/assets/${assetId}`)).status, 409)
      assert.equal((await api(admin, 'PATCH', `${S}/asset-tags/${tagId}`, { dataType: 'object' })).status, 400)
      const raised = await integration(base, 'pbk_dev_plant07', 'POST', '/events', {
        type: 'thermal',
        detail: 'Transformer temperature high',
        severity: 'high',
        x: 1,
        z: 2,
      })
      assert.equal(raised.status, 200)
      const evs = await integration(base, 'pbk_dev_plant07', 'GET', '/events?limit=100')
      const eventId = evs.body.events.find((e: any) => e.detail === 'Transformer temperature high').id
      const defectInput = {
        title: 'Transformer overheating',
        description: 'Check cooling fan',
        tagId,
        eventId,
        severity: 'major',
        category: 'electrical',
        assignedTo: 'operator',
      }
      assert.equal((await api(viewer, 'POST', `${S}/defects`, defectInput)).status, 403)
      assert.equal((await api(operator, 'POST', `${S}/defects`, { ...defectInput, submittedBy: 'forged' })).status, 400)
      assert.equal((await api(operator, 'POST', `${S}/defects`, { ...defectInput, assignedTo: 'viewer' })).status, 400)
      assert.equal(
        (await api(operator, 'POST', `${S}/defects`, { ...defectInput, eventId: 'nonexistent' })).status,
        400,
      )
      const defect = await api(operator, 'POST', `${S}/defects`, defectInput)
      assert.equal(defect.status, 201, JSON.stringify(defect.body))
      const id = defect.body.id
      assert.equal(defect.body.submittedBy, 'operator')
      assert.equal(defect.body.assetId, assetId)
      assert.equal(defect.body.history.length, 1)
      assert.equal((await api(operator, 'PATCH', `${B}/defects/${id}`, { title: 'cross-site' })).status, 404)
      assert.equal((await api(admin, 'DELETE', `${S}/asset-tags/${tagId}`)).status, 409)
      const edited = await api(operator, 'PATCH', `${S}/defects/${id}`, { assignedTo: 'admin' })
      assert.equal(edited.status, 200)
      assert.equal(edited.body.history.at(-1).changes.assignedTo.from, 'operator')
      assert.equal(
        (await api(operator, 'POST', `${S}/defects/${id}/updates`, { status: 'in_progress', note: '' })).status,
        400,
      )
      const working = await api(operator, 'POST', `${S}/defects/${id}/updates`, {
        status: 'in_progress',
        note: 'Cooling fan under inspection',
      })
      assert.equal(working.body.status, 'in_progress')
      const closed = await api(operator, 'POST', `${S}/defects/${id}/updates`, {
        status: 'closed',
        note: 'Fan replaced; temperature normal',
      })
      assert.equal(closed.body.status, 'closed')
      assert.equal(closed.body.resolution, 'Fan replaced; temperature normal')
      assert.equal((await api(operator, 'PATCH', `${S}/defects/${id}`, { title: 'silent edit' })).status, 409)
      const comment = await api(operator, 'POST', `${S}/defects/${id}/updates`, { note: 'Supervisor checked' })
      assert.equal(comment.body.resolution, 'Fan replaced; temperature normal')
      assert.equal((await api(viewer, 'POST', `${S}/defects/${id}/updates`, { note: 'forged review' })).status, 403)
      assert.equal(
        (
          await api(
            admin,
            'GET',
            `${S}/defects?status=closed&severity=major&category=electrical&assetId=${assetId}&q=Transformer`,
          )
        ).body.items.length,
        1,
      )
      assert.equal((await api(admin, 'GET', `${S}/defects?status=open`)).body.items.length, 0)
      assert.equal((await api(admin, 'GET', `${S}/defects?status=bad`)).status, 400)
      assert.equal((await api(admin, 'GET', `${S}/defects?q=one&q=two`)).status, 400)
      assert.equal((await api(viewer, 'GET', `${S}/defects/export`)).status, 403)
      const exported = await fetch(`${base}${S}/defects/export?status=closed`, { headers: { cookie: operator.cookie } })
      assert.equal(exported.status, 200)
      const csv = await exported.text()
      assert.ok(csv.includes('Fan replaced'))
      assert.ok(csv.includes('Supervisor checked'))
      const assetCsv = await (await fetch(`${base}${S}/assets/export`, { headers: { cookie: operator.cookie } })).text()
      assert.ok(assetCsv.includes("'=Transformer 01"), 'CSV formula prefixes are neutralized')
      const reopened = await api(operator, 'POST', `${S}/defects/${id}/updates`, {
        status: 'open',
        note: 'Repeat observation requested',
      })
      assert.equal(reopened.body.status, 'open')
      assert.equal(reopened.body.resolution, '')
      const unassigned = await api(operator, 'POST', `${S}/defects`, { title: 'Minor leak', category: 'equipment' })
      assert.equal(
        (await api(operator, 'POST', `${S}/defects/${unassigned.body.id}/updates`, { status: 'closed', note: 'Done' }))
          .status,
        400,
      )
      await api(admin, 'POST', '/api/users', {
        username: 'site-only',
        password: 'test-password',
        roles: { 'plant-12': 'operator' },
      })
      const siteOnly = { base, cookie: await cookieFor('site-only', 'test-password') }
      assert.equal(
        (await api(siteOnly, 'POST', `${S}/defects`, { title: 'not allowed', category: 'equipment' })).status,
        403,
      )
      assert.equal(
        (await api(admin, 'GET', `${S}/defect-assignees`)).body.items.some((u: any) => u.username === 'site-only'),
        false,
      )
      const transient = await api(admin, 'POST', `${S}/assets`, { name: 'Temporary', kind: 'pump' })
      const transientTag = await api(admin, 'POST', `${S}/asset-tags`, {
        ...tagInput,
        assetId: transient.body.id,
        name: 'TT-TMP',
      })
      assert.equal((await api(admin, 'DELETE', `${S}/asset-tags/${transientTag.body.id}`)).status, 200)
      assert.equal((await api(admin, 'DELETE', `${S}/assets/${transient.body.id}`)).status, 200)
      await stop()
      const inspectionDb = new DatabaseSync(join(dataDir, 'plantbot.db'))
      inspectionDb
        .prepare('UPDATE events SET ts=? WHERE site_id=? AND id=?')
        .run(Date.now() - 91 * 86_400_000, 'plant-07', eventId)
      inspectionDb.close()
      proc = spawnProc('server/src/index.ts', env, 'assets-restart')
      await waitFor(async () => (await fetch(`${base}/api/sites`)).ok, 20_000, 'assets restart up')
      const restored = await api(admin, 'GET', `${S}/defects/${id}`)
      assert.equal(restored.status, 200)
      assert.equal(restored.body.history.length, reopened.body.history.length)
      assert.equal(restored.body.assignedTo, 'admin')
      assert.equal(restored.body.status, 'open')
      assert.equal(
        (await api(operator, 'PATCH', `${S}/defects/${id}`, { title: 'Retained defect after source event expiry' }))
          .status,
        200,
      )
      assert.equal((await api(admin, 'GET', `${S}/assets`)).body.items[0].name, '=Transformer 01')
      assert.equal((await api(admin, 'GET', `${S}/asset-tags`)).body.items[0].name, 'TT-101')
      assert.equal((await api(admin, 'GET', '/api/sites/not-loaded/assets')).status, 404)
    } finally {
      await stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
)
