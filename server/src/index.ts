import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROBOTS, SITE, SITE_CAMERAS, WAYPOINTS, ZONES, BUILDINGS } from './fleet.js'
import { startGo2rtc, stopGo2rtc } from './go2rtc.js'
import {
  tick,
  listEvents,
  ackEvent,
  generateEvent,
  seedEvents,
  SNAP_DIR,
  rules,
  createRule,
  patchRule,
  deleteRule,
  missionSnapshot,
} from './sim.js'
import { missions, createMission, abortMission, teleopGoto, seedMissions, grabSnapshotHook, nav } from './missions.js'

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })
// loop-demo footage served directly (Range-capable) — smooth playback,
// no transcode hop; the public RTSP feed still rides go2rtc/MSE
await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '..', 'media'),
  prefix: '/media/',
  cacheControl: true,
  maxAge: '1h',
})

app.get('/api/health', async () => ({ ok: true, ts: Date.now() }))

app.get('/api/fleet', async () => ({
  site: SITE,
  robots: ROBOTS,
  cameras: SITE_CAMERAS,
  waypoints: WAYPOINTS,
  zones: ZONES,
  buildings: BUILDINGS,
}))

// ---------- events ----------

app.get<{ Querystring: { limit?: string } }>('/api/events', async (req) => ({
  events: listEvents(Number(req.query.limit ?? 120)),
}))

app.post<{ Params: { id: string } }>('/api/events/:id/ack', async (req, reply) => {
  const ev = ackEvent(req.params.id)
  if (!ev) return reply.code(404).send({ error: 'not found' })
  broadcast({ t: 'ack', id: ev.id })
  return { ok: true }
})

app.get<{ Params: { file: string } }>('/api/snapshots/:file', async (req, reply) => {
  const file = req.params.file.replace(/[^A-Za-z0-9._-]/g, '')
  const p = join(SNAP_DIR, file)
  if (!existsSync(p)) return reply.code(404).send({ error: 'not found' })
  reply.header('cache-control', 'public, max-age=3600')
  reply.type('image/jpeg')
  return reply.send(readFileSync(p))
})

// ---------- rules ----------

app.get('/api/rules', async () => ({ rules }))

app.post<{ Body: any }>('/api/rules', async (req, reply) => {
  const b = (req.body ?? {}) as any
  if (!b.name || !b.model || !b.source) return reply.code(400).send({ error: 'name, model, source required' })
  const rule = createRule(b)
  broadcast({ t: 'rules', rules })
  return { rule }
})

app.patch<{ Params: { id: string }; Body: any }>('/api/rules/:id', async (req, reply) => {
  const r = patchRule(req.params.id, req.body ?? {})
  if (!r) return reply.code(404).send({ error: 'not found' })
  broadcast({ t: 'rules', rules })
  return { rule: r }
})

app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
  if (!deleteRule(req.params.id)) return reply.code(404).send({ error: 'not found or builtin' })
  broadcast({ t: 'rules', rules })
  return { ok: true }
})

// ---------- missions ----------

app.get('/api/missions', async () => ({ missions }))

app.post<{ Body: any }>('/api/missions', async (req, reply) => {
  const b = (req.body ?? {}) as any
  if (!b.name || !Array.isArray(b.steps) || !b.steps.length)
    return reply.code(400).send({ error: 'name and steps[] required' })
  const m = createMission({
    name: b.name,
    priority: b.priority ?? 2,
    requestedRobot: b.requestedRobot ?? 'auto',
    recurring: !!b.recurring,
    steps: b.steps,
  })
  broadcast({ t: 'missions', missions })
  return { mission: m }
})

app.post<{ Params: { id: string } }>('/api/missions/:id/abort', async (req, reply) => {
  const m = abortMission(req.params.id)
  if (!m) return reply.code(404).send({ error: 'not found' })
  broadcast({ t: 'missions', missions })
  return { mission: m }
})

app.post<{ Params: { id: string }; Body: any }>('/api/robots/:id/goto', async (req, reply) => {
  const { x, z } = (req.body ?? {}) as { x?: number; z?: number }
  if (typeof x !== 'number' || typeof z !== 'number') return reply.code(400).send({ error: 'x,z required' })
  if (!teleopGoto(req.params.id, x, z)) return reply.code(404).send({ error: 'unknown robot' })
  return { ok: true }
})

// ---------- websocket ----------

const wss = new WebSocketServer({ noServer: true })
const clients = new Set<WebSocket>()

function broadcast(msg: unknown) {
  const s = JSON.stringify(msg)
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s)
}

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(
    JSON.stringify({
      t: 'hello',
      site: SITE,
      robots: ROBOTS,
      cameras: SITE_CAMERAS,
      waypoints: WAYPOINTS,
      zones: ZONES,
      buildings: BUILDINGS,
      events: listEvents(80),
      missions,
      rules,
    }),
  )
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

// ---------- simulation loops ----------

grabSnapshotHook(missionSnapshot)
for (const r of ROBOTS) {
  const s = nav.get(r.id)
  if (s)
    s.onResult = (m, res) => broadcast({ t: 'missionResult', missionId: m.id, result: res, missions })
}
seedMissions()

let last = Date.now()
setInterval(() => {
  const now = Date.now()
  const dt = Math.min(0.5, (now - last) / 1000)
  last = now
  const tel = tick(dt)
  broadcast({ t: 'tel', ts: now, data: tel })
}, 250)

// mission list state sync (assignments/completions) at 1 Hz
setInterval(() => broadcast({ t: 'missions', missions }), 1000)

function scheduleNextEvent() {
  const delay = 18_000 + Math.random() * 34_000
  setTimeout(async () => {
    try {
      const ev = await generateEvent()
      if (ev) broadcast({ t: 'event', event: ev })
    } catch (e) {
      console.error('[sim] event failed', e)
    }
    scheduleNextEvent()
  }, delay)
}

// ---------- boot ----------

startGo2rtc()

const PORT = Number(process.env.API_PORT ?? 8787)
await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`[api] listening on :${PORT}`)

app.server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

// go2rtc needs a few seconds before frame grabs succeed
setTimeout(() => {
  seedEvents()
    .then(() => {
      console.log('[sim] seeded event history')
      scheduleNextEvent()
    })
    .catch((e) => console.error('[sim] seed failed', e))
}, 6000)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopGo2rtc()
    process.exit(0)
  })
}
