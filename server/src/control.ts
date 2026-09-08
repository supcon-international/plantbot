/** Short-lived manual input is never put in the durable order queue. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from './db.js'
import { requireRole, requestUser } from './auth.js'
import type { World } from './world.js'

type Axes = Record<string, number>
type ControlSession = {
  id: string; siteId: string; robotId: string; target: 'drive' | 'ptz'; channelId?: string
  owner: string; tokenHash: string; status: 'starting' | 'active' | 'stopping' | 'closed' | 'failed'
  createdAt: number; updatedAt: number; expiresAt: number; sequence: number; clientSequence: number
  appliedSequence: number; note?: string
}
type Input = { axes: Axes; expiresAt: number }
const INPUT_MS = 400, LEASE_MS = 1500
const fail = (error: string, statusCode = 400): never => { throw Object.assign(new Error(error), { statusCode }) }
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const bodyOf = (req: FastifyRequest): Record<string, any> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return fail('JSON object required')
  return req.body as Record<string, any>
}
const publicSession = (s?: ControlSession) => {
  if (!s) return null
  const { tokenHash: _secret, ...visible } = s
  return visible
}

export function registerControl(app: FastifyInstance, worlds: Map<string, World>, integrationSite: (req: FastifyRequest, reply: FastifyReply) => World | null) {
  db.exec('CREATE TABLE IF NOT EXISTS control_sessions (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, robot_id TEXT NOT NULL, data TEXT NOT NULL)')
  const sessions = new Map<string, ControlSession>()
  const inputs = new Map<string, Input>()
  const poses = new Map<string, { pan: number; tilt: number; zoom: number; ts: number }>()
  const save = (s: ControlSession) => {
    s.updatedAt = Date.now()
    db.prepare('INSERT INTO control_sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(s.id, s.siteId, s.robotId, JSON.stringify(s))
  }
  const unfinished = (s: ControlSession) => s.status !== 'closed'
  const lock = (s: ControlSession) => {
    const w = worlds.get(s.siteId)
    if (!w) return
    w.controlLocks.set(s.robotId, s.id)
    if (s.channelId) w.ptzLocks.set(s.channelId, s.id)
  }
  const close = (s: ControlSession) => {
    s.status = 'closed'
    inputs.delete(s.id)
    const w = worlds.get(s.siteId)
    if (w?.controlLocks.get(s.robotId) === s.id) w.controlLocks.delete(s.robotId)
    if (s.channelId && w?.ptzLocks.get(s.channelId) === s.id) w.ptzLocks.delete(s.channelId)
    save(s)
  }
  const stop = (s: ControlSession, note: string) => {
    if (s.status === 'closed' || s.status === 'stopping' || s.status === 'failed') return
    s.status = 'stopping'; s.note = note; s.sequence++
    inputs.delete(s.id)
    save(s)
  }
  for (const row of db.prepare("SELECT data FROM control_sessions WHERE json_extract(data,'$.status') != 'closed'").all() as { data: string }[]) {
    const s = JSON.parse(row.data) as ControlSession
    s.status = 'stopping'; s.note = 'Platform restarted; waiting for adapter stop confirmation'; s.sequence++
    s.tokenHash = hash(randomBytes(32).toString('hex'))
    sessions.set(s.id, s); lock(s); save(s)
  }
  const current = (siteId: string, robotId: string) => [...sessions.values()].find(s => s.siteId === siteId && s.robotId === robotId && unfinished(s))
  const scope = (req: FastifyRequest) => {
    const p = req.params as Record<string, string>
    const w = worlds.get(p.siteId) ?? fail('site not loaded', 404)
    const robot = w.robots.find(r => r.id === p.robotId) ?? fail('robot not found', 404)
    return { p, w, robot }
  }
  const owned = (req: FastifyRequest) => {
    const { p, w, robot } = scope(req)
    const s = sessions.get(p.id)
    if (!s || s.siteId !== w.id || s.robotId !== robot.id) return fail('control session not found', 404)
    const supplied = req.headers['x-control-token']
    if (s.owner !== requestUser(req)?.username || typeof supplied !== 'string' || !timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(s.tokenHash, 'hex'))) return fail('control token required', 403)
    return { s, w, robot }
  }
  const expire = () => {
    for (const s of sessions.values()) {
      if (!unfinished(s)) { if (Date.now() - s.updatedAt > 60_000) sessions.delete(s.id); continue }
      if (!worlds.has(s.siteId)) { sessions.delete(s.id); inputs.delete(s.id); continue }
      lock(s)
      if (['active', 'starting'].includes(s.status) && s.expiresAt <= Date.now()) stop(s, 'Operator connection expired')
    }
  }
  const motionOrders = (w: World, robotId: string) => w.orders.filter(o => o.robotId === robotId && ['goto', 'mission', 'abort', 'pause', 'resume'].includes(o.kind) && ['pending', 'acked'].includes(o.state))
  const S = '/api/sites/:siteId/robots/:robotId/control'
  app.get(S, async req => {
    expire()
    const { w, robot } = scope(req)
    return { taskActive: motionOrders(w, robot.id).length > 0 || w.missions.some(m => m.robotId === robot.id && m.status === 'active'), session: publicSession(current(w.id, robot.id)), cameras: w.publicChannels().filter(c => c.robotId === robot.id).map(c => ({ ...c, position: poses.get(`${w.id}|${c.id}`) ?? null })) }
  })
  app.post(S, { preHandler: requireRole('operator') }, async (req, reply) => {
    expire()
    const { w, robot } = scope(req), b = bodyOf(req)
    if (current(w.id, robot.id)) return fail('Robot is already reserved; release the existing control session first', 409)
    const ext = w.externals.get(robot.id)
    if (!ext || Date.now() - ext.lastSeen > 2500) return fail('Fresh robot telemetry is required', 409)
    if (robot.integrationLevel !== 'dispatchable') return fail('Robot is read-only', 409)
    if (w.channels(robot.id).some(c => w.ptzLocks.has(c.id))) return fail('A camera patrol must be stopped before taking control', 409)
    const tasks = w.missions.filter(m => m.robotId === robot.id && m.status === 'active')
    const motions = motionOrders(w, robot.id)
    if ((tasks.length || motions.length) && b.interrupt !== true) return fail('Confirm ending the active task before taking control', 409)
    if (w.orders.some(o => o.robotId === robot.id && o.kind === 'ptz' && ['pending', 'acked'].includes(o.state))) return fail('Wait for camera movement to finish before taking control', 409)
    if (b.target !== 'drive' && b.target !== 'ptz') return fail('target must be drive or ptz')
    if (b.target === 'drive' && !robot.teleop) return fail('Adapter does not support manual driving', 409)
    if (b.target === 'ptz') {
      const c = w.channels(robot.id).find(c => c.id === b.channelId)
      if (!c?.ptz?.manual) return fail('Camera does not support manual positioning', 409)
      if (w.ptzLocks.has(c.id)) return fail('Camera is reserved by a patrol', 409)
    }
    const token = randomBytes(32).toString('hex'), now = Date.now()
    const s: ControlSession = { id: randomUUID(), siteId: w.id, robotId: robot.id, target: b.target,
      ...(b.target === 'ptz' ? { channelId: b.channelId } : {}), owner: requestUser(req)!.username,
      tokenHash: hash(token), status: 'starting', createdAt: now, updatedAt: now, expiresAt: now + 5000,
      sequence: 0, clientSequence: -1, appliedSequence: -1 }
    sessions.set(s.id, s); lock(s); save(s)
    // Reserve first, then cancel: the scheduler cannot dispatch between them.
    for (const task of tasks) w.abortMission(task.id)
    for (const order of motions) if (order.state === 'pending') w.setOrderStatus(order.id, 'failed', 'Cancelled for operator takeover')
    if (motions.some(o => o.state === 'acked' && ['goto', 'mission'].includes(o.kind)) && !w.orders.some(o => o.robotId === robot.id && o.kind === 'abort' && ['pending', 'acked'].includes(o.state))) w.enqueueOrder(robot.id, 'abort', {})
    return reply.code(201).send({ session: publicSession(s), token })
  })
  app.put(`${S}/:id/input`, { preHandler: requireRole('operator') }, async req => {
    const { s, robot } = owned(req), b = bodyOf(req)
    if (s.expiresAt <= Date.now()) stop(s, 'Operator connection expired')
    if (!['starting', 'active'].includes(s.status)) return fail('Control session is stopping or closed', 409)
    if (!Number.isSafeInteger(b.sequence) || b.sequence < 0 || b.sequence <= s.clientSequence) return fail('Stale input sequence', 409)
    if (!b.axes || typeof b.axes !== 'object' || Array.isArray(b.axes)) return fail('axes object required')
    const limits: Axes = s.target === 'drive'
      ? robot.teleop?.mode === 'direction' ? { forward: 1, lateral: 1, turn: 0 }
        : { forward: Math.min(robot.teleop?.forward ?? 0, 0.5), lateral: Math.min(robot.teleop?.lateral ?? 0, 0.3), turn: Math.min(robot.teleop?.turn ?? 0, 0.6) }
      : { pan: 1, tilt: 1, zoom: 1 }
    if (Object.keys(b.axes).some(k => !(k in limits))) return fail('Unsupported control axis')
    const axes: Axes = {}
    for (const [key, limit] of Object.entries(limits)) {
      const value = b.axes[key] ?? 0
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) return fail(`${key} exceeds the control limit`)
      axes[key] = value
    }
    if (s.status === 'starting' && Object.values(axes).some(Boolean)) return fail('Waiting for adapter readiness', 409)
    s.clientSequence = b.sequence; s.expiresAt = Date.now() + LEASE_MS; s.sequence++
    inputs.set(s.id, { axes, expiresAt: Date.now() + INPUT_MS })
    return { session: publicSession(s) }
  })
  app.delete(`${S}/:id`, { preHandler: requireRole('operator') }, async req => {
    const { s } = owned(req); stop(s, 'Control released by operator'); return { session: publicSession(s) }
  })
  app.post(`${S}/:id/stop`, { preHandler: requireRole('operator') }, async req => {
    const { p, w, robot } = scope(req)
    const s = sessions.get(p.id)
    if (!s || s.siteId !== w.id || s.robotId !== robot.id) return fail('control session not found', 404)
    stop(s, `Stop requested by ${requestUser(req)!.username}`)
    return { session: publicSession(s) }
  })
  const I = '/api/integration/v1/robots/:serial/control'
  app.get(I, async (req, reply) => {
    const w = integrationSite(req, reply)
    if (!w) return
    const robot = w.robotBySerial((req.params as any).serial) ?? fail('robot not registered', 404)
    expire()
    const s = current(w.id, robot.id)
    if (!s || motionOrders(w, robot.id).length) return { frame: null }
    const input = inputs.get(s.id)
    const remainingMs = Math.max(0, Math.min(INPUT_MS, (input?.expiresAt ?? 0) - Date.now()))
    return { frame: { id: s.id, sequence: s.sequence, target: s.target,
      channelId: s.channelId ? w.channels(robot.id).find(c => c.id === s.channelId)?.streamKey : undefined,
      status: s.status, axes: remainingMs > 0 && s.status === 'active' ? input!.axes : {}, remainingMs } }
  })
  app.post(I, async (req, reply) => {
    const w = integrationSite(req, reply)
    if (!w) return
    const robot = w.robotBySerial((req.params as any).serial) ?? fail('robot not registered', 404)
    const b = bodyOf(req), s = sessions.get(b.id)
    if (!s || s.siteId !== w.id || s.robotId !== robot.id) return fail('control session not found', 404)
    if (!Number.isSafeInteger(b.sequence) || b.sequence > s.sequence || b.sequence < s.appliedSequence) return fail('Stale control receipt', 409)
    if (!['ready', 'applied', 'stopped', 'failed'].includes(b.status)) return fail('Invalid receipt status')
    if (s.status === 'closed') return { ok: true }
    s.appliedSequence = b.sequence
    if (b.status === 'failed') {
      s.status = 'failed'; s.note = String(b.note ?? 'Adapter control failed').slice(0, 300); inputs.delete(s.id); save(s)
    } else if (b.status === 'stopped' && ['stopping', 'failed'].includes(s.status) && b.sequence === s.sequence) close(s)
    else if (b.status === 'ready' && s.status === 'starting') { s.status = 'active'; save(s) }
    if (b.position && s.channelId && ['pan', 'tilt', 'zoom'].every(k => Number.isFinite(b.position[k]))) {
      poses.set(`${w.id}|${s.channelId}`, { pan: b.position.pan, tilt: b.position.tilt, zoom: b.position.zoom, ts: Date.now() })
    }
    return { ok: true }
  })
  const timer = setInterval(expire, 100)
  timer.unref()
  return () => { clearInterval(timer); for (const s of sessions.values()) if (unfinished(s)) stop(s, 'Platform is shutting down') }
}
