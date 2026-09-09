// The server owns configuration and durable results. Inference runs only in the adapter.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { db, DATA_DIR, inTx } from './db.js'
import { requestUser, requireRole } from './auth.js'
import { saveEventType } from './config.js'
import { EXTERNAL_STALE_MS, type EventTrigger, type World } from './world.js'
import { monitoringMetrics } from './monitoring.js'

const presets = JSON.parse(
  readFileSync(new URL('../../shared/vision-presets.json', import.meta.url), 'utf8'),
) as {
  id: string
  en: string
  zh: string
  engine: string
  rule: string
  target: string
}[]
const DIR = join(DATA_DIR, 'vision'),
  PUB = process.env.PUBLIC_BASE ?? ''
const S = '/api/sites/:siteId/vision',
  I = '/api/integration/v1/vision'
const fail = (s: string, statusCode = 400): never => {
  throw Object.assign(new Error(s), { statusCode })
}
const obj = (v: any): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : fail('object required')
const str = (v: any, max = 120): string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : fail('invalid text')
const id = (v: any): string => {
  const s = str(v, 100)
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : fail('invalid identifier')
}
const num = (v: any, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail('number out of range')
const rows = <T = any>(sql: string, ...args: any[]): T[] =>
  (db.prepare(sql).all(...args) as { data: string }[]).map((x) => JSON.parse(x.data))
const one = (table: string, site: string, key: string) =>
  rows(`SELECT data FROM ${table} WHERE site_id=? AND id=?`, site, key)[0]
const put = (table: string, site: string, item: any) =>
  db
    .prepare(
      `INSERT INTO ${table}(site_id,id,data) VALUES(?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET data=excluded.data`,
    )
    .run(site, item.id, JSON.stringify(item))
function validJpeg(data: Buffer): boolean {
  if (data.length < 100 || data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217)
    return false
  let offset = 2,
    dimensions = false
  while (offset + 4 <= data.length) {
    if (data[offset++] !== 255) return false
    while (data[offset] === 255) offset++
    if (offset + 3 > data.length) return false
    const marker = data[offset++]
    if (marker === 0xda) return dimensions // Start of compressed image data.
    if (marker === 0xd9) return false
    const size = data.readUInt16BE(offset)
    if (size < 2 || offset + size > data.length) return false
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) return false
      const height = data.readUInt16BE(offset + 3),
        width = data.readUInt16BE(offset + 5)
      dimensions = width > 0 && height > 0 && width <= 4096 && height <= 4096
    }
    offset += size
  }
  return false
}

export interface VisionConfig {
  id: string
  revision: number
  name: string
  preset: string
  adapterId: string
  sourceId: string
  enabled: boolean
  region: [number, number][]
  line: [number, number][]
  direction: 'both' | 'forward' | 'reverse'
  threshold: number
  durationS: number
  confidence: number
  intervalS: number
  severity: 'info' | 'low' | 'high' | 'critical'
  schedule: { days: number[]; start: string; end: string } | null
  assetId: string
  unit: string
  numeric: boolean
  min: number | null
  max: number | null
}
function validate(b: any, site: string, allowUnavailable = false): Omit<VisionConfig, 'id' | 'revision'> {
  b = obj(b)
  const preset = presets.find((p) => p.id === b.preset) ?? fail('unknown preset')
  const adapterId = id(b.adapterId),
    sourceId = id(b.sourceId)
  const adapter = one('vision_adapters', site, adapterId)
  const source = adapter?.sources.find((s: any) => s.id === sourceId)
  if (!allowUnavailable) {
    if (!source) fail('source not registered')
    if (adapter.capabilities && !adapter.capabilities.presets.includes(preset.id)) fail('preset not supported by this adapter')
    if (source.view !== 'fixed' && preset.engine !== 'ocr') fail('continuous monitoring requires a fixed view')
  }
  const points = (v: any, n: number, m: number): [number, number][] => {
    if (!Array.isArray(v) || v.length < n || v.length > m) fail('invalid geometry')
    return v.map((p: any) => {
      if (!Array.isArray(p) || p.length !== 2) fail('invalid point')
      return [num(p[0], 0, 1), num(p[1], 0, 1)]
    })
  }
  const region = points(
      b.region ?? [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      3,
      20,
    ),
    line = points(
      b.line ?? [
        [0.5, 0],
        [0.5, 1],
      ],
      2,
      2,
    )
  const area =
    Math.abs(
      region.reduce(
        (v, p, i) =>
          v + p[0] * region[(i + 1) % region.length][1] - region[(i + 1) % region.length][0] * p[1],
        0,
      ),
    ) / 2
  if (area < 0.0001 || Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 0.01)
    fail('geometry is too small')
  let schedule = null
  if (b.schedule) {
    const s = obj(b.schedule)
    if (
      !Array.isArray(s.days) ||
      !s.days.length ||
      s.days.some((n: any) => !Number.isInteger(n) || n < 0 || n > 6) ||
      ![s.start, s.end].every((t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
    )
      fail('invalid UTC schedule')
    schedule = {
      days: [...new Set(s.days)] as number[],
      start: s.start,
      end: s.end,
    }
  }
  const assetId = b.assetId ? id(b.assetId) : ''
  if (assetId && !one('inspection_assets', site, assetId)) fail('unknown asset')
  const min = b.min == null ? null : num(b.min, -1e12, 1e12),
    max = b.max == null ? null : num(b.max, -1e12, 1e12)
  if (min !== null && max !== null && min > max) fail('minimum exceeds maximum')
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') fail('enabled must be boolean')
  if (b.numeric !== undefined && typeof b.numeric !== 'boolean') fail('numeric must be boolean')
  const direction = b.direction ?? 'both'
  if (!['both', 'forward', 'reverse'].includes(direction)) fail('invalid direction')
  const severity = b.severity ?? 'high'
  if (!['info', 'low', 'high', 'critical'].includes(severity)) fail('invalid severity')
  return {
    name: str(b.name),
    preset: preset.id,
    adapterId,
    sourceId,
    region,
    line,
    direction,
    enabled: b.enabled ?? false,
    threshold: num(b.threshold ?? (preset.rule === 'below' ? 1 : 0), 0, 10000),
    durationS: num(b.durationS ?? 3, 0, 86400),
    confidence: num(b.confidence ?? 0.5, 0.1, 0.99),
    intervalS: num(b.intervalS ?? 15, 1, 3600),
    severity,
    schedule,
    assetId,
    unit: typeof b.unit === 'string' ? b.unit.slice(0, 24) : '',
    numeric: b.numeric ?? false,
    min,
    max,
  }
}

function triggerFor(result: any): EventTrigger {
  const c = result.config as VisionConfig
  const preset = presets.find((p) => p.id === c.preset)
  const conditions: Record<string, string> = {
    above: `count > ${c.threshold} for ${c.durationS}s`,
    below: `count < ${c.threshold} for ${c.durationS}s`,
    dwell: `tracked object dwell ≥ ${c.durationS}s`,
    stationary: `tracked object stationary ≥ ${c.durationS}s`,
    cross: `person crosses configured line (${c.direction})`,
    count: 'Occupancy observation only',
    ocr: 'Text observation only',
  }
  const condition = c.numeric && preset?.rule === 'ocr'
    ? [c.min == null ? '' : `value < ${c.min} ${c.unit}`, c.max == null ? '' : `value > ${c.max} ${c.unit}`].filter(Boolean).join(' or ') || 'Numeric observation'
    : conditions[preset?.rule ?? ''] ?? c.preset
  return {
    ruleId: c.id, ruleType: 'vision', revision: c.revision,
    configSnapshot: structuredClone(c) as unknown as Record<string, unknown>,
    resultId: result.id, observationId: result.observationId,
    adapterId: result.adapterId, sourceId: c.sourceId,
    value: result.value, unit: c.unit, condition, confidence: result.confidence ?? null,
    channelId: result.channelId || undefined, capturedAt: result.capturedAt, receivedAt: result.receivedAt,
  }
}

export function registerVision(
  app: FastifyInstance,
  worlds: Map<string, World>,
  integrationSite: (q: FastifyRequest, r: FastifyReply) => World | null,
) {
  mkdirSync(DIR, { recursive: true })
  db.exec(`CREATE TABLE IF NOT EXISTS vision_adapters(site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,id TEXT,data TEXT NOT NULL,PRIMARY KEY(site_id,id));
 CREATE TABLE IF NOT EXISTS vision_configs(site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,id TEXT,data TEXT NOT NULL,PRIMARY KEY(site_id,id));
 CREATE TABLE IF NOT EXISTS vision_config_revisions(site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,id TEXT,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(site_id,id,revision));
 CREATE TABLE IF NOT EXISTS vision_jobs(site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,id TEXT,data TEXT NOT NULL,PRIMARY KEY(site_id,id));
 CREATE TABLE IF NOT EXISTS vision_results(site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,id TEXT,data TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(site_id,id));
 CREATE INDEX IF NOT EXISTS idx_vision_results_ts ON vision_results(ts);
 CREATE INDEX IF NOT EXISTS idx_vision_results_config ON vision_results(site_id,json_extract(data,'$.configId'),json_extract(data,'$.revision'),ts DESC);
 CREATE TABLE IF NOT EXISTS vision_episodes(site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,id TEXT,data TEXT NOT NULL,PRIMARY KEY(site_id,id));`)
  const archiveConfig = (site: string, c: VisionConfig) => db.prepare(
    'INSERT OR IGNORE INTO vision_config_revisions(site_id,id,revision,data) VALUES(?,?,?,?)',
  ).run(site, c.id, c.revision, JSON.stringify(c))
  // Upgrade only stored facts: old observations already include their frozen
  // config. Never reconstruct an old version from the current editable config.
  inTx(() => {
    for (const row of db.prepare('SELECT site_id,data FROM vision_configs').all() as { site_id: string; data: string }[])
      archiveConfig(row.site_id, JSON.parse(row.data))
    for (const row of db.prepare("SELECT site_id,data FROM vision_results WHERE json_extract(data,'$.triggeredEvent') IS NULL ORDER BY ts").all() as { site_id: string; data: string }[]) {
      const result = JSON.parse(row.data)
      if (!result.jobId) archiveConfig(row.site_id, result.config)
      result.confidence ??= null
      result.sourceId = result.config.sourceId
      result.triggeredEvent = false
      if (result.eventId && !result.jobId && !result.late && result.status === 'alert') {
        const eventRow = db.prepare('SELECT data FROM events WHERE site_id=? AND id=?').get(row.site_id, result.eventId) as { data: string } | undefined
        if (eventRow) {
          const event = JSON.parse(eventRow.data)
          if (!event.trigger && event.type === `vision-${result.config.preset}`) {
            // A continuation of an episode is not the triggering observation.
            // If the original expired already, preserve that provenance gap.
            if (event.ts === result.capturedAt) {
              event.trigger = triggerFor(result)
              event.ruleId = result.configId
              event.source = result.config.sourceId
            }
            event.confidence = event.trigger ? result.confidence : null
            event.x = null
            event.z = null
            db.prepare('UPDATE events SET data=? WHERE site_id=? AND id=?').run(JSON.stringify(event), row.site_id, event.id)
            const w = worlds.get(row.site_id)
            const old = w?.events.find((e) => e.id === event.id)
            if (old) Object.assign(old, event)
          }
          result.triggeredEvent = event.trigger?.resultId === result.id
        }
      }
      db.prepare('UPDATE vision_results SET data=? WHERE site_id=? AND id=?').run(JSON.stringify(result), row.site_id, result.id)
    }
  })
  // Process-local leases deliberately invalidate all adapter tokens after server restart.
  const leases = new Map<string, { runtime: string; token: string; at: number }>()
  const context = (q: FastifyRequest) => {
    const p = q.params as any
    return {
      site: worlds.get(p.siteId)?.id ?? fail('unknown site', 404),
      key: p.id,
    }
  }
  const lease = (q: FastifyRequest, site: string, adapter: string) => {
    const l = leases.get(`${site}/${adapter}`)
    if (!l || Date.now() - l.at > 15000 || q.headers['x-vision-token'] !== l.token)
      fail('adapter lease expired', 409)
    return l
  }
  app.get('/api/sites/:siteId/monitoring-rules', { preHandler: requireRole('viewer') }, async (q) => {
    const { site } = context(q), w = worlds.get(site)!, now = Date.now()
    const configs = rows<VisionConfig>('SELECT data FROM vision_configs WHERE site_id=?', site)
    const adapters = rows('SELECT data FROM vision_adapters WHERE site_id=?', site)
    const visual = configs.map((c) => {
      const adapter = adapters.find((a) => a.id === c.adapterId)
      const source = adapter?.sources.find((s: any) => s.id === c.sourceId)
      const latest = rows("SELECT data FROM vision_results WHERE site_id=? AND json_extract(data,'$.configId')=? AND json_extract(data,'$.revision')=? AND json_extract(data,'$.jobId') IS NULL AND json_extract(data,'$.late')=0 ORDER BY ts DESC LIMIT 1", site, c.id, c.revision)[0]
      let status = 'idle', message = 'Waiting for an observation'
      if (!c.enabled) { status = 'disabled'; message = 'Configuration disabled' }
      else if (now - (leases.get(`${site}/${c.adapterId}`)?.at ?? 0) >= 15000) { status = 'offline'; message = 'Adapter offline' }
      else if (!source || source.status !== 'ready') { status = 'unavailable'; message = source?.note || 'Source unavailable' }
      else if (adapter.capabilities && !adapter.capabilities.presets.includes(c.preset)) { status = 'unavailable'; message = 'Preset not supported by adapter' }
      else if (latest && now - latest.capturedAt <= Math.max(60000, c.intervalS * 3000)) {
        status = ['unknown', 'failed'].includes(latest.status) ? 'unknown' : 'active'
        message = status === 'unknown' ? latest.note || 'Observation inconclusive' : 'Receiving observations'
      }
      return { id: c.id, type: 'vision', name: c.name, enabled: c.enabled, severity: c.severity,
        sourceName: source?.label ?? c.sourceId, channelId: source?.channelId || undefined,
        runtime: { status, message, lastObservedAt: latest?.capturedAt }, config: c }
    })
    const rules = w.rules.map((c) => {
      const observations = c.robotId && c.metric ? w.readings.get(`${c.robotId}|${c.metric}`) : undefined
      const last = observations?.length ? observations.reduce((latest, r) => r.ts >= latest.ts ? r : latest) : undefined
      let status = 'idle', message = c.kind === 'sim' ? 'Explicit demo simulation' : 'No executing producer'
      const legacy = c.kind === 'onboard-cv' || c.kind === 'cloud-cv'
      if (legacy) { status = 'unavailable'; message = 'Legacy visual rule without an executing producer; create a vision configuration' }
      if (!c.enabled) { status = 'disabled'; message = 'Configuration disabled' }
      else if (c.kind === 'threshold') {
        if (now - (w.externals.get(c.robotId ?? '')?.lastSeen ?? 0) >= EXTERNAL_STALE_MS) { status = 'offline'; message = 'Robot offline' }
        else if (!last) message = 'Waiting for a reading'
        else if ((last.quality && last.quality !== 'ok') || now - last.ts > 60000 || last.ts > now + 1000) { status = 'unknown'; message = 'Reading stale or invalid' }
        else { status = 'active'; message = 'Receiving readings' }
      }
      return { id: c.id, type: c.kind === 'threshold' ? 'threshold' : c.kind === 'sim' ? 'sim' : 'external',
        name: c.name, enabled: c.enabled, severity: c.severity, sourceName: c.sourceName,
        legacy, runtime: { status, message, lastObservedAt: last?.ts }, config: c }
    })
    return { rules: [...visual, ...rules], metrics: monitoringMetrics, presets }
  })
  app.get(S, { preHandler: requireRole('viewer') }, async (q) => {
    const { site } = context(q),
      query = q.query as any
    const configs = rows('SELECT data FROM vision_configs WHERE site_id=?', site)
    const adapters = rows('SELECT data FROM vision_adapters WHERE site_id=?', site).map((a) => ({
      ...a,
      online: Date.now() - (leases.get(`${site}/${a.id}`)?.at ?? 0) < 15000,
    }))
    const filters: string[] = [], values: string[] = [site]
    for (const [key, column] of Object.entries({ assetId: "json_extract(data,'$.config.assetId')", configId: "json_extract(data,'$.configId')", resultId: 'id' })) {
      if (query[key]) { filters.push(`${column}=?`); values.push(String(query[key])) }
    }
    const results = rows(`SELECT data FROM vision_results WHERE site_id=?${filters.map((f) => ` AND ${f}`).join('')} ORDER BY ts DESC LIMIT 200`, ...values)
    const jobs = rows('SELECT data FROM vision_jobs WHERE site_id=?', site).map((j) => ({
      ...j,
      status: j.status === 'queued' && j.expiresAt < Date.now() ? 'expired' : j.status,
    }))
    return {
      presets,
      configs,
      adapters,
      results,
      jobs: jobs.slice(-50),
      timezone: 'UTC',
    }
  })
  app.get(`${S}/configs/:id/revisions/:revision`, { preHandler: requireRole('viewer') }, async (q) => {
    const { site, key } = context(q)
    const revision = Number((q.params as any).revision)
    if (!Number.isSafeInteger(revision) || revision < 1) fail('invalid revision')
    return rows('SELECT data FROM vision_config_revisions WHERE site_id=? AND id=? AND revision=?', site, key, revision)[0] ?? fail('revision not found', 404)
  })
  app.get(`${S}/results/:id`, { preHandler: requireRole('viewer') }, async (q) => {
    const { site, key } = context(q)
    return one('vision_results', site, key) ?? fail('observation not found', 404)
  })
  app.post(`${S}/configs`, { preHandler: requireRole('admin') }, async (q, r) => {
    const { site } = context(q)
    if (rows('SELECT data FROM vision_configs WHERE site_id=?', site).length >= 128)
      fail('limit of 128 monitoring configurations per site', 429)
    const c = { ...validate(q.body, site), id: randomUUID(), revision: 1 }
    inTx(() => { put('vision_configs', site, c); archiveConfig(site, c) })
    return r.code(201).send(c)
  })
  app.put(`${S}/configs/:id`, { preHandler: requireRole('admin') }, async (q) => {
    const { site, key } = context(q)
    const old = one('vision_configs', site, key) ?? fail('not found', 404)
    const b = obj(q.body)
    if (b.revision !== old.revision) fail('configuration changed; reload before saving', 409)
    // A disappearing source/capability must never prevent stopping its existing
    // configuration. Creating, enabling and previewing still validate capability.
    const stopping = b.enabled === false && b.adapterId === old.adapterId && b.sourceId === old.sourceId
    const c = { ...validate(b, site, stopping), id: key, revision: old.revision + 1 }
    inTx(() => { archiveConfig(site, old); put('vision_configs', site, c); archiveConfig(site, c) })
    return c
  })
  app.delete(`${S}/configs/:id`, { preHandler: requireRole('admin') }, async (q) => {
    const { site, key } = context(q)
    if (!one('vision_configs', site, key)) fail('not found', 404)
    db.prepare('DELETE FROM vision_configs WHERE site_id=? AND id=?').run(site, key)
    return { ok: true }
  })
  app.post(`${S}/test`, { preHandler: requireRole('operator') }, async (q, r) => {
    const { site } = context(q),
      config = {
        ...validate(q.body, site),
        id: `test-${randomUUID()}`,
        revision: 1,
      }
    const a = leases.get(`${site}/${config.adapterId}`)
    if (!a || Date.now() - a.at > 15000) fail('adapter offline', 409)
    const pending = rows('SELECT data FROM vision_jobs WHERE site_id=?', site).filter(
      (j) => j.status === 'queued' && j.expiresAt > Date.now(),
    )
    if (pending.length >= 16) fail('too many pending tests', 429)
    const job = {
      id: randomUUID(),
      config,
      status: 'queued',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      by: requestUser(q)?.username,
    }
    put('vision_jobs', site, job)
    return r.code(201).send(job)
  })
  app.get(`${S}/evidence/:id`, { preHandler: requireRole('viewer') }, async (q, r) => {
    const { site, key } = context(q),
      rec = one('vision_results', site, key) ?? fail('not found', 404)
    if (!rec.evidence) fail('no evidence', 404)
    try {
      return r
        .header('cache-control', 'private, no-store')
        .type('image/jpeg')
        .send(readFileSync(join(DIR, rec.file)))
    } catch {
      return r.code(404).send({ error: 'evidence expired' })
    }
  })
  app.post(`${I}/heartbeat`, async (q, r) => {
    const w = integrationSite(q, r)
    if (!w) return
    const b = obj(q.body),
      aid = id(b.adapterId),
      runtime = id(b.runtimeId),
      key = `${w.id}/${aid}`,
      now = Date.now(),
      old = leases.get(key)
    if (old && old.runtime !== runtime && now - old.at < 15000)
      fail('another instance owns this adapter', 409)
    const token = old?.runtime === runtime ? old.token : randomUUID()
    if (!Array.isArray(b.sources) || b.sources.length > 32) fail('invalid sources')
    const sources = b.sources.map((raw: any) => {
      const s = obj(raw)
      return {
        id: id(s.id),
        label: str(s.label),
        channelId: s.channelId ? str(s.channelId) : '',
        view: s.view === 'fixed' ? 'fixed' : 'mobile',
        status: ['ready', 'unavailable', 'paused'].includes(s.status) ? s.status : 'unavailable',
        note: typeof s.note === 'string' ? s.note.slice(0, 200) : '',
      }
    })
    if (new Set(sources.map((s: any) => s.id)).size !== sources.length) fail('duplicate source')
    const models = {
      detector: typeof b.models?.detector === 'string' ? b.models.detector.slice(0, 120) : '',
      ocr: typeof b.models?.ocr === 'string' ? b.models.ocr.slice(0, 120) : '',
    }
    let capabilities: { presets: string[] } | undefined
    if (b.capabilities !== undefined) {
      const ids = obj(b.capabilities).presets
      if (!Array.isArray(ids) || ids.length > presets.length || ids.some((p) => !presets.some((known) => known.id === p)) || new Set(ids).size !== ids.length) fail('invalid preset capabilities')
      capabilities = { presets: ids }
    }
    const name = str(b.name ?? aid)
    leases.set(key, { runtime, token, at: now })
    put('vision_adapters', w.id, {
      id: aid,
      name,
      sources,
      models,
      capabilities,
      lastSeen: now,
    })
    const configs = rows<VisionConfig>('SELECT data FROM vision_configs WHERE site_id=?', w.id).filter(
      (c) => c.adapterId === aid && c.enabled,
    )
    const jobs = rows('SELECT data FROM vision_jobs WHERE site_id=?', w.id).filter(
      (j) => j.config.adapterId === aid && j.status === 'queued' && j.expiresAt > now,
    )
    return { token, serverTime: now, configs, jobs }
  })
  app.post(`${I}/results`, async (q, r) => {
    const w = integrationSite(q, r)
    if (!w) return
    const b = obj(q.body),
      aid = id(b.adapterId)
    lease(q, w.id, aid)
    const resultId = id(b.id),
      existing = one('vision_results', w.id, resultId)
    if (existing) {
      if (existing.adapterId !== aid) fail('result belongs to another adapter', 409)
      return { id: existing.id, eventId: existing.eventId, duplicate: true }
    }
    let config: VisionConfig, job: any
    if (b.jobId) {
      job = one('vision_jobs', w.id, id(b.jobId)) ?? fail('job not found', 404)
      config = job.config
      if (job.expiresAt < Date.now()) fail('test expired', 410)
      if (job.status === 'done') fail('test already completed', 409)
    } else config = one('vision_configs', w.id, id(b.configId)) ?? fail('configuration removed', 410)
    if (config.adapterId !== aid) fail('wrong adapter', 403)
    if (config.revision !== b.revision || (!job && !config.enabled)) fail('configuration superseded', 409)
    const capturedAt = num(b.capturedAt, Date.now() - 7 * 86400000, Date.now() + 60000),
      late = Date.now() - capturedAt > 60000
    if (!['normal', 'alert', 'unknown', 'failed'].includes(b.status)) fail('invalid result status')
    const result: any = {
      id: resultId,
      adapterId: aid,
      sourceId: config.sourceId,
      channelId: one('vision_adapters', w.id, aid)?.sources.find((s: any) => s.id === config.sourceId)?.channelId || undefined,
      config,
      configId: config.id,
      revision: config.revision,
      jobId: job?.id,
      capturedAt,
      receivedAt: Date.now(),
      late,
      status: b.status,
      value: typeof b.value === 'number' ? num(b.value, -1e12, 1e12) : null,
      confidence: b.confidence == null ? null : num(b.confidence, 0, 1),
      text: typeof b.text === 'string' ? b.text.slice(0, 2000) : '',
      note: typeof b.note === 'string' ? b.note.slice(0, 500) : '',
      model: str(b.model, 160),
      observationId: id(b.observationId),
      annotations: [],
      evidence: '',
      file: '',
      fileSize: 0,
      eventId: '',
      triggeredEvent: false,
    }
    if (Array.isArray(b.annotations)) {
      if (b.annotations.length > 200) fail('too many annotations')
      result.annotations = b.annotations.map((a: any) => ({
        label: str(a.label, 100),
        box:
          Array.isArray(a.box) && a.box.length === 4
            ? a.box.map((n: any) => num(n, 0, 1))
            : fail('invalid box'),
        score: num(a.score, 0, 1),
      }))
    }
    if (b.image) {
      if (
        typeof b.image !== 'string' ||
        b.image.length > 3 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(b.image)
      )
        fail('invalid JPEG')
      const data = Buffer.from(b.image, 'base64')
      if (!validJpeg(data)) fail('valid JPEG up to 4096px required')
      result.file = `${randomUUID()}.jpg`
      result.fileSize = data.length
      writeFileSync(join(DIR, result.file), data)
      result.evidence = `${PUB}/api/sites/${w.id}/vision/evidence/${result.id}`
    }
    try {
      inTx(() => {
        // A late/offline observation stays in history but cannot raise a current alarm.
        if (!job && !late) {
          const episodeKey = `${config.id}-${config.revision}`
          const episode = one('vision_episodes', w.id, episodeKey)
          if (!episode || capturedAt > episode.at) {
            let eventId = episode?.eventId ?? ''
            if (result.status === 'alert' && episode?.status !== 'alert') {
              const type = `vision-${config.preset}`
              if (!w.eventTypes.some((t) => t.id === type)) {
                const t = w.addEventType({
                  id: type,
                  label: presets.find((p) => p.id === config.preset)!.en,
                  severity: config.severity,
                  category: 'equipment',
                })
                if (t) saveEventType(w.id, t)
              }
              const ev = w.ingestEvent({
                type,
                sourceName: config.name,
                severity: config.severity,
                detail: result.note || `${config.name}: ${result.value ?? result.text}`,
                snapshotUrl: result.evidence || undefined,
                ts: capturedAt,
                confidence: result.confidence,
              }, triggerFor(result))
              eventId = ev?.id ?? ''
              result.triggeredEvent = !!ev
            }
            result.eventId = eventId
            // Unknown does not reset an active episode or claim that an issue recovered.
            put('vision_episodes', w.id, {
              id: episodeKey,
              at: capturedAt,
              status: ['normal', 'alert'].includes(result.status)
                ? result.status
                : (episode?.status ?? 'unknown'),
              eventId,
            })
          }
        }
        db.prepare('INSERT INTO vision_results(site_id,id,data,ts) VALUES(?,?,?,?)').run(
          w.id,
          result.id,
          JSON.stringify(result),
          capturedAt,
        )
        if (job)
          put('vision_jobs', w.id, {
            ...job,
            status: 'done',
            resultId: result.id,
          })
      })
    } catch (error) {
      if (result.file)
        try {
          unlinkSync(join(DIR, result.file))
        } catch {}
      throw error
    }
    return { id: result.id, eventId: result.eventId }
  })
  const sweep = () => {
    const cutoff = Date.now() - 7 * 86400000
    for (const row of db.prepare('SELECT site_id,data FROM vision_results WHERE ts<?').all(cutoff) as { site_id: string; data: string }[]) {
      const x = JSON.parse(row.data)
      if (x.file)
        try {
          unlinkSync(join(DIR, x.file))
        } catch {}
      if (x.triggeredEvent) {
        if (x.file || x.evidence) x.evidenceExpired = true
        x.file = ''; x.fileSize = 0; x.evidence = ''
        db.prepare('UPDATE vision_results SET data=? WHERE site_id=? AND id=?').run(JSON.stringify(x), row.site_id, x.id)
      }
    }
    // Triggering observations are event audit records. Keep their facts after
    // media expiry; ordinary observations still follow the seven-day window.
    db.prepare(`DELETE FROM vision_results WHERE ts<? AND (
      COALESCE(json_extract(data,'$.triggeredEvent'),0)!=1 OR NOT EXISTS (
        SELECT 1 FROM events WHERE events.site_id=vision_results.site_id AND events.id=json_extract(vision_results.data,'$.eventId')
      ))`).run(cutoff)
    const budget = Math.max(128, Math.min(8192, Number(process.env.PB_VISION_MAX_MB) || 1024)) * 1024 * 1024
    const files = (
      db
        .prepare(
          "SELECT site_id,data FROM vision_results WHERE json_extract(data,'$.fileSize')>0 ORDER BY ts ASC",
        )
        .all() as { site_id: string; data: string }[]
    ).map((x) => ({ site: x.site_id, record: JSON.parse(x.data) }))
    let used = files.reduce((sum, x) => sum + x.record.fileSize, 0)
    for (const { site, record: rec } of files) {
      if (used <= budget) break
      try {
        unlinkSync(join(DIR, rec.file))
      } catch {}
      used -= rec.fileSize
      rec.fileSize = 0
      rec.file = ''
      rec.evidence = ''
      rec.evidenceExpired = true
      db.prepare('UPDATE vision_results SET data=? WHERE site_id=? AND id=?').run(
        JSON.stringify(rec),
        site,
        rec.id,
      )
    }
    db.prepare("DELETE FROM vision_jobs WHERE json_extract(data,'$.createdAt')<?").run(cutoff)
    const referenced = new Set(
      rows("SELECT data FROM vision_results WHERE json_extract(data,'$.file')!=''").map((r) => r.file),
    )
    for (const file of readdirSync(DIR))
      if (/^[a-f0-9-]+\.jpg$/.test(file) && !referenced.has(file))
        try {
          unlinkSync(join(DIR, file))
        } catch {}
    db.prepare(
      "DELETE FROM vision_episodes WHERE NOT EXISTS (SELECT 1 FROM vision_configs c WHERE c.site_id=vision_episodes.site_id AND c.id||'-'||json_extract(c.data,'$.revision')=vision_episodes.id)",
    ).run()
  }
  sweep()
  const timer = setInterval(sweep, 60000)
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))
}
