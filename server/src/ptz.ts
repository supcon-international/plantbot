/** Site-owned camera presets and patrols. No camera motion is simulated here. */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db, inTx } from './db.js'
import { requireRole, requestUser } from './auth.js'
import type { World, AdapterOrder } from './world.js'
import type { Channel } from './fleet.js'

export interface PtzPose {
  pan: number
  tilt: number
  zoom: number
}
export interface PtzPreset extends PtzPose {
  id: string
  name: string
  channelId: string
  createdAt: number
  updatedAt: number
}
export type PtzCadence =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMin: number }
  | { kind: 'weekly'; days: number[]; at: string }
export interface PtzPlan {
  id: string
  name: string
  channelId: string
  steps: { presetId: string; dwellS: number }[]
  cadence: PtzCadence
  enabled: boolean
  nextRunAt?: number
  createdAt: number
  updatedAt: number
}
export interface PtzStep extends PtzPose {
  presetId?: string
  name: string
  dwellS: number
  orderId?: string
  sentAt?: number
  arrivedAt?: number
  completedAt?: number
  note?: string
}
export interface PtzRun {
  id: string
  planId?: string
  name: string
  channelId: string
  robotId: string
  by: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  mode: 'absolute' | 'relative' | 'home'
  interlocked?: boolean
  steps: PtzStep[]
  stepIndex: number
  startedAt: number
  endedAt?: number
  note?: string
}

type Table = 'ptz_presets' | 'ptz_plans' | 'ptz_runs'
for (const table of ['ptz_presets', 'ptz_plans', 'ptz_runs'])
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(site_id,id))`,
  )
db.exec("CREATE INDEX IF NOT EXISTS idx_ptz_run_state ON ptz_runs(site_id, json_extract(data,'$.status'))")
const list = <T>(table: Table, site: string, filter = '', limit = ''): T[] =>
  (
    db.prepare(`SELECT data FROM ${table} WHERE site_id=? ${filter} ORDER BY rowid DESC ${limit}`).all(site) as {
      data: string
    }[]
  ).map((r) => JSON.parse(r.data))
const get = <T>(table: Table, site: string, id: string): T | undefined => {
  const row = db.prepare(`SELECT data FROM ${table} WHERE site_id=? AND id=?`).get(site, id) as
    | { data: string }
    | undefined
  return row && JSON.parse(row.data)
}
const put = (table: Table, site: string, value: { id: string }) =>
  db
    .prepare(`INSERT INTO ${table} VALUES (?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET data=excluded.data`)
    .run(site, value.id, JSON.stringify(value))
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode })
}
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : fail('JSON object required')
const nameOf = (value: unknown) =>
  typeof value === 'string' && value.trim() && value.trim().length <= 100
    ? value.trim()
    : fail('name must contain 1–100 characters')
const finite = (value: unknown, min: number, max: number, label: string) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fail(`${label} must be between ${min} and ${max}`)
const channel = (w: World, id: unknown): Channel =>
  w.channels().find((c) => c.id === id && c.robotId) ?? fail('robot camera channel not found', 404)
function pose(b: Record<string, any>, ch: Channel): PtzPose {
  const caps = ch.ptz?.absolute ? ch.ptz : { pan: [-360, 360], tilt: [-180, 180], zoom: [1, 100] }
  return {
    pan: finite(b.pan, caps.pan[0], caps.pan[1], 'pan'),
    tilt: finite(b.tilt, caps.tilt[0], caps.tilt[1], 'tilt'),
    zoom: finite(b.zoom, caps.zoom[0], caps.zoom[1], 'zoom'),
  }
}
function cadence(value: unknown): PtzCadence {
  const c = object(value)
  if (c.kind === 'once') return { kind: 'once', at: finite(c.at, 1, 8.64e15, 'scheduled time') }
  if (c.kind === 'interval') return { kind: 'interval', everyMin: finite(c.everyMin, 1, 525600, 'interval minutes') }
  if (
    c.kind === 'weekly' &&
    typeof c.at === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(c.at) &&
    Array.isArray(c.days) &&
    c.days.length &&
    c.days.every((d: unknown) => Number.isInteger(d) && Number(d) >= 0 && Number(d) <= 6)
  )
    return { kind: 'weekly', at: c.at, days: [...new Set(c.days)] as number[] }
  return fail('valid once, interval or weekly cadence required')
}
/** Weekly times are explicitly UTC, independent of server/browser time zone. */
export function nextPtzRun(c: PtzCadence, now: number): number | undefined {
  if (c.kind === 'once') return c.at > now ? c.at : undefined
  if (c.kind === 'interval') return now + c.everyMin * 60_000
  const [hh, mm] = c.at.split(':').map(Number)
  for (let d = 0; d < 8; d++) {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() + d)
    date.setUTCHours(hh, mm, 0, 0)
    if (date.getTime() > now && c.days.includes(date.getUTCDay())) return date.getTime()
  }
}

export class PtzService {
  constructor(
    readonly worlds: Map<string, World>,
    readonly now = Date.now,
    readonly timeoutMs = 30_000,
  ) {
    // An interrupted camera motion is indeterminate. Fail it before adapter
    // polling starts, and never replay it as if arrival had been confirmed.
    for (const [site, w] of worlds)
      for (const run of list<PtzRun>('ptz_runs', site)) {
        if (run.status === 'running')
          this.finish(w, run, 'failed', 'Platform restarted; camera position must be verified before retrying', true)
        if (run.interlocked) w.ptzLocks.set(run.channelId, run.id)
      }
  }
  state(w: World) {
    return {
      channels: w
        .publicChannels()
        .filter((c) => c.robotId)
        .map((c) => ({ id: c.id, label: c.label, robotId: c.robotId, ptz: c.ptz })),
      presets: list<PtzPreset>('ptz_presets', w.id),
      plans: list<PtzPlan>('ptz_plans', w.id),
      runs: list<PtzRun>('ptz_runs', w.id, '', 'LIMIT 100'),
      interlocks: list<PtzRun>('ptz_runs', w.id, "AND json_extract(data,'$.interlocked')=1"),
      timezone: 'UTC',
    }
  }
  records(w: World, query: unknown) {
    const q = object(query),
      where = ['site_id=?'],
      args: (string | number)[] = [w.id]
    for (const key of ['since', 'until', 'before'] as const)
      if (q[key] !== undefined) {
        const n = Number(q[key])
        if (!Number.isSafeInteger(n) || n < 0) fail(`invalid ${key}`)
        where.push(
          key === 'before' ? 'rowid < ?' : `json_extract(data,'$.startedAt') ${key === 'since' ? '>=' : '<='} ?`,
        )
        args.push(n)
      }
    if (q.channelId) {
      where.push("json_extract(data,'$.channelId')=?")
      args.push(String(q.channelId))
    }
    const limit = q.limit === undefined ? 100 : finite(Number(q.limit), 1, 500, 'limit')
    if (!Number.isInteger(limit)) fail('limit must be an integer')
    const rows = db
      .prepare(`SELECT rowid,data FROM ptz_runs WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...args, limit + 1) as { rowid: number; data: string }[]
    return {
      runs: rows.slice(0, limit).map((r) => JSON.parse(r.data) as PtzRun),
      nextCursor: rows.length > limit ? rows[limit - 1].rowid : null,
    }
  }
  release(w: World, id: string, by: string) {
    const run = get<PtzRun>('ptz_runs', w.id, id) ?? fail('inspection record not found', 404)
    if (run.interlocked) {
      run.interlocked = false
      run.note = `${run.note ?? ''}; camera stop and position manually verified by ${by}`
      if (w.ptzLocks.get(run.channelId) === run.id) w.ptzLocks.delete(run.channelId)
      put('ptz_runs', w.id, run)
    }
    return run
  }
  preset(w: World, body: unknown, id?: string) {
    const b = object(body),
      old = id ? (get<PtzPreset>('ptz_presets', w.id, id) ?? fail('preset not found', 404)) : undefined
    const ch = channel(w, b.channelId)
    if (
      old &&
      old.channelId !== ch.id &&
      list<PtzPlan>('ptz_plans', w.id).some((p) => p.steps.some((s) => s.presetId === id))
    )
      fail('preset is used by a plan; keep its camera or remove the reference first', 409)
    if (!old && list('ptz_presets', w.id).length >= 500) fail('preset limit reached', 409)
    const rec: PtzPreset = {
      id: old?.id ?? randomUUID(),
      name: nameOf(b.name),
      channelId: ch.id,
      ...pose(b, ch),
      createdAt: old?.createdAt ?? this.now(),
      updatedAt: this.now(),
    }
    put('ptz_presets', w.id, rec)
    return rec
  }
  deletePreset(w: World, id: string) {
    if (!get('ptz_presets', w.id, id)) fail('preset not found', 404)
    if (list<PtzPlan>('ptz_plans', w.id).some((p) => p.steps.some((s) => s.presetId === id)))
      fail('preset is used by an inspection plan', 409)
    db.prepare('DELETE FROM ptz_presets WHERE site_id=? AND id=?').run(w.id, id)
  }
  plan(w: World, body: unknown, id?: string) {
    const b = object(body),
      old = id ? (get<PtzPlan>('ptz_plans', w.id, id) ?? fail('plan not found', 404)) : undefined
    const ch = channel(w, b.channelId),
      c = cadence(b.cadence)
    if (typeof b.enabled !== 'boolean') fail('enabled must be a boolean')
    if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 100) fail('plan needs 1–100 stops')
    const steps = b.steps.map((s: unknown) => {
      const stop = object(s),
        p = get<PtzPreset>('ptz_presets', w.id, String(stop.presetId))
      if (!p || p.channelId !== ch.id) fail('every preset must belong to the plan camera')
      return { presetId: p!.id, dwellS: finite(stop.dwellS, 1, 3600, 'dwell seconds') }
    })
    if (!old && list('ptz_plans', w.id).length >= 200) fail('plan limit reached', 409)
    if (b.enabled && !ch.ptz?.absolute) fail('adapter does not support absolute PTZ; save this plan disabled', 409)
    const unchanged = old && old.enabled === b.enabled && JSON.stringify(old.cadence) === JSON.stringify(c)
    const nextRunAt = b.enabled ? (unchanged ? old.nextRunAt : nextPtzRun(c, this.now())) : undefined
    if (b.enabled && !nextRunAt && !(old && unchanged)) fail('scheduled time must be in the future')
    const rec: PtzPlan = {
      id: old?.id ?? randomUUID(),
      name: nameOf(b.name),
      channelId: ch.id,
      steps,
      cadence: c,
      enabled: b.enabled,
      nextRunAt,
      createdAt: old?.createdAt ?? this.now(),
      updatedAt: this.now(),
    }
    put('ptz_plans', w.id, rec)
    return rec
  }
  deletePlan(w: World, id: string) {
    if (!get('ptz_plans', w.id, id)) fail('plan not found', 404)
    if (list<PtzRun>('ptz_runs', w.id).some((r) => r.planId === id && r.status === 'running'))
      fail('cancel the active inspection before deleting its plan', 409)
    db.prepare('DELETE FROM ptz_plans WHERE site_id=? AND id=?').run(w.id, id)
  }
  runPlan(w: World, id: string, by: string) {
    const plan = get<PtzPlan>('ptz_plans', w.id, id) ?? fail('plan not found', 404)
    const steps = plan.steps.map((s) => {
      const p = get<PtzPreset>('ptz_presets', w.id, s.presetId) ?? fail('preset no longer exists', 409)
      return { ...pose(p, channel(w, plan.channelId)), presetId: p.id, name: p.name, dwellS: s.dwellS }
    })
    return this.start(w, plan.channelId, plan.name, steps, by, 'absolute', plan.id)
  }
  runPreset(w: World, id: string, by: string) {
    const p = get<PtzPreset>('ptz_presets', w.id, id) ?? fail('preset not found', 404)
    return this.start(
      w,
      p.channelId,
      p.name,
      [{ ...pose(p, channel(w, p.channelId)), presetId: p.id, name: p.name, dwellS: 0 }],
      by,
    )
  }
  manual(w: World, value: unknown, by: string) {
    const b = object(value),
      ch = channel(w, b.channelId)
    if (!ch.ptz) fail('adapter does not declare PTZ control', 409)
    if (b.mode !== 'home')
      fail('directional movement is unavailable until the adapter verifies safe stop semantics', 409)
    if (ch.ptz!.absolute) fail('use an absolute preset for this adapter', 409)
    const p = {
      pan: finite(b.pan ?? 0, -90, 90, 'pan'),
      tilt: finite(b.tilt ?? 0, -90, 90, 'tilt'),
      zoom: finite(b.zoom ?? 0, -9, 9, 'zoom'),
    }
    return this.start(
      w,
      ch.id,
      b.mode === 'home' ? 'Camera reset' : 'Directional camera control',
      [{ ...p, name: 'Vendor command', dwellS: 0 }],
      by,
      b.mode,
    )
  }
  private start(
    w: World,
    channelId: string,
    name: string,
    steps: PtzStep[],
    by: string,
    mode: PtzRun['mode'] = 'absolute',
    planId?: string,
  ) {
    const ch = channel(w, channelId)
    if (mode === 'absolute' && !ch.ptz?.absolute) fail('adapter does not support absolute PTZ positioning', 409)
    if (
      w.ptzLocks.has(ch.id) ||
      w.orders.some(
        (o) =>
          o.kind === 'ptz' &&
          o.robotId === ch.robotId &&
          o.payload.channelId === (ch.streamKey ?? ch.id) &&
          (o.state === 'pending' || o.state === 'acked'),
      )
    )
      fail('camera is busy; finish or cancel its current control first', 409)
    const run: PtzRun = {
      id: randomUUID(),
      planId,
      name,
      channelId,
      robotId: ch.robotId!,
      by,
      status: 'running',
      mode,
      steps,
      stepIndex: 0,
      startedAt: this.now(),
    }
    w.ptzLocks.set(channelId, run.id)
    inTx(() => {
      put('ptz_runs', w.id, run)
      this.advance(w, run)
    })
    return run
  }
  cancel(w: World, id: string) {
    const run = get<PtzRun>('ptz_runs', w.id, id) ?? fail('inspection record not found', 404)
    if (run.status === 'running')
      this.finish(
        w,
        run,
        'cancelled',
        'Further stops cancelled; a command already delivered to the camera cannot be physically recalled',
      )
    return run
  }
  private finish(w: World, run: PtzRun, status: PtzRun['status'], note?: string, recovering = false) {
    const step = run.steps[run.stepIndex]
    const order = step?.orderId ? this.order(w, step.orderId) : undefined
    if (order?.state === 'acked' || (recovering && step?.orderId && !step.arrivedAt)) run.interlocked = true
    if (order && (order.state === 'pending' || order.state === 'acked')) w.setOrderStatus(order.id, 'failed', note)
    run.status = status
    run.endedAt = this.now()
    run.note = note
    if (!run.interlocked && w.ptzLocks.get(run.channelId) === run.id) w.ptzLocks.delete(run.channelId)
    if (run.interlocked) w.ptzLocks.set(run.channelId, run.id)
    put('ptz_runs', w.id, run)
  }
  private order(w: World, id: string): AdapterOrder | undefined {
    const live = w.orders.find((o) => o.id === id)
    if (live) return live
    // A busy site can evict a done receipt between two patrol ticks. Read the
    // durable order before concluding it disappeared, preserving that receipt.
    const row = db.prepare('SELECT data FROM orders WHERE site_id=? AND id=?').get(w.id, id) as
      | { data: string }
      | undefined
    return row ? (JSON.parse(row.data) as AdapterOrder) : undefined
  }
  private advance(w: World, run: PtzRun) {
    const step = run.steps[run.stepIndex],
      now = this.now()
    if (!step) {
      this.finish(w, run, 'done')
      return
    }
    if (!step.orderId) {
      const command = w.command(
        run.robotId,
        { type: 'ptz', channelId: run.channelId, mode: run.mode, pan: step.pan, tilt: step.tilt, zoom: step.zoom },
        run.by,
        run.id,
      )
      if (!command.accepted || !command.orderId) {
        this.finish(w, run, 'failed', command.reason ?? 'camera command rejected')
        return
      }
      step.orderId = command.orderId
      step.sentAt = now
      put('ptz_runs', w.id, run)
      return
    }
    // Arrival is durable in the run. The hot order ring may evict a completed
    // order during a long dwell, which must not revoke its confirmed arrival.
    if (step.arrivedAt === undefined) {
      const order = this.order(w, step.orderId)
      if (!order) {
        this.finish(w, run, 'failed', 'camera order is no longer available')
        return
      }
      if (order.state === 'failed') {
        step.note = order.note
        this.finish(w, run, 'failed', order.note ?? 'adapter reported camera failure')
        return
      }
      if (order.state !== 'done') {
        if (now - step.sentAt! >= this.timeoutMs)
          this.finish(w, run, 'failed', 'Timed out waiting for adapter arrival acknowledgement')
        return
      }
      // Dwell begins at the receipt, never at enqueue or pull/ack time.
      step.arrivedAt = now
      step.note = order.note
      put('ptz_runs', w.id, run)
    }
    if (now < step.arrivedAt + step.dwellS * 1000) return
    step.completedAt = now
    run.stepIndex++
    put('ptz_runs', w.id, run)
    this.advance(w, run)
  }
  tick() {
    for (const w of this.worlds.values()) {
      for (const run of list<PtzRun>('ptz_runs', w.id, "AND json_extract(data,'$.status')='running'"))
        inTx(() => this.advance(w, run))
      for (const plan of list<PtzPlan>('ptz_plans', w.id))
        if (plan.enabled && plan.nextRunAt && plan.nextRunAt <= this.now()) {
          // Never overlap or catch up missed intervals with a burst of moves.
          if (w.ptzLocks.has(plan.channelId)) continue
          inTx(() => {
            try {
              this.runPlan(w, plan.id, 'schedule')
            } catch (error) {
              const ch = w.channels().find((c) => c.id === plan.channelId)
              put('ptz_runs', w.id, {
                id: randomUUID(),
                planId: plan.id,
                name: plan.name,
                channelId: plan.channelId,
                robotId: ch?.robotId ?? '',
                by: 'schedule',
                status: 'failed',
                mode: 'absolute',
                steps: [],
                stepIndex: 0,
                startedAt: this.now(),
                endedAt: this.now(),
                note: (error as Error).message,
              } as PtzRun)
            }
            plan.nextRunAt = nextPtzRun(plan.cadence, this.now())
            if (plan.cadence.kind === 'once') plan.enabled = false
            put('ptz_plans', w.id, plan)
          })
        }
    }
  }
}

export function registerPtz(app: FastifyInstance, worlds: Map<string, World>) {
  const service = new PtzService(worlds),
    prefix = '/api/sites/:siteId/ptz'
  const w = (req: FastifyRequest) =>
    worlds.get((req.params as { siteId: string }).siteId) ?? fail('site not loaded', 404)
  const id = (req: FastifyRequest) => (req.params as { id: string }).id
  const by = (req: FastifyRequest) => requestUser(req)?.username ?? 'operator'
  app.get(prefix, { preHandler: requireRole('viewer') }, async (req) => service.state(w(req)))
  app.get(`${prefix}/runs`, { preHandler: requireRole('viewer') }, async (req) => service.records(w(req), req.query))
  app.post(`${prefix}/runs/:id/release`, { preHandler: requireRole('operator') }, async (req) => {
    if (object(req.body).confirmedStopped !== true) fail('confirm camera has stopped before releasing control')
    return { run: service.release(w(req), id(req), by(req)) }
  })
  app.post(`${prefix}/presets`, { preHandler: requireRole('operator') }, async (req) => ({
    preset: service.preset(w(req), req.body),
  }))
  app.put(`${prefix}/presets/:id`, { preHandler: requireRole('operator') }, async (req) => ({
    preset: service.preset(w(req), req.body, id(req)),
  }))
  app.delete(`${prefix}/presets/:id`, { preHandler: requireRole('operator') }, async (req) => {
    service.deletePreset(w(req), id(req))
    return { ok: true }
  })
  app.post(`${prefix}/presets/:id/recall`, { preHandler: requireRole('operator') }, async (req) => ({
    run: service.runPreset(w(req), id(req), by(req)),
  }))
  app.post(`${prefix}/plans`, { preHandler: requireRole('operator') }, async (req) => ({
    plan: service.plan(w(req), req.body),
  }))
  app.put(`${prefix}/plans/:id`, { preHandler: requireRole('operator') }, async (req) => ({
    plan: service.plan(w(req), req.body, id(req)),
  }))
  app.delete(`${prefix}/plans/:id`, { preHandler: requireRole('operator') }, async (req) => {
    service.deletePlan(w(req), id(req))
    return { ok: true }
  })
  app.post(`${prefix}/plans/:id/run`, { preHandler: requireRole('operator') }, async (req) => ({
    run: service.runPlan(w(req), id(req), by(req)),
  }))
  app.post(`${prefix}/manual`, { preHandler: requireRole('operator') }, async (req) => ({
    run: service.manual(w(req), req.body, by(req)),
  }))
  app.post(`${prefix}/runs/:id/cancel`, { preHandler: requireRole('operator') }, async (req) => ({
    run: service.cancel(w(req), id(req)),
  }))
  const timer = setInterval(() => {
    try {
      service.tick()
    } catch (error) {
      app.log.error(error, 'PTZ inspection tick failed')
    }
  }, 500)
  timer.unref()
  const stop = () => clearInterval(timer)
  app.addHook('onClose', async () => stop())
  return stop
}
