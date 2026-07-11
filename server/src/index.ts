import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_SITES, type SiteDef } from './sites.js'
import { World, SNAP_DIR, EXTERNAL_STALE_MS, type SiteRuntime } from './world.js'
import {
  importLegacyConfig, sweepRetention, MAPS_DIR,
  bootUsers, listUsers, createUser, updateUser, deleteUser, roleFor, type Role,
  listApiKeys, newApiKey, deleteApiKey, findApiKey, seedApiKeys,
  listSiteRows, getSiteRow, createSiteRow, patchSiteRow, deleteSiteRow,
  loadGeometry, saveGeometry, listTransforms, saveTransform, deleteTransform,
  getSiteMap, saveSiteMap,
  listExternals, saveExternal, deleteExternal,
  listEventTypes, saveEventType, deleteEventTypeRec,
  makePersist, loadSiteOps, loadSeqs, queryReadings,
  type SiteRow, type ExternalRec,
} from './config.js'
import { requestUser, requireRole, issueSession, clearSession, login, loginThrottled, publicUser, PUBLIC_VIEW } from './auth.js'
import { ROBOT_CATALOG, METRIC_DEFS, type Command, type Waypoint, type Zone, type SiteCamera } from './fleet.js'
import { relayConfigured } from './media.js'
import type { DetectionRule, DetectionEvent, Mission, AdapterOrder } from './world.js'
import type { MissionTemplate, Schedule, Reading } from './fleet.js'

const PUB = process.env.PUBLIC_BASE ?? ''
const DEMO = process.env.PB_DEMO === '1'

// ---------- boot: durable store ----------

importLegacyConfig()
bootUsers()

// first boot with PB_DEMO=1 on an empty sites table → import the demo yards.
// Production starts empty; sites are created in the Site Builder.
const importedNow: string[] = []
if (DEMO && listSiteRows().length === 0) {
  for (const def of DEMO_SITES) {
    createSiteRow({
      id: def.id, name: def.name, operator: def.operator, bounds: def.bounds,
      dockWp: def.dockWp, splat: def.splat, buildings: def.buildings, mapMeta: def.map ?? undefined, demo: true,
    })
    saveGeometry(def.id, { waypoints: def.waypoints, zones: def.zones, cameras: def.cameras })
    for (const t of def.eventTypeSeeds ?? []) saveEventType(def.id, t)
    for (const t of def.transformSeeds ?? []) saveTransform(def.id, t)
    importedNow.push(def.id)
  }
  console.log(`[boot] demo sites imported: ${importedNow.join(', ')}`)
}

seedApiKeys(listSiteRows().map((s) => s.id))
sweepRetention()

// ---------- world lifecycle (sites are data — Worlds start and stop at runtime) ----------

const worlds = new Map<string, World>()
const rooms = new Map<string, Set<WebSocket>>()

function buildRuntime(row: SiteRow): SiteRuntime {
  const geo = loadGeometry(row.id)
  const uploaded = getSiteMap(row.id)
  return {
    id: row.id,
    name: row.name,
    operator: row.operator,
    bounds: row.bounds,
    dockWp: row.dockWp,
    splat: row.splat,
    buildings: row.buildings,
    map: uploaded
      ? {
          image: `${PUB}/api/sites/${row.id}/map-image?v=${uploaded.uploadedAt}`,
          resolution: uploaded.resolution,
          width: uploaded.width,
          height: uploaded.height,
          origin: uploaded.origin,
          source: uploaded.source,
        }
      : (row.mapMeta ?? null),
    transforms: listTransforms(row.id),
    ...geo,
  }
}

function startWorld(row: SiteRow, opts?: { fresh?: SiteDef }): World {
  const w = new World(buildRuntime(row), { persist: makePersist(row.id), demo: row.demo })
  worlds.set(w.id, w)
  rooms.set(w.id, rooms.get(w.id) ?? new Set())
  w.onEvent = (ev) => broadcast(w.id, { t: 'event', event: ev })
  w.onReadings = (batch) => broadcast(w.id, { t: 'readings', items: batch })
  if (opts?.fresh) {
    // first creation only — seeds persist through the write-through hooks
    for (const t of opts.fresh.eventTypeSeeds ?? []) w.addEventType(t)
    w.seedFromDef(opts.fresh)
  } else {
    for (const t of listEventTypes(row.id)) w.addEventType(t)
    const ops = loadSiteOps(row.id)
    w.hydrate(
      {
        rules: ops.rules as DetectionRule[],
        templates: ops.templates as MissionTemplate[],
        schedules: ops.schedules as Schedule[],
        missions: ops.missions as Mission[],
        events: ops.events as DetectionEvent[],
        orders: ops.orders as AdapterOrder[],
        readings: ops.readings as Reading[],
      },
      loadSeqs(row.id),
    )
  }
  for (const rec of listExternals(row.id)) w.registerExternal(rec)
  return w
}

for (const row of listSiteRows()) {
  startWorld(row, importedNow.includes(row.id) ? { fresh: DEMO_SITES.find((d) => d.id === row.id)! } : undefined)
}

const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024 })
// no CORS layer: dev runs same-origin behind the vite proxy, production
// same-origin behind nginx — cross-origin browsers have no business here
// demo footage served directly (Range-capable) — file channels play these
// loops; snapshots are cut from the same files (or straight from RTSP)
await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '..', 'media'),
  prefix: '/media/',
  cacheControl: true,
  maxAge: '1h',
})

// PB_PUBLIC_VIEW=0 → every browser API needs a session (integration API keeps
// its own Bearer auth; login/health/media stay open so the gate is escapable)
if (!PUBLIC_VIEW) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url
    if (!url.startsWith('/api/')) return
    if (url.startsWith('/api/auth/') || url.startsWith('/api/health') || url.startsWith('/api/integration/')) return
    if (requestUser(req)) return
    return reply.code(401).send({ error: 'sign in required', gated: true })
  })
}

// ---------- websocket (per-site rooms) ----------

const wss = new WebSocketServer({ noServer: true })

function broadcast(siteId: string, msg: unknown) {
  const s = JSON.stringify(msg)
  for (const c of rooms.get(siteId) ?? []) if (c.readyState === WebSocket.OPEN) c.send(s)
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', 'http://x')
  const siteId = url.searchParams.get('site') ?? ''
  const w = worlds.get(siteId)
  if (!w) {
    ws.close(4004, 'unknown site')
    return
  }
  rooms.get(siteId)!.add(ws)
  ws.send(JSON.stringify(helloFrame(w)))
  ws.on('close', () => rooms.get(siteId)?.delete(ws))
  ws.on('error', () => rooms.get(siteId)?.delete(ws))
})

function helloFrame(w: World) {
  return {
    t: 'hello',
    siteId: w.id,
    site: w.site,
    robots: w.robots,
    cameras: w.publicCameras(),
    waypoints: w.waypoints,
    zones: w.zones,
    buildings: w.buildings,
    dockWp: w.dockWp,
    events: w.listEvents(80),
    missions: w.missions,
    templates: w.templates,
    schedules: w.schedules,
    rules: w.rules,
    eventTypes: w.eventTypes,
    metricDefs: METRIC_DEFS,
    channels: w.publicChannels(),
    maps: w.maps(),
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
  if (!username || !password) return reply.code(401).send({ error: 'invalid credentials' })
  if (loginThrottled(req.ip, username))
    return reply.code(429).send({ error: 'too many attempts — locked for 15 minutes' })
  const u = login(req.ip, username, password)
  if (!u) return reply.code(401).send({ error: 'invalid credentials' })
  issueSession(req, reply, u.username)
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
    publicView: PUBLIC_VIEW,
    demo: DEMO,
    sites: listSiteRows().map((s) => ({ id: s.id, name: s.name, operator: s.operator, role: roleFor(u, s.id) })),
  }
})

// ---------- users (platform admin) ----------

const sanitizeUser = (u: { username: string; displayName: string; roles: Record<string, Role>; seeded?: boolean }) => ({
  username: u.username,
  displayName: u.displayName,
  roles: u.roles,
  seeded: !!u.seeded,
})

app.get('/api/users', { preHandler: requireRole('admin') }, async () => ({
  users: listUsers().map(sanitizeUser),
}))

app.post('/api/users', { preHandler: requireRole('admin') }, async (req, reply) => {
  const b = (req.body ?? {}) as { username?: string; displayName?: string; password?: string; roles?: Record<string, Role> }
  if (!b.username || !b.password || !b.roles) return reply.code(400).send({ error: 'username, password, roles required' })
  if (b.password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' })
  const u = createUser({ username: b.username, displayName: b.displayName, password: b.password, roles: b.roles })
  if (!u) return reply.code(409).send({ error: 'username taken or invalid' })
  return { user: sanitizeUser(u) }
})

app.patch('/api/users/:username', { preHandler: requireRole('admin') }, async (req, reply) => {
  const b = (req.body ?? {}) as { displayName?: string; roles?: Record<string, Role>; password?: string }
  if (b.password !== undefined && b.password.length < 8)
    return reply.code(400).send({ error: 'password must be at least 8 characters' })
  const u = updateUser((req.params as P).username, b)
  if (!u) return reply.code(404).send({ error: 'not found' })
  return { user: sanitizeUser(u) }
})

app.delete('/api/users/:username', { preHandler: requireRole('admin') }, async (req, reply) => {
  const me = requestUser(req)
  const target = (req.params as P).username
  if (me?.username === target) return reply.code(400).send({ error: 'cannot delete your own account' })
  if (!deleteUser(target)) return reply.code(400).send({ error: 'not found, or last remaining admin' })
  return { ok: true }
})

// ---------- global ----------

app.get('/api/health', async () => ({ ok: true, ts: Date.now(), demo: DEMO, relay: relayConfigured(), sites: [...worlds.keys()] }))

app.get('/api/sites', async (req) => {
  const u = requestUser(req)
  return {
    sites: listSiteRows().map((s) => {
      const w = worlds.get(s.id)
      return {
        id: s.id,
        name: s.name,
        operator: s.operator,
        role: roleFor(u, s.id),
        demo: s.demo,
        robots: w?.robots.length ?? 0,
        openAlerts: w?.events.filter((e) => e.lifecycle === 'new' && (e.severity === 'critical' || e.severity === 'high')).length ?? 0,
      }
    }),
  }
})

// ---------- site lifecycle (Site Builder) ----------

app.post('/api/sites', { preHandler: requireRole('admin') }, async (req, reply) => {
  const b = (req.body ?? {}) as { id?: string; name?: string; operator?: string; bounds?: { x: [number, number]; z: [number, number] } }
  if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' })
  const id = (b.id?.trim() || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  if (!id) return reply.code(400).send({ error: 'invalid id' })
  if (getSiteRow(id)) return reply.code(409).send({ error: `site '${id}' already exists` })
  const bounds = b.bounds ?? { x: [-20, 20] as [number, number], z: [-12, 12] as [number, number] }
  createSiteRow({ id, name: b.name.trim(), operator: b.operator?.trim() || 'Plantbot Operations', bounds, dockWp: '', buildings: [], demo: false })
  saveGeometry(id, { waypoints: [], zones: [], cameras: [] })
  const w = startWorld(getSiteRow(id)!)
  return { site: { id: w.id, name: w.site.name, operator: w.site.operator } }
})

app.patch(`/api/sites/:siteId/meta`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as { name?: string; operator?: string; bounds?: { x: [number, number]; z: [number, number] } }
  patchSiteRow(w.id, { name: b.name, operator: b.operator, bounds: b.bounds })
  if (b.name) w.site.name = b.name
  if (b.operator) w.site.operator = b.operator
  if (b.bounds) w.site.bounds = b.bounds
  broadcast(w.id, { t: 'site', site: w.site })
  return { site: w.site }
})

app.delete(`/api/sites/:siteId`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const row = getSiteRow(w.id)
  if (row?.demo && DEMO) return reply.code(400).send({ error: 'demo sites are rebuilt at boot — disable PB_DEMO to remove them' })
  for (const c of rooms.get(w.id) ?? []) c.close(4010, 'site deleted')
  rooms.delete(w.id)
  worlds.delete(w.id)
  deleteSiteRow(w.id)
  return { ok: true }
})

/** geometry save — the whole editable surface in one transaction, applied live */
app.put(`/api/sites/:siteId/geometry`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as { waypoints?: Waypoint[]; zones?: Zone[]; cameras?: SiteCamera[]; dockWp?: string; bounds?: { x: [number, number]; z: [number, number] } }
  const waypoints = Array.isArray(b.waypoints) ? b.waypoints : w.waypoints
  const zones = Array.isArray(b.zones) ? b.zones : w.zones
  const cameras = (Array.isArray(b.cameras) ? b.cameras : w.cameras).map((c) => ({
    ...c,
    stream: c.stream || c.id,
    live: !!c.rtsp,
    source: c.rtsp ? 'RTSP camera' : c.file ? 'NVR loop · demo footage' : '—',
  }))
  if (new Set(waypoints.map((x) => x.id)).size !== waypoints.length)
    return reply.code(400).send({ error: 'duplicate waypoint ids' })
  const dockWp = b.dockWp !== undefined ? b.dockWp : w.dockWp
  if (dockWp && !waypoints.some((x) => x.id === dockWp))
    return reply.code(400).send({ error: `dock waypoint '${dockWp}' is not in the waypoint list` })
  saveGeometry(w.id, { waypoints, zones, cameras })
  patchSiteRow(w.id, { dockWp, bounds: b.bounds })
  w.setGeometry({ waypoints, zones, cameras, dockWp, bounds: b.bounds })
  broadcast(w.id, { t: 'geo', site: w.site, waypoints, zones, cameras: w.publicCameras(), dockWp, channels: w.publicChannels() })
  return { ok: true, waypoints: waypoints.length, zones: zones.length, cameras: cameras.length }
})

/** occupancy upload (Site Builder) — same convention as the integration API */
app.post(`/api/sites/:siteId/map`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return uploadOccupancy(w, (req.body ?? {}) as Record<string, unknown>, reply)
})

// ---------- calibration transforms ----------

app.get(`/api/sites/:siteId/transforms`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { transforms: listTransforms(w.id) }
})

app.post(`/api/sites/:siteId/transforms`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const b = (req.body ?? {}) as { id?: string; from?: string; to?: string; params?: { s: number; thetaRad: number; t: [number, number] }; note?: string }
  if (!b.from || !b.to || !b.params || typeof b.params.s !== 'number')
    return reply.code(400).send({ error: 'from, to, params {s, thetaRad, t:[x,z]} required' })
  const id = (b.id?.trim() || `${b.from}->${b.to}`).toLowerCase().replace(/[^a-z0-9>_-]+/g, '-').slice(0, 48)
  saveTransform(w.id, { id, from: b.from, to: b.to, params: b.params, note: b.note })
  w.transforms = listTransforms(w.id)
  broadcast(w.id, { t: 'maps', maps: w.maps() })
  return { transform: { id, from: b.from, to: b.to, params: b.params, note: b.note } }
})

app.delete(`/api/sites/:siteId/transforms/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!deleteTransform(w.id, (req.params as P).id)) return reply.code(404).send({ error: 'not found' })
  w.transforms = listTransforms(w.id)
  broadcast(w.id, { t: 'maps', maps: w.maps() })
  return { ok: true }
})

// ---------- snapshots ----------

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
  // camera rtsp:// URLs embed credentials — only site admins (who edit them
  // in the Site Builder) get them back; everyone else gets the public shape
  const admin = roleFor(requestUser(req), w.id) === 'admin'
  const cameras = admin ? w.cameras : w.publicCameras()
  return { site: w.site, robots: w.robots, cameras, waypoints: w.waypoints, zones: w.zones, buildings: w.buildings, dockWp: w.dockWp }
})

app.get(`${S}/catalog`, async (req: FastifyRequest, reply) => {
  if (!world(req, reply)) return
  // integration catalog: the models with a vendor adapter — the connect
  // wizard renders these as an onboarding guide, nothing is created here
  return { models: ROBOT_CATALOG }
})

app.get(`${S}/map-image`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const rec = getSiteMap(w.id)
  if (!rec) return reply.code(404).send({ error: 'no uploaded map' })
  const p = join(MAPS_DIR, rec.file)
  if (!existsSync(p)) return reply.code(404).send({ error: 'map file missing' })
  reply.header('cache-control', 'public, max-age=604800')
  reply.type('image/png')
  return reply.send(readFileSync(p))
})

// -- fleet administration (units join via the integration API, not here) --

app.delete(`${S}/external-robots/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const robot = w.robots.find((r) => r.id === (req.params as P).id)
  if (!robot || !w.removeExternal((req.params as P).id)) return reply.code(404).send({ error: 'not found' })
  deleteExternal(w.id, robot.serial)
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { ok: true }
})

// -- channels + stream sessions (playback is a lease, not a getter) --

app.get(`${S}/channels`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { channels: w.publicChannels() }
})

app.get(`${S}/robots/:id/channels`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { channels: w.publicChannels((req.params as P).id) }
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
  const src = w.frameSource(ch.streamKey)
  if (!src) return reply.code(404).send({ error: 'channel has no snapshot source' })
  const { grabFrame } = await import('./frames.js')
  const frame = await grabFrame(src)
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
    // served from SQLite — survives restarts, bounded by retention (7 d)
    readings: queryReadings(w.id, robotId, q.metric || undefined, Number(q.since ?? 0), Number(q.limit ?? 200)),
  }
})

// -- events (lifecycle: new → acked → resolved | dismissed) --

app.get(`${S}/events`, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { events: w.listEvents(Number((req.query as any)?.limit ?? 120)) }
})

for (const [action, to] of [['ack', 'acked'], ['resolve', 'resolved'], ['dismiss', 'dismissed']] as const) {
  app.post(`${S}/events/:id/${action}`, { preHandler: requireRole('operator') }, async (req: FastifyRequest, reply) => {
    const w = world(req, reply)
    if (!w) return
    const ev = w.setLifecycle((req.params as P).id, to)
    if (!ev) return reply.code(404).send({ error: 'not found' })
    broadcast(w.id, { t: 'lifecycle', id: ev.id, lifecycle: ev.lifecycle })
    return { ok: true }
  })
}

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
  saveEventType(w.id, { id: t.id, label: t.label, severity: t.severity, detail: t.detail, category: t.category })
  broadcast(w.id, { t: 'eventTypes', eventTypes: w.eventTypes })
  return { eventType: t }
})

app.delete(`${S}/event-types/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!w.deleteEventType((req.params as P).id)) return reply.code(404).send({ error: 'not found or builtin' })
  deleteEventTypeRec(w.id, (req.params as P).id)
  broadcast(w.id, { t: 'eventTypes', eventTypes: w.eventTypes })
  return { ok: true }
})

// -- api keys (admin; the plaintext key appears exactly once, on creation) --

app.get(`${S}/api-keys`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { apiKeys: listApiKeys(w.id) }
})

app.post(`${S}/api-keys`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  return { apiKey: newApiKey(w.id, String(((req.body ?? {}) as any).label ?? '')) }
})

app.delete(`${S}/api-keys/:id`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  if (!deleteApiKey(w.id, (req.params as P).id)) return reply.code(404).send({ error: 'not found' })
  return { ok: true }
})

// -- integrations summary (admin panel) --

app.get(`${S}/integrations`, { preHandler: requireRole('admin') }, async (req: FastifyRequest, reply) => {
  const w = world(req, reply)
  if (!w) return
  const now = Date.now()
  return {
    apiKeys: listApiKeys(w.id),
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
          online: ext ? now - ext.lastSeen < EXTERNAL_STALE_MS : false,
          mode: ext?.mode,
        }
      }),
    orders: w.orders.slice(-30).reverse(),
    map: w.site.map,
    relay: relayConfigured(),
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

// -- commands (semantic, server-validated) --

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
  saveExternal(w.id, rec)
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  broadcast(w.id, { t: 'channels', channels: w.publicChannels() })
  return { robot: { id: robot.id, callsign: robot.callsign, integrationLevel: robot.integrationLevel } }
})

app.delete(`${I}/robots/:serial`, async (req: FastifyRequest<{ Params: { serial: string } }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robotBySerial(req.params.serial)
  if (!robot || !w.removeExternal(robot.id)) return reply.code(404).send({ error: 'not found' })
  deleteExternal(w.id, req.params.serial)
  broadcast(w.id, { t: 'fleet', robots: w.robots })
  return { ok: true }
})

app.post(`${I}/robots/:serial/state`, async (req: FastifyRequest<{ Params: { serial: string }; Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robotBySerial(req.params.serial)
  if (!robot) return reply.code(404).send({ error: 'robot not registered' })
  w.ingestState(robot.id, req.body ?? {})
  return { ok: true, ordersPending: w.orders.filter((o) => o.robotId === robot.id && o.state === 'pending').length }
})

app.get(`${I}/robots/:serial/orders`, async (req: FastifyRequest<{ Params: { serial: string } }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robotBySerial(req.params.serial)
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
  const robot = b.robotSerial ? w.robotBySerial(b.robotSerial) : undefined
  // ingestEvent broadcasts through World.onEvent — no duplicate fan-out here
  const ev = w.ingestEvent({ ...b, robotId: robot?.id })
  if (!ev) return reply.code(400).send({ error: `unregistered event type '${b.type}'` })
  return { event: ev }
})

/** batch payload readings — the stable envelope; unknown metrics are skipped, not schema errors */
app.post(`${I}/robots/:serial/readings`, async (req: FastifyRequest<{ Params: { serial: string }; Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const robot = w.robotBySerial(req.params.serial)
  if (!robot) return reply.code(404).send({ error: 'robot not registered' })
  const items = Array.isArray((req.body as any)?.readings) ? (req.body as any).readings : []
  const accepted = w.ingestReadings(robot.id, items) // accepted readings broadcast via World.onReadings
  return { accepted, skipped: items.length - accepted, metrics: METRIC_DEFS.map((d) => d.id) }
})

/** evidence-capture service: adapters reference a platform-registered frame
 *  source (their unit's stream key) and get back a hosted snapshot URL — no
 *  vendor-side transcoding needed to attach image evidence to events */
app.post(`${I}/snapshot`, async (req: FastifyRequest<{ Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  const stream = String((req.body as any)?.stream ?? '')
  if (!stream) return reply.code(400).send({ error: 'stream required' })
  const url = await w.missionSnapshot(stream, 'ADP')
  if (!url) return reply.code(404).send({ error: `no frame source for stream '${stream}'` })
  return { url }
})

/** ROS map_server-style occupancy upload: image is a base64 PNG data URL;
 *  origin = scene coords of the image's TOP-LEFT pixel, x→east, z→south
 *  (from a ROS map.yaml: originX stays, originZ = -(origin_y + height*resolution)) */
async function uploadOccupancy(w: World, b: Record<string, unknown>, reply: FastifyReply) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(b.image ?? ''))
  if (!m || typeof b.resolution !== 'number' || !Array.isArray(b.origin) || (b.origin as number[]).length < 2)
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
  const origin = [Number((b.origin as number[])[0]), Number((b.origin as number[])[1])] as [number, number]
  saveSiteMap(w.id, { file, resolution: b.resolution, width, height, origin, source: String(b.name ?? 'occupancy upload'), uploadedAt })
  w.site.map = {
    image: `${PUB}/api/sites/${w.id}/map-image?v=${uploadedAt}`,
    resolution: b.resolution,
    width,
    height,
    origin,
    source: String(b.name ?? 'occupancy upload'),
  }
  broadcast(w.id, { t: 'site', site: w.site })
  return { map: w.site.map }
}

app.post(`${I}/maps`, async (req: FastifyRequest<{ Body: any }>, reply) => {
  const w = integrationSite(req, reply)
  if (!w) return
  return uploadOccupancy(w, (req.body ?? {}) as Record<string, unknown>, reply)
})

// ---------- runtime loops ----------

// 4 Hz: fire schedules, dispatch queued runs, broadcast the telemetry snapshot
setInterval(() => {
  const now = Date.now()
  for (const w of worlds.values()) broadcast(w.id, { t: 'tel', ts: now, data: w.tick() })
}, 250)

// mission/schedule state sync (assignments/completions/next-run countdowns) at 1 Hz
setInterval(() => {
  for (const w of worlds.values()) broadcast(w.id, { t: 'missions', missions: w.missions, schedules: w.schedules })
}, 1000)

// hourly: retention sweeps + zombie-run watchdog
setInterval(() => {
  sweepRetention()
  for (const w of worlds.values()) w.sweepStaleRuns()
}, 3600_000)

// demo blood — only with PB_DEMO=1 and only on demo sites: a synthetic event
// stream driven by the enabled rules. Production events come exclusively from
// integrations and threshold detectors.
function scheduleNextEvent(w: World) {
  const delay = 18_000 + Math.random() * 34_000
  setTimeout(async () => {
    if (!worlds.has(w.id)) return // site deleted
    try {
      const ev = await w.generateEvent()
      if (ev) broadcast(w.id, { t: 'event', event: ev })
    } catch (e) {
      console.error('[demo] event failed', e)
    }
    scheduleNextEvent(w)
  }, delay)
}

if (DEMO) {
  // freshly imported demo sites get a backdated event history once (persisted)
  setTimeout(() => {
    Promise.all(
      importedNow.map((id) => {
        const def = DEMO_SITES.find((d) => d.id === id)
        const w = worlds.get(id)
        return def && w ? w.seedEvents(def.eventSeedMins) : Promise.resolve()
      }),
    ).catch((e) => console.error('[demo] seed failed', e))
  }, 6000)
  for (const w of worlds.values()) if (w.demo) scheduleNextEvent(w)
}

// ---------- boot ----------

const PORT = Number(process.env.API_PORT ?? 8787)
await app.listen({ port: PORT, host: process.env.API_HOST ?? '0.0.0.0' })
console.log(
  `[api] listening on :${PORT} · sites: ${[...worlds.keys()].join(', ') || '(none — create one in the Site Builder)'}` +
    ` · demo=${DEMO ? 'on' : 'off'} · publicView=${PUBLIC_VIEW ? 'on' : 'off'} · relay=${relayConfigured() ? 'on' : 'off'}`,
)

app.server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) {
    socket.destroy()
    return
  }
  if (!PUBLIC_VIEW && !requestUser({ headers: req.headers } as FastifyRequest)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0))
}
