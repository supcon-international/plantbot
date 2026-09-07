import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  truncateSync,
  existsSync,
  readdirSync,
  readFileSync,
  chmodSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawnProc, waitFor, api } from './harness.js'

test('recordings: real FFmpeg archive, range playback, RBAC, isolation and restart', { timeout: 70_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-recordings-'))
  const base = 'http://127.0.0.1:8991'
  const env = {
    API_PORT: '8991',
    PB_DATA_DIR: data,
    PB_DEMO: '1',
    PB_RECORDING_SEGMENT_SEC: '2',
    PB_RECORDING_MAX_MB: '32',
    SESSION_SECRET: 'recording-test-only',
    PUBLIC_BASE: '/robots',
  }
  let proc = spawnProc('server/src/index.ts', env, 'recordings')
  const halt = async () => {
    if (proc.exitCode === null) {
      const closed = once(proc, 'close')
      proc.kill('SIGTERM')
      await closed
    }
  }
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 15_000, 'recorder API')
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'plantbot' }),
    })
    const stack = { base, cookie: login.headers.get('set-cookie')!.split(';')[0] }
    const channels = (await api(stack, 'GET', '/api/sites/plant-07/channels')).body.channels
    const channel = channels.find((c: any) => c.source.kind === 'file')
    assert.ok(channel, 'seed footage exists')
    const path = `/api/sites/plant-07/recording-policies/${encodeURIComponent(channel.id)}`
    assert.equal((await api({ base, cookie: '' }, 'PUT', path, { enabled: true, retentionDays: 7 })).status, 401)
    assert.equal((await api(stack, 'PUT', path, { enabled: true, retentionDays: 0 })).status, 400)
    assert.equal((await api(stack, 'PUT', path, { enabled: true, retentionDays: 7 })).status, 200)
    const clip = await waitFor(
      async () => (await api(stack, 'GET', '/api/sites/plant-07/recordings')).body.recordings[0],
      25_000,
      'completed MP4 segment',
      500,
    )
    assert.ok(clip.endedAt > clip.startedAt && clip.bytes > 1000)
    assert.ok(clip.url.startsWith('/robots/api/sites/plant-07/recordings/'), 'public prefix')
    const videoPath = clip.url.replace(/^\/robots/, '')
    const partial = await fetch(`${base}${videoPath}`, { headers: { range: 'bytes=0-99' } })
    assert.equal(partial.status, 206)
    assert.equal((await partial.arrayBuffer()).byteLength, 100)
    assert.match(partial.headers.get('content-range')!, /^bytes 0-99\//)
    assert.equal((await fetch(`${base}${videoPath}`, { headers: { range: 'bytes=999999999999-' } })).status, 416)
    assert.equal((await fetch(`${base}${videoPath.replace('plant-07', 'plant-12')}`)).status, 404)
    const download = await fetch(`${base}${videoPath}?download=1`)
    assert.match(download.headers.get('content-disposition')!, /attachment/)
    assert.ok((await download.arrayBuffer()).byteLength > 1000)
    assert.equal((await api(stack, 'GET', '/api/sites/plant-07/recordings?since=abc')).status, 400)
    assert.equal((await api(stack, 'GET', '/api/sites/plant-07/recordings?since=100&until=1')).status, 400)
    assert.equal((await api(stack, 'GET', '/api/sites/plant-07/recordings?channelId=missing')).body.total, 0)
    assert.equal((await api({ base, cookie: '' }, 'DELETE', `/api/sites/plant-07/recordings/${clip.id}`)).status, 401)
    await api(stack, 'PUT', path, { enabled: false, retentionDays: 7 })
    await halt()
    // Seed finalized retained and expired clips while the platform is stopped.
    const archiveDb = new DatabaseSync(join(data, 'plantbot.db'))
    const fixture = (id: string, daysAgo: number, bytes: number) => {
      const file = join(data, 'recordings', `${id}.mp4`)
      writeFileSync(file, 'x')
      truncateSync(file, bytes)
      const at = Date.now() - daysAgo * 86400_000
      archiveDb
        .prepare('INSERT INTO recordings VALUES (?,?,?,?,?,?,?)')
        .run(id, 'plant-07', channel.id, 'retention fixture', at, at + 1000, bytes)
    }
    fixture('expired-fixture', 40, 100)
    fixture('budget-old-fixture', 2, 20 * 1024 * 1024)
    fixture('budget-new-fixture', 1, 20 * 1024 * 1024)
    archiveDb.close()
    proc = spawnProc('server/src/index.ts', { ...env, PB_PUBLIC_VIEW: '0' }, 'recordings-restart')
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 15_000, 'restarted recorder API')
    const restored = await api(stack, 'GET', '/api/sites/plant-07/recordings')
    assert.ok(
      restored.body.recordings.some((c: any) => c.id === clip.id),
      'archive persisted',
    )
    assert.ok(
      restored.body.recordings.some((c: any) => c.id === 'budget-new-fixture'),
      'newer retained segment survives budget sweep',
    )
    assert.ok(!existsSync(join(data, 'recordings', 'expired-fixture.mp4')), 'expired file removed on boot')
    assert.ok(
      !existsSync(join(data, 'recordings', 'budget-old-fixture.mp4')),
      'oldest file removed to enforce shared budget',
    )
    assert.ok(restored.body.recordings.reduce((sum: number, c: any) => sum + c.bytes, 0) <= 32 * 1024 * 1024)
    assert.equal((await fetch(`${base}${videoPath}`)).status, 401, 'private deployment protects MP4 routes')
    assert.equal((await fetch(`${base}${videoPath}`, { headers: { cookie: stack.cookie } })).status, 200)
    assert.equal((await api(stack, 'GET', '/api/sites/plant-07/recording-policies')).body.policies[0].enabled, false)
    chmodSync(join(data, 'recordings'), 0o555)
    try {
      assert.equal(
        (await api(stack, 'DELETE', `/api/sites/plant-07/recordings/${clip.id}`)).status,
        500,
        'failed unlink is not reported as deleted',
      )
      assert.equal(
        (await fetch(`${base}${videoPath}`, { headers: { cookie: stack.cookie } })).status,
        200,
        'failed deletion preserves the durable archive row',
      )
    } finally {
      chmodSync(join(data, 'recordings'), 0o755)
    }
    assert.equal((await api(stack, 'DELETE', `/api/sites/plant-07/recordings/${clip.id}`)).status, 200)
    assert.equal((await fetch(`${base}${videoPath}`, { headers: { cookie: stack.cookie } })).status, 404)
  } finally {
    await halt()
    rmSync(data, { recursive: true, force: true })
  }
})

test(
  'recordings: unfinished segments count toward budget and removed channels release recording capacity',
  { timeout: 30_000 },
  async () => {
    const data = mkdtempSync(join(tmpdir(), 'pb-recorder-budget-'))
    const base = 'http://127.0.0.1:8995'
    // A source with no next keyframe may keep a segment open indefinitely. This
    // recorder fixture writes an oversized unfinished MP4 and no manifest.
    const recorder = join(data, 'unfinished-recorder.cjs')
    writeFileSync(
      recorder,
      `#!/usr/bin/env node
const fs=require('node:fs');
const file=process.argv.at(-1).replace('%06d','000000');
fs.writeFileSync(file,'unfinished');fs.truncateSync(file,40*1024*1024);
fs.writeFileSync(${JSON.stringify(join(data, 'recorder.pid'))},String(process.pid));
setInterval(()=>{},1000);
`,
    )
    chmodSync(recorder, 0o755)
    const proc = spawnProc(
      'server/src/index.ts',
      {
        API_PORT: '8995',
        PB_DATA_DIR: data,
        PB_DEMO: '1',
        PB_RECORDING_MAX_MB: '32',
        FFMPEG_BIN: recorder,
        SESSION_SECRET: 'budget-test',
      },
      'recorder-budget',
    )
    try {
      await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 15_000, 'budget recorder API')
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'plantbot' }),
      })
      const stack = { base, cookie: login.headers.get('set-cookie')!.split(';')[0] }
      const channel = (await api(stack, 'GET', '/api/sites/plant-07/channels')).body.channels.find(
        (c: any) => c.source.kind === 'file' && c.id.startsWith('cam:'),
      )
      assert.ok(channel)
      const path = `/api/sites/plant-07/recording-policies/${encodeURIComponent(channel.id)}`
      assert.equal((await api(stack, 'PUT', path, { enabled: true, retentionDays: 7 })).status, 200)
      const policy = await waitFor(
        async () => {
          const rows = (await api(stack, 'GET', '/api/sites/plant-07/recording-policies')).body.policies
          return rows.find((p: any) => p.error?.includes('Storage budget'))
        },
        10_000,
        'unfinished-file budget stop',
        100,
      )
      assert.equal(policy.recording, false)
      await waitFor(
        async () => readdirSync(join(data, 'recordings')).every((f) => !f.endsWith('.mp4')),
        5000,
        'unfinished file cleanup',
        100,
      )
      assert.equal(
        (await api(stack, 'GET', '/api/sites/plant-07/recordings')).body.total,
        0,
        'unfinished MP4 is never advertised',
      )
      const pid = Number(readFileSync(join(data, 'recorder.pid'), 'utf8'))
      assert.throws(() => process.kill(pid, 0), 'recorder child was reaped')
      assert.equal((await api(stack, 'DELETE', `/api/sites/plant-07/cameras/${channel.id.slice(4)}`)).status, 200)
      await waitFor(
        async () =>
          (await api(stack, 'GET', '/api/sites/plant-07/recording-policies')).body.policies.find(
            (p: any) => p.channelId === channel.id && !p.enabled,
          ),
        5000,
        'deleted-channel policy disabled',
        100,
      )
      assert.equal(
        (await api(stack, 'PUT', path, { enabled: false, retentionDays: 7 })).status,
        200,
        'existing policy can be disabled after its channel is removed',
      )
      assert.equal(
        (await api(stack, 'PUT', path, { enabled: true, retentionDays: 7 })).status,
        404,
        'removed channel cannot be re-enabled',
      )
    } finally {
      if (proc.exitCode === null) {
        const closed = once(proc, 'close')
        proc.kill('SIGTERM')
        await closed
      }
      rmSync(data, { recursive: true, force: true })
    }
  },
)
