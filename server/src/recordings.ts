// Opt-in RTSP/file archive. FFmpeg's completed-segment manifest is the source
// of truth: an open or interrupted MP4 is never advertised as a recording.
import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db, DATA_DIR } from './db.js'
import { requireRole } from './auth.js'
import type { World } from './world.js'

const DIR = join(DATA_DIR, 'recordings')
const MEDIA = resolve(dirname(fileURLToPath(import.meta.url)), '../media')
const PUB = process.env.PUBLIC_BASE ?? ''
const boundedEnv = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name] ?? fallback)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const SEGMENT = boundedEnv('PB_RECORDING_SEGMENT_SEC', 60, 2, 300)
const BUDGET = boundedEnv('PB_RECORDING_MAX_MB', 2048, 32, 1_000_000) * 1024 * 1024
const MAX_WORKERS = 8
mkdirSync(DIR, { recursive: true })
db.exec(`
  CREATE TABLE IF NOT EXISTS recording_policies (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, channel_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, retention_days INTEGER NOT NULL DEFAULT 7,
    PRIMARY KEY(site_id, channel_id));
  CREATE TABLE IF NOT EXISTS recording_sessions (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL, label TEXT NOT NULL, started_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL, label TEXT NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_recordings_time ON recordings(site_id, started_at);
`)
type Policy = { site_id: string; channel_id: string; enabled: number; retention_days: number }
type Session = { id: string; site_id: string; channel_id: string; label: string; started_at: number }
type Clip = Omit<Session, 'id'> & { id: string; ended_at: number; bytes: number }
type Worker = {
  session: Session
  proc: ChildProcess
  stopping: boolean
  source: string
  hasSegment: boolean
  lastSegmentAt: number
  killTimer?: NodeJS.Timeout
}
const fileFor = (id: string) => join(DIR, `${id}.mp4`)
const unlink = (path: string) => {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
const fileSize = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function registerRecordings(app: FastifyInstance, worlds: Map<string, World>) {
  const workers = new Map<string, Worker>()
  const health = new Map<string, { error?: string; retryAt: number }>()
  const key = (site: string, ch: string) => `${site}\0${ch}`
  let closing = false

  const ingest = (s: Session): number => {
    let manifest: string
    try {
      manifest = readFileSync(join(DIR, `${s.id}.csv`), 'utf8')
    } catch {
      return 0
    }
    let count = 0
    for (const line of manifest.split('\n')) {
      const m = /^([^,]+),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(line.trim())
      if (!m) continue
      const file = basename(m[1])
      if (!file.startsWith(`${s.id}_`) || !/^[\w-]+\.mp4$/.test(file)) continue
      const id = file.slice(0, -4),
        start = Number(m[2]),
        end = Number(m[3])
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !existsSync(fileFor(id))) continue
      const bytes = fileSize(fileFor(id))
      if (!bytes) continue
      const changed = db
        .prepare('INSERT OR IGNORE INTO recordings VALUES (?,?,?,?,?,?,?)')
        .run(
          id,
          s.site_id,
          s.channel_id,
          s.label,
          s.started_at + Math.round(start * 1000),
          s.started_at + Math.round(end * 1000),
          bytes,
        ).changes
      count += Number(changed)
    }
    return count
  }

  const cleanupSession = (s: Session) => {
    for (const file of readdirSync(DIR)) {
      if (!file.startsWith(`${s.id}_`) || !file.endsWith('.mp4')) continue
      if (!db.prepare('SELECT 1 FROM recordings WHERE id=?').get(file.slice(0, -4))) unlink(join(DIR, file))
    }
    unlink(join(DIR, `${s.id}.csv`))
    db.prepare('DELETE FROM recording_sessions WHERE id=?').run(s.id)
  }
  // Recover only finalized segments after a process/platform restart.
  for (const s of db.prepare('SELECT * FROM recording_sessions').all() as Session[]) {
    ingest(s)
    cleanupSession(s)
  }
  for (const file of readdirSync(DIR)) {
    if (file.endsWith('.mp4') && !db.prepare('SELECT 1 FROM recordings WHERE id=?').get(file.slice(0, -4)))
      unlink(join(DIR, file))
    if (file.endsWith('.csv')) unlink(join(DIR, file))
  }

  const stop = (worker: Worker) => {
    if (worker.stopping) return
    worker.stopping = true
    worker.proc.kill('SIGTERM')
    worker.killTimer = setTimeout(() => worker.proc.kill('SIGKILL'), 2500)
    worker.killTimer.unref()
  }
  const start = (p: Policy, w: World) => {
    const k = key(p.site_id, p.channel_id)
    const ch = w.channels().find((c) => c.id === p.channel_id)
    if (!ch || !['file', 'rtsp'].includes(ch.source.kind)) {
      health.set(k, { error: 'Recording source unavailable', retryAt: Date.now() + 30_000 })
      return
    }
    let input: string[]
    if (ch.source.kind === 'file') {
      const file = resolve(MEDIA, ch.source.file.replace(/^.*\/media\//, '').replace(/^\/+/, ''))
      if (!file.startsWith(`${MEDIA}/`) || !existsSync(file)) {
        health.set(k, { error: 'Recording source unavailable', retryAt: Date.now() + 30_000 })
        return
      }
      input = ['-re', '-stream_loop', '-1', '-i', file]
    } else if (ch.source.kind === 'rtsp')
      input = ['-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', ch.source.url]
    else return
    const session: Session = {
      id: randomUUID(),
      site_id: w.id,
      channel_id: ch.id,
      label: ch.label,
      started_at: Date.now(),
    }
    db.prepare('INSERT INTO recording_sessions VALUES (?,?,?,?,?)').run(
      session.id,
      w.id,
      ch.id,
      ch.label,
      session.started_at,
    )
    const proc = spawn(
      process.env.FFMPEG_BIN ?? 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        ...input,
        '-map',
        '0:v:0',
        '-an',
        '-c:v',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        String(SEGMENT),
        '-reset_timestamps',
        '1',
        '-segment_format_options',
        'movflags=+faststart',
        '-segment_list_type',
        'csv',
        '-segment_list_size',
        '10',
        '-segment_list',
        join(DIR, `${session.id}.csv`),
        join(DIR, `${session.id}_%06d.mp4`),
      ],
      { stdio: 'ignore' },
    )
    const worker: Worker = {
      session,
      proc,
      stopping: false,
      source: JSON.stringify(ch.source),
      hasSegment: false,
      lastSegmentAt: Date.now(),
    }
    workers.set(k, worker)
    health.set(k, { retryAt: 0 })
    proc.on('error', () => {
      health.set(k, { error: 'Recorder unavailable. Check FFmpeg installation.', retryAt: Date.now() + 30_000 })
    })
    proc.on('close', () => {
      clearTimeout(worker.killTimer)
      // Site may have been deleted while its recorder was shutting down.
      if (worlds.has(session.site_id)) ingest(session)
      cleanupSession(session)
      workers.delete(k)
      if (!worker.stopping && !health.get(k)?.error)
        health.set(k, { error: 'Recording interrupted. Retrying in 30 seconds.', retryAt: Date.now() + 30_000 })
    })
  }

  const sweep = () => {
    const clips = db
      .prepare(
        `SELECT r.*, COALESCE(p.retention_days,7) AS retention_days FROM recordings r
      LEFT JOIN recording_policies p ON p.site_id=r.site_id AND p.channel_id=r.channel_id ORDER BY started_at`,
      )
      .all() as (Clip & { retention_days: number })[]
    // Include unfinished MP4s: stream-copy segmentation can wait a long time
    // for the next keyframe, so completed-row totals alone do not bound disk use.
    let total = readdirSync(DIR)
      .filter((file) => file.endsWith('.mp4'))
      .reduce((sum, file) => sum + fileSize(join(DIR, file)), 0)
    for (const c of clips)
      if (c.ended_at < Date.now() - c.retention_days * 86400_000 || total > BUDGET || !existsSync(fileFor(c.id))) {
        const bytes = fileSize(fileFor(c.id))
        if (unlink(fileFor(c.id))) {
          db.prepare('DELETE FROM recordings WHERE id=?').run(c.id)
          total -= bytes
        }
      }
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.mp4') || [...workers.values()].some((w) => file.startsWith(`${w.session.id}_`))) continue
      if (!db.prepare('SELECT 1 FROM recordings WHERE id=?').get(file.slice(0, -4))) {
        const bytes = fileSize(join(DIR, file))
        if (unlink(join(DIR, file))) total -= bytes
      }
    }
    if (total > BUDGET) {
      for (const [k, worker] of workers) {
        health.set(k, {
          error: 'Storage budget reached by unfinished video. Retrying in 30 seconds.',
          retryAt: Date.now() + 30_000,
        })
        stop(worker)
      }
    }
  }
  const tick = () => {
    if (closing) return
    const policies = db.prepare('SELECT * FROM recording_policies WHERE enabled=1').all() as Policy[]
    const enabled = new Set(policies.map((p) => key(p.site_id, p.channel_id)))
    for (const [k, worker] of workers) {
      if (!enabled.has(k) || !worlds.has(worker.session.site_id)) {
        stop(worker)
        continue
      }
      const source = worlds
        .get(worker.session.site_id)
        ?.channels()
        .find((c) => c.id === worker.session.channel_id)?.source
      if (JSON.stringify(source) !== worker.source) {
        stop(worker)
        continue
      }
      if (ingest(worker.session)) {
        worker.lastSegmentAt = Date.now()
        worker.hasSegment = true
      }
      if (Date.now() - worker.lastSegmentAt > (SEGMENT * 3 + 30) * 1000) {
        health.set(k, { error: 'No completed video segments. Retrying in 30 seconds.', retryAt: Date.now() + 30_000 })
        stop(worker)
      }
    }
    for (const p of policies) {
      const k = key(p.site_id, p.channel_id),
        w = worlds.get(p.site_id)
      if (w && !w.channels().some((c) => c.id === p.channel_id)) {
        db.prepare('UPDATE recording_policies SET enabled=0 WHERE site_id=? AND channel_id=?').run(
          p.site_id,
          p.channel_id,
        )
        health.set(k, { error: 'Channel removed; recording disabled.', retryAt: 0 })
        const worker = workers.get(k)
        if (worker) stop(worker)
        continue
      }
      if (w && !workers.has(k) && workers.size < MAX_WORKERS && Date.now() >= (health.get(k)?.retryAt ?? 0)) start(p, w)
    }
    sweep()
  }
  sweep()
  const timer = setInterval(tick, 1000)
  timer.unref()

  const site = (req: FastifyRequest, reply: FastifyReply) => {
    const w = worlds.get((req.params as { siteId: string }).siteId)
    if (!w) reply.code(404).send({ error: 'unknown site' })
    return w
  }
  const S = '/api/sites/:siteId'
  app.get(`${S}/recording-policies`, async (req, reply) => {
    const w = site(req, reply)
    if (!w) return
    const rows = db.prepare('SELECT * FROM recording_policies WHERE site_id=?').all(w.id) as Policy[]
    return {
      policies: rows.map((p) => ({
        channelId: p.channel_id,
        enabled: !!p.enabled,
        retentionDays: p.retention_days,
        recording:
          !!workers.get(key(w.id, p.channel_id))?.hasSegment && !workers.get(key(w.id, p.channel_id))!.stopping,
        error: health.get(key(w.id, p.channel_id))?.error ?? null,
      })),
      segmentSeconds: SEGMENT,
      maxStorageMB: BUDGET / 1024 / 1024,
    }
  })
  app.put(`${S}/recording-policies/:chId`, { preHandler: requireRole('admin') }, async (req, reply) => {
    const w = site(req, reply)
    if (!w) return
    const chId = (req.params as { chId: string }).chId
    const ch = w.channels().find((c) => c.id === chId)
    const b = req.body as { enabled?: unknown; retentionDays?: unknown } | null
    if (
      !b ||
      typeof b.enabled !== 'boolean' ||
      !Number.isInteger(b.retentionDays) ||
      Number(b.retentionDays) < 1 ||
      Number(b.retentionDays) > 30
    )
      return reply.code(400).send({ error: 'enabled (boolean) and retentionDays (1–30) required' })
    const existing = db.prepare('SELECT 1 FROM recording_policies WHERE site_id=? AND channel_id=?').get(w.id, chId)
    if (!ch && (b.enabled || !existing)) return reply.code(404).send({ error: 'unknown channel' })
    if (b.enabled && ch && !['file', 'rtsp'].includes(ch.source.kind))
      return reply.code(422).send({ error: 'channel source cannot be recorded' })
    const active = db
      .prepare('SELECT COUNT(*) AS n FROM recording_policies WHERE enabled=1 AND NOT(site_id=? AND channel_id=?)')
      .get(w.id, chId) as { n: number }
    if (b.enabled && active.n >= MAX_WORKERS)
      return reply.code(409).send({ error: 'maximum 8 recording channels; stop another channel first' })
    db.prepare(
      `INSERT INTO recording_policies VALUES (?,?,?,?) ON CONFLICT(site_id,channel_id)
      DO UPDATE SET enabled=excluded.enabled,retention_days=excluded.retention_days`,
    ).run(w.id, chId, b.enabled ? 1 : 0, Number(b.retentionDays))
    health.delete(key(w.id, chId))
    tick()
    return { ok: true }
  })
  app.get(`${S}/recordings`, async (req, reply) => {
    const w = site(req, reply)
    if (!w) return
    const q = req.query as Record<string, string>
    const since = q.since === undefined ? 0 : Number(q.since),
      until = q.until === undefined ? Date.now() : Number(q.until)
    const offset = Number(q.offset ?? 0),
      limit = Number(q.limit ?? 100)
    if (
      ![since, until].every(Number.isFinite) ||
      since < 0 ||
      until < since ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      return reply.code(400).send({ error: 'invalid time range or pagination' })
    const args = [w.id, q.channelId ?? '', q.channelId ?? '', since, until]
    const where = "site_id=? AND (?='' OR channel_id=?) AND ended_at>=? AND started_at<=?"
    const rows = db
      .prepare(`SELECT * FROM recordings WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Clip[]
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM recordings WHERE ${where}`).get(...args) as { n: number }).n
    return {
      recordings: rows.map((c) => ({
        id: c.id,
        channelId: c.channel_id,
        label: c.label,
        startedAt: c.started_at,
        endedAt: c.ended_at,
        bytes: c.bytes,
        url: `${PUB}/api/sites/${encodeURIComponent(w.id)}/recordings/${c.id}/video`,
      })),
      total,
      offset,
      limit,
    }
  })
  app.get(`${S}/recordings/:id/video`, async (req, reply) => {
    const w = site(req, reply)
    if (!w) return
    const c = db
      .prepare('SELECT * FROM recordings WHERE site_id=? AND id=?')
      .get(w.id, (req.params as { id: string }).id) as Clip | undefined
    if (!c || !existsSync(fileFor(c.id))) return reply.code(404).send({ error: 'recording not found or expired' })
    const size = statSync(fileFor(c.id)).size
    reply.type('video/mp4').header('accept-ranges', 'bytes').header('cache-control', 'private, no-store')
    if ((req.query as Record<string, string>).download === '1')
      reply.header('content-disposition', `attachment; filename="${c.id}.mp4"`)
    const range = req.headers.range
    if (!range) return reply.header('content-length', size).send(createReadStream(fileFor(c.id)))
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    let start = m?.[1] ? Number(m[1]) : m?.[2] ? Math.max(0, size - Number(m[2])) : NaN
    let end = m?.[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || start < 0)
      return reply.code(416).header('content-range', `bytes */${size}`).send()
    return reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${size}`)
      .header('content-length', end - start + 1)
      .send(createReadStream(fileFor(c.id), { start, end }))
  })
  app.delete(`${S}/recordings/:id`, { preHandler: requireRole('admin') }, async (req, reply) => {
    const w = site(req, reply)
    if (!w) return
    const c = db
      .prepare('SELECT * FROM recordings WHERE site_id=? AND id=?')
      .get(w.id, (req.params as { id: string }).id) as Clip | undefined
    if (!c) return reply.code(404).send({ error: 'recording not found' })
    if (!unlink(fileFor(c.id)))
      return reply.code(500).send({ error: 'Recording file could not be deleted. Check storage permissions.' })
    db.prepare('DELETE FROM recordings WHERE id=?').run(c.id)
    return { ok: true }
  })
  const shutdown = async () => {
    closing = true
    clearInterval(timer)
    await Promise.all(
      [...workers.values()].map(
        (worker) =>
          new Promise<void>((done) => {
            worker.proc.once('close', () => done())
            stop(worker)
          }),
      ),
    )
  }
  app.addHook('onClose', shutdown)
  return { shutdown }
}
