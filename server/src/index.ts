import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITES } from './sites.js'
import { World, SNAP_DIR } from './world.js'
import {
  loadConfig,
  getConfig,
  saveConfig,
  newApiKey,
  findApiKey,
  roleFor,
  MAPS_DIR,
  type ExternalRec,
} from './config.js'
import { requestUser, requireRole, issueSession, clearSession, login, publicUser } from './auth.js'
import { ROBOT_CATALOG, PAYLOAD_CATALOG, METRIC_DEFS, type Command } from './fleet.js'
import { grabFrame } from './frames.js'

const PUB = process.env.PUBLIC_BASE ?? ''

// ---------- boot worlds ----------

const worlds = new Map<string, World>(SITES.map((def) => [def.id, new World(def)]))
const config = loadConfig([...worlds.keys()])

// replay durable per-site config into the runtime worlds
for (const [siteId, sc] of Object.entries(config.sites)) {
  const w = worlds.get(siteId)
  if (!w) continue
  for (const t of sc.eventTypes) w.addEventType(t)
  for (const ext of sc.externals) w.registerExternal(ext)
  if (sc.map) {
    w.site.map = {
      image: `${PUB}/api/sites/${siteId}/map-image?v=${sc.map.uploadedAt}`,
      resolution: sc.map.resolution,
      width: sc.map.width,
      height: sc.map.height,
      origin: sc.map.origin,
      source: sc.map.source,
    }
  }
}

const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024 })
await app.register(cors, { origin: true, credentials: true })
// demo footage served directly (Range-capable) — every channel plays a
// local loop; snapshots are cut from the same files via ffmpeg
await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '..', 'media'),
  prefix: '/media/',
  cacheControl: true,
  maxAge: '1h',
})

// ---------- websocket (per-site rooms) ----------

const wss = new WebSocketServer({ noServer: true })
const rooms = new Map<string, Set<WebSocket>>([...worlds.keys()].map((id) => [id, new Set()]))

function broadcast(siteId: string, msg: unknown) {
  const s = JSON.stringify(msg)
  for (const c of rooms.get(siteId) ?? []) if (c.readyState === WebSocket.OPEN) c.send(s)
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', 'http://x')
  const siteId = url.searchParams.get('site') ?? SITES[0].id
  const w = worlds.get(siteId)
  if (!w) {
    ws.close(4004, 'unknown site')
    return
  }
  rooms.get(siteId)!.add(ws)
  ws.send(
    JSON.stringify({
      t: 'hello',
      siteId,
      site: w.site,
      robots: w.robots,
      cameras: w.cameras,
      waypoints: w.waypoints,
      zones: w.zones,
      buildings: w.buildings,
      events: w.listEvents(80),
      missions: w.missions,
      templates: w.templates,
      schedules: w.schedules,
      rules: w.rules,
      eventTypes: w.eventTypes,
      metricDefs: METRIC_DEFS,
      channels: w.channels(),
      maps: w.maps(),
    }),
  )
  ws.on('close', () => rooms.get(siteId)!.delete(ws))
  ws.on('error', () => rooms.get(siteId)!.delete(ws))
})

for (const w of worlds.values()) {
  w.onResult = (m, res) => broadcast(w.id, { t: 'missionResult', missionId: m.id, result: res, missions: w.missions })
  w.onEvent = (ev) => broadcast(w.id, { t: 'event', event: ev })
  w.onVerify = (ev) => broadcast(w.id, { t: 'verification', event: ev })
  w.onReadings = (batch) => broadcast(w.id, { t: 'readings', items: batch })
  for (const r of w.robots) {
    const s = w.nav.get(r.id)
    if (s) s.onResult = (m, res) => broadcast(w.id, { t: 'missionResult', missionId: m.id, result: res, missions: w.missions })
  }
}

// ---------- helpers ----------

type P = Record<string, string>

function world(req: FastifyRequest, reply: FastifyReply): World | null {
  const w = worlds.get((req.params as P).siteId)
  if (!w) {
    reply.code(404).send({ error: 'unknown site' })
    return null
  }
  return w
}

/** integration API auth: Authorization: Bearer <site api key> */
function integrationSite(req: FastifyRequest, reply: FastifyReply): World | null {
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ''))
  const hit = m ? findApiKey(m[1].trim()) : null
  if (!hit) {
    reply.code(401).send({ error: 'valid site API key required (Authorization: Bearer pbk_…)' })
    return null
  }
  return worlds.get(hit.siteId) ?? null
}

// ---------- auth ----------

app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
  const { username, password } = req.body ?? {}
  const u = username && password ? login(username, password) : null
  if (!u) return reply.code(401).send({ error: 'invalid credentials' })
  issueSession(reply, u.username)
  return { user: publicUser(u) }
})

app.post('/api/auth/logout', async (_req, reply) => {
  clearSession(reply)
  return { ok: true }
})

app.get('/api/auth/me', async (req) => {
  const u = requestUser(req)
  return {
    user: publicUser(u),
    sites: SITES.map((s) => ({ id: s.id, name: s.name, operator: s.operator, role: roleFor(u, s.id) })),
  }
})

// ---------- global ----------

app.get('/api/health', async () => ({ ok: true, ts: Date.now(), sites: [...worlds.keys()] }))

app.get('/api/sites', async (req) => {
  const u = requestUser(req)
  return {
    sites: SITES.map((s) => {
      const w = worlds.get(s.id)!
      return {
        id: s.id,
        name: s.name,
        operator: s.operator,
        role: roleFor(u, s.id),
        robots: w.robots.length,
        openAlerts: w.events.filter(
          (e) => e.lifecycle === 'new' && e.verification?.state !== 'pending' && (e.severity === 'critical' || e.severity === 'high'),
        ).length,
      }
    }),
  }
})

app.get<{ Params: { file: string } }>('/api/snapshots/:file', async (req, reply) => {
  const file = (req.params as P).file.replace(/[^A-Za-z0-9._-]/g, '')
  const p = join(SNAP_DIR, file)
  if (!existsSync(p)) return reply.code(404).send({ error: 'not found' })
  reply.header('cache-control', 'public, max-age=3600')
  reply.type('image/jpeg')
  return reply.send(readFileSync(p))
})

// ---------- site-scoped API ----------

const S = '/api/sites/:siteId'

app.get(`${S}/fleet`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { site: w.site, robots: w.robots, cameras: w.cameras, waypoints: w.waypoints, zones: w.zones, buildings: w.buildings }
})

app.get(`${S}/catalog`, async (req: FastifyRequest, reply) => {
  if (!world(req, reply)) return
  return { models: ROBOT_CATALOG, payloads: PAYLOAD_CATALOG }
})

app.get(`${S}/map-image`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const rec = getConfig().sites[w.id]?.map
  if (!rec) return reply.code(404).send({ error: 'no uploaded map' })
  const p = join(MAPS_DIR, rec.file)
  if (!existsSync(p)) return reply.code(404).send({ error: 'map file missing' })
  reply.header('cache-control', 'public, max-age=604800')
  reply.type('image/png')
  return reply.send(readFileSync(p))
})

// -- provisioning (admin) --

app.post(`${S}/robots`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.model || !b.ip || !b.home) return reply.code(400).send({ error: 'model, ip, home required' })
  const robot = w.registerRobot({
    model: b.model,
    callsign: b.callsign,
    ip: b.ip,
    protocol: b.protocol,
    home: b.home,
    payloadIds: Array.isArray(b.payloadIds) ? b.payloadIds : [],
  })
  if (!robot) return reply.code(400).send({ error: 'unknown model' })
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { robot }
})

app.post(`${S}/robots/:id/payloads`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const inst = w.installPayload((req.params as P).id, ((req.body ?? {}) as any).payloadId)
  if (!inst) return reply.code(404).send({ error: 'unknown robot or payload' })
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { payload: inst }
})

app.delete(`${S}/robots/:id/payloads/:pid`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!w.removePayload((req.params as P).id, (req.params as P).pid)) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { ok: true }
})

app.delete(`${S}/external-robots/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const robot = w.robots.find((r) => r.id === (req.params as P).id)
  if (!robot || !w.removeExternal((req.params as P).id)) return reply.code(404).send({ error: 'not found' })
  const sc = getConfig().sites[w.id]
  sc.externals = sc.externals.filter((e) => e.serial !== robot.serial)
  saveConfig()
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { ok: true }
})

// -- channels + stream sessions (playback is a lease, not a getter) --

app.get(`${S}/channels`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { channels: w.channels() }
})

app.get(`${S}/robots/:id/channels`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { channels: w.channels((req.params as P).id) }
})

app.post(`${S}/channels/:chId/sessions`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const s = w.openSession(decodeURIComponent((req.params as P).chId))
  if (!s) return reply.code(404).send({ error: 'unknown channel' })
  return { session: s }
})

app.post(`${S}/stream-sessions/:sid/renew`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const s = w.renewSession((req.params as P).sid)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  return { session: s }
})

app.delete(`${S}/stream-sessions/:sid`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { ok: w.closeSession((req.params as P).sid) }
})

app.get(`${S}/channels/:chId/snapshot`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const ch = w.channels().find((c) => c.id === decodeURIComponent((req.params as P).chId))
  if (!ch?.streamKey) return reply.code(404).send({ error: 'channel has no snapshot source' })
  const frame = await grabFrame(ch.streamKey)
  if (!frame) return reply.code(503).send({ error: 'snapshot unavailable' })
  reply.header('cache-control', 'no-store')
  reply.type('image/jpeg')
  return reply.send(frame)
})

// -- payload readings (stable envelope; metrics are registry entries) --

app.get(`${S}/metrics`, async (req: FastifyRequest, reply) => {
  if (!world(req, reply)) return
  return { metrics: METRIC_DEFS }
})

app.get(`${S}/robots/:id/readings`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const q = (req.query ?? {}) as Record<string, string>
  const robotId = (req.params as P).id
  return {
    metrics: w.robotMetrics(robotId),
    readings: w.listReadings(robotId, q.metric || undefined, Number(q.since ?? 0), Number(q.limit ?? 200)),
  }
})

// -- events (lifecycle: new → acked → resolved | dismissed) --

app.get(`${S}/events`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { events: w.listEvents(Number((req.query as any)?.limit ?? 120)) }
})

app.post(`${S}/events/:id/ack`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const ev = w.ackEvent((req.params as P).id)
  if (!ev) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'lifecycle', id: ev.id, lifecycle: ev.lifecycle })
  return { ok: true }
})

app.post(`${S}/events/:id/resolve`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const ev = w.setLifecycle((req.params as P).id, 'resolved')
  if (!ev) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'lifecycle', id: ev.id, lifecycle: ev.lifecycle })
  return { ok: true }
})

app.post(`${S}/events/:id/dismiss`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const ev = w.setLifecycle((req.params as P).id, 'dismissed')
  if (!ev) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'lifecycle', id: ev.id, lifecycle: ev.lifecycle })
  return { ok: true }
})

/** dismissed events keep their evidence — this is the negative-sample training export */
app.get(`${S}/events/export`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const lc = String((req.query as any)?.lifecycle ?? 'dismissed')
  const rows = w.events.filter((e) => e.lifecycle === lc)
  reply.header('content-disposition', `attachment; filename="${w.id}-events-${lc}.jsonl"`)
  reply.type('application/x-ndjson')
  return rows.map((e) => JSON.stringify(e)).join('\n')
})

// -- rules (admin mutates) --

app.get(`${S}/rules`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { rules: w.rules }
})

app.post(`${S}/rules`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.name || !b.model || !b.source) return reply.code(400).send({ error: 'name, model, source required' })
  if (!w.eventTypes.some((t) => t.id === b.model)) return reply.code(400).send({ error: 'unknown detection model / event type' })
  const rule = w.createRule(b)
  broadcast(w.id, { t: 'rules', rules: w.rules })
  return { rule }
})

app.patch(`${S}/rules/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const r = w.patchRule((req.params as P).id, req.body ?? {})
  if (!r) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'rules', rules: w.rules })
  return { rule: r }
})

app.delete(`${S}/rules/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!w.deleteRule((req.params as P).id)) return reply.code(404).send({ error: 'not found or builtin' })
  broadcast(w.id, { t: 'rules', rules: w.rules })
  return { ok: true }
})

// -- custom event types (admin mutates) --

app.get(`${S}/event-types`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { eventTypes: w.eventTypes }
})

app.post(`${S}/event-types`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.id || !b.label) return reply.code(400).send({ error: 'id and label required' })
  const t = w.addEventType(b)
  if (!t) return reply.code(409).send({ error: 'id taken or invalid' })
  const sc = getConfig().sites[w.id]
  sc.eventTypes.push({ id: t.id, label: t.label, severity: t.severity, detail: t.detail })
  saveConfig()
  broadcast(w.id, { t: 'eventTypes', eventTypes: w.eventTypes })
  return { eventType: t }
})

app.delete(`${S}/event-types/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!w.deleteEventType((req.params as P).id)) return reply.code(404).send({ error: 'not found or builtin' })
  const sc = getConfig().sites[w.id]
  sc.eventTypes = sc.eventTypes.filter((t) => t.id !== (req.params as P).id)
  saveConfig()
  broadcast(w.id, { t: 'eventTypes', eventTypes: w.eventTypes })
  return { ok: true }
})

// -- api keys (admin) --

app.get(`${S}/api-keys`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { apiKeys: getConfig().sites[w.id].apiKeys }
})

app.post(`${S}/api-keys`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { apiKey: newApiKey(w.id, String(((req.body ?? {}) as any).label ?? '')) }
})

app.delete(`${S}/api-keys/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const sc = getConfig().sites[w.id]
  const before = sc.apiKeys.length
  sc.apiKeys = sc.apiKeys.filter((k) => k.id !== (req.params as P).id)
  if (sc.apiKeys.length === before) return reply.code(404).send({ error: 'not found' })
  saveConfig()
  return { ok: true }
})

// -- integrations summary (admin panel) --

app.get(`${S}/integrations`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const now = Date.now()
  return {
    apiKeys: getConfig().sites[w.id].apiKeys,
    eventTypes: w.eventTypes,
    externals: w.robots
      .filter((r) => r.adapter === 'external')
      .map((r) => {
        const ext = w.externals.get(r.id)
        return {
          id: r.id,
          serial: r.serial,
          callsign: r.callsign,
          model: r.model,
          level: r.integrationLevel,
          lastSeen: ext?.lastSeen ?? 0,
          online: ext ? now - ext.lastSeen < 20_000 : false,
          mode: ext?.mode,
        }
      }),
    orders: w.orders.slice(-30).reverse(),
    map: w.site.map,
  }
})

// -- mission templates (routes — site-level, reusable) --

app.get(`${S}/mission-templates`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { templates: w.templates }
})

app.post(`${S}/mission-templates`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.name || !Array.isArray(b.steps) || !b.steps.length)
    return reply.code(400).send({ error: 'name and steps[] required' })
  const t = w.createTemplate({ name: b.name, steps: b.steps })
  broadcast(w.id, { t: 'templates', templates: w.templates })
  return { template: t }
})

app.delete(`${S}/mission-templates/:id`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!w.deleteTemplate((req.params as P).id)) return reply.code(404).send({ error: 'not found or builtin' })
  broadcast(w.id, { t: 'templates', templates: w.templates })
  broadcast(w.id, { t: 'schedules', schedules: w.schedules })
  return { ok: true }
})

// -- schedules (creation IS activation — no separate deploy step) --

app.get(`${S}/schedules`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { schedules: w.schedules }
})

app.post(`${S}/schedules`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.templateId || !b.cadence?.kind) return reply.code(400).send({ error: 'templateId and cadence required' })
  const s = w.createSchedule({ templateId: b.templateId, assign: b.assign, cadence: b.cadence, priority: b.priority })
  if (!s) return reply.code(404).send({ error: 'unknown template' })
  broadcast(w.id, { t: 'schedules', schedules: w.schedules })
  return { schedule: s }
})

app.patch(`${S}/schedules/:id`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const s = w.patchSchedule((req.params as P).id, (req.body ?? {}) as any)
  if (!s) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'schedules', schedules: w.schedules })
  return { schedule: s }
})

app.delete(`${S}/schedules/:id`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!w.deleteSchedule((req.params as P).id)) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'schedules', schedules: w.schedules })
  return { ok: true }
})

// -- maps (first-class assets + explicit calibration transforms) --

app.get(`${S}/maps`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return w.maps()
})

// -- commands (semantic, server-validated; velocity deadman lives here, not in clients) --

app.post(`${S}/robots/:id/commands`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as Partial<Command>
  if (!b.type) return reply.code(400).send({ error: 'type required' })
  const u = requestUser(req)
  const rec = w.command((req.params as P).id, b as Command, u?.username ?? 'operator')
  if (rec.accepted) broadcast(w.id, { t: 'command', record: rec })
  return { command: rec }
})

app.get(`${S}/robots/:id/commands`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { commands: w.commandLog.filter((c) => c.robotId === (req.params as P).id).slice(0, 20) }
})

// -- missions (runs — the execution layer) --

app.get(`${S}/missions`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { missions: w.missions }
})

app.post(`${S}/missions/:id/pause`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const m = w.pauseMission((req.params as P).id, true)
  if (!m) return reply.code(404).send({ error: 'not active' })
  broadcast(w.id, { t: 'missions', missions: w.missions })
  return { mission: m }
})

app.post(`${S}/missions/:id/resume`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const m = w.pauseMission((req.params as P).id, false)
  if (!m) return reply.code(404).send({ error: 'not active' })
  broadcast(w.id, { t: 'missions', missions: w.missions })
  return { mission: m }
})

app.post(`${S}/missions`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.name || !Array.isArray(b.steps) || !b.steps.length)
    return reply.code(400).send({ error: 'name and steps[] required' })
  const m = w.createMission({
    name: b.name,
    priority: b.priority ?? 2,
    requestedRobot: b.requestedRobot ?? 'auto',
    recurring: !!b.recurring,
    steps: b.steps,
    templateId: b.templateId,
  })
  broadcast(w.id, { t: 'missions', missions: w.missions })
  return { mission: m }
})

app.post(`${S}/missions/:id/abort`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const m = w.abortMission((req.params as P).id)
  if (!m) return reply.code(404).send({ error: 'not found' })
  broadcast(w.id, { t: 'missions', missions: w.missions })
  return { mission: m }
})

app.post(`${S}/robots/:id/goto`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const { x, z } = (req.body ?? {}) as { x?: unknown; z?: unknown }
  if (typeof x !== 'number' || typeof z !== 'number') return reply.code(400).send({ error: 'x,z required' })
  if (!w.teleopGoto((req.params as P).id, x, z))
    return reply.code(404).send({ error: 'unknown robot (or external unit is state-only)' })
  return { ok: true }
})

// ---------- integration API v1 (Bearer <site api key>) ----------
// Semantics follow VDA 5050 / MassRobotics interop: factsheet-style
// registration, adapter-pushed state, pull-based orders, custom events,
// ROS map_server-style occupancy upload. Two integration levels
// (Open-RMF-style): state-only | dispatchable.

const I = '/api/integration/v1'

app.get(`${I}/site`, async (req, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  return { site: w.site, waypoints: w.waypoints, zones: w.zones, eventTypes: w.eventTypes }
})

app.post(`${I}/robots`, async (req: FastifyRequest<{ Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.serial || !b.model || !b.level) return reply.code(400).send({ error: 'serial, model, level required' })
  if (b.level !== 'state-only' && b.level !== 'dispatchable')
    return reply.code(400).send({ error: "level must be 'state-only' | 'dispatchable'" })
  const rec: ExternalRec = {
    serial: String(b.serial),
    model: String(b.model),
    vendor: b.vendor,
    callsign: b.callsign,
    family: b.family,
    level: b.level,
    ip: b.ip,
    protocol: b.protocol,
    home: b.home,
    streams: Array.isArray(b.streams) ? b.streams : undefined,
  }
  const robot = w.registerExternal(rec)
  const sc = getConfig().sites[w.id]
  sc.externals = [...sc.externals.filter((e) => e.serial !== rec.serial), rec]
  saveConfig()
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { robot: { id: robot.id, callsign: robot.callsign, integrationLevel: robot.integrationLevel } }
})

app.delete(`${I}/robots/:serial`, async (req: FastifyRequest<{ Params: { serial: string } }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robots.find((r) => r.serial === req.params.serial && r.adapter === 'external')
  if (!robot || !w.removeExternal(robot.id)) return reply.code(404).send({ error: 'not found' })
  const sc = getConfig().sites[w.id]
  sc.externals = sc.externals.filter((e) => e.serial !== req.params.serial)
  saveConfig()
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { ok: true }
})

app.post(`${I}/robots/:serial/state`, async (req: FastifyRequest<{ Params: { serial: string }; Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robots.find((r) => r.serial === req.params.serial && r.adapter === 'external')
  if (!robot) return reply.code(404).send({ error: 'robot not registered' })
  w.ingestState(robot.id, req.body ?? {})
  return { ok: true, ordersPending: w.orders.filter((o) => o.robotId === robot.id && o.state === 'pending').length }
})

app.get(`${I}/robots/:serial/orders`, async (req: FastifyRequest<{ Params: { serial: string } }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robots.find((r) => r.serial === req.params.serial && r.adapter === 'external')
  if (!robot) return reply.code(404).send({ error: 'robot not registered' })
  return { orders: w.pullOrders(robot.id) }
})

app.post(`${I}/orders/:id/status`, async (req: FastifyRequest<{ Params: { id: string }; Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (b.status !== 'done' && b.status !== 'failed') return reply.code(400).send({ error: "status must be 'done' | 'failed'" })
  const o = w.setOrderStatus((req.params as P).id, b.status, b.note)
  if (!o) return reply.code(404).send({ error: 'unknown order' })
  broadcast(w.id, { t: 'missions', missions: w.missions })
  return { order: o }
})

app.post(`${I}/events`, async (req: FastifyRequest<{ Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  if (!b.type) return reply.code(400).send({ error: 'type required (register it under event-types first)' })
  const robot = b.robotSerial ? w.robots.find((r) => r.serial === b.robotSerial) : undefined
  // ingestEvent broadcasts through World.onEvent — no duplicate fan-out here
  const ev = w.ingestEvent({ ...b, robotId: robot?.id })
  if (!ev) return reply.code(400).send({ error: `unregistered event type '${b.type}'` })
  return { event: ev }
})

/** batch payload readings — the stable envelope; unknown metrics are skipped, not schema errors */
app.post(`${I}/robots/:serial/readings`, async (req: FastifyRequest<{ Params: { serial: string }; Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robots.find((r) => r.serial === req.params.serial && r.adapter === 'external')
  if (!robot) return reply.code(404).send({ error: 'robot not registered' })
  const items = Array.isArray((req.body as any)?.readings) ? (req.body as any).readings : []
  const accepted = w.ingestReadings(robot.id, items) // accepted readings broadcast via World.onReadings
  return { accepted, skipped: items.length - accepted, metrics: METRIC_DEFS.map((d) => d.id) }
})

/** ROS map_server-style occupancy upload: image is a base64 PNG data URL;
 *  origin = scene coords of the image's TOP-LEFT pixel, x→east, z→south
 *  (from a ROS map.yaml: originX stays, originZ = -(origin_y + height*resolution)) */
app.post(`${I}/maps`, async (req: FastifyRequest<{ Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as any
  const m = /^data:image\/png;base64,(.+)$/.exec(String(b.image ?? ''))
  if (!m || typeof b.resolution !== 'number' || !Array.isArray(b.origin) || b.origin.length < 2)
    return reply.code(400).send({ error: 'image (png data URL), resolution (m/px), origin [x,z] required' })
  const buf = Buffer.from(m[1], 'base64')
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452)
    return reply.code(400).send({ error: 'not a valid PNG' })
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (buf.length > 8 * 1024 * 1024) return reply.code(400).send({ error: 'map too large (8MB max)' })
  const uploadedAt = Date.now()
  const file = `${w.id}-${uploadedAt}.png`
  writeFileSync(join(MAPS_DIR, file), buf)
  const rec = {
    file,
    resolution: b.resolution,
    width,
    height,
    origin: [Number(b.origin[0]), Number(b.origin[1])] as [number, number],
    source: String(b.name ?? 'integration upload'),
    uploadedAt,
  }
  getConfig().sites[w.id].map = rec
  saveConfig()
  w.site.map = {
    image: `${PUB}/api/sites/${w.id}/map-image?v=${uploadedAt}`,
    resolution: rec.resolution,
    width,
    height,
    origin: rec.origin,
    source: rec.source,
  }
  broadcast(w.id, { t: 'site', site: w.site })
  return { map: w.site.map }
})

// ---------- simulation loops ----------

for (const w of worlds.values()) w.seedMissions()

// virtual Gosuncn service-patrol fleet joins Campus East via adapter semantics
import('./gosim.js').then(({ startGosim }) => {
  const campus = worlds.get('campus-east')
  if (campus) startGosim(campus)
})

let last = Date.now()
setInterval(() => {
  const now = Date.now()
  const dt = Math.min(0.5, (now - last) / 1000)
  last = now
  for (const w of worlds.values()) {
    const tel = w.tick(dt)
    broadcast(w.id, { t: 'tel', ts: now, data: tel })
  }
}, 250)

// mission/schedule state sync (assignments/completions/next-run countdowns) at 1 Hz
setInterval(() => {
  for (const w of worlds.values()) broadcast(w.id, { t: 'missions', missions: w.missions, schedules: w.schedules })
}, 1000)

function scheduleNextEvent(w: World) {
  const delay = 18_000 + Math.random() * 34_000
  setTimeout(async () => {
    try {
      const ev = await w.generateEvent()
      if (ev) broadcast(w.id, { t: 'event', event: ev })
    } catch (e) {
      console.error('[sim] event failed', e)
    }
    scheduleNextEvent(w)
  }, delay)
}

// ---------- boot ----------

const PORT = Number(process.env.API_PORT ?? 8787)
await app.listen({ port: PORT, host: process.env.API_HOST ?? '0.0.0.0' })
console.log(`[api] listening on :${PORT} · sites: ${[...worlds.keys()].join(', ')}`)

app.server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

setTimeout(() => {
  Promise.all([...worlds.values()].map((w) => w.seedEvents()))
    .then(() => {
      console.log('[sim] seeded event history')
      for (const w of worlds.values()) scheduleNextEvent(w)
    })
    .catch((e) => console.error('[sim] seed failed', e))
}, 6000)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0))
}
