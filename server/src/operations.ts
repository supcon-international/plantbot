// Durable inspection archives and lightweight organization metadata. Permissions
// remain the platform's three roles × sites; directory membership grants no access.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db } from './db.js'
import { getSiteRow, getUser, listUsers } from './config.js'
import { requestUser, readSession, requireRole } from './auth.js'
import type { World, Mission, DetectionEvent } from './world.js'
import type { Schedule } from './fleet.js'

const DAY = 86_400_000
const statuses = ['queued', 'active', 'done', 'failed', 'aborted']
const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const number = (v: unknown, fallback: number) => (v === undefined ? fallback : Number(v))
const integer = (v: unknown, fallback: number, max: number) =>
  Math.min(max, Math.max(0, Math.floor(number(v, fallback)) || 0))
const blobs = <T>(rows: unknown) => (rows as { data: string }[]).map((r) => JSON.parse(r.data) as T)
export const escapeHTML = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
export const csvCell = (v: unknown) => {
  let s = String(v ?? '')
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}
const csv = (rows: unknown[][]) => '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
const stamp = (ts?: number) => (ts ? new Date(ts).toISOString() : '')

export function initOperations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_units (
      id TEXT PRIMARY KEY, data TEXT NOT NULL,
      site_id TEXT REFERENCES sites(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS organization_members (
      username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, site_id TEXT,
      target TEXT NOT NULL, status INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_missions_archive ON missions(site_id, created_at);
  `)
}

type Unit = {
  id: string
  name: string
  kind: 'factory' | 'department' | 'position'
  parentId?: string
  siteId?: string
}
type Membership = { username: string; departmentId?: string; positionId?: string }
const units = () =>
  (
    db.prepare('SELECT id, data, site_id FROM organization_units ORDER BY id').all() as {
      id: string
      data: string
      site_id: string | null
    }[]
  ).map((r) => ({ ...JSON.parse(r.data), siteId: r.site_id ?? undefined }) as Unit)
const members = () => blobs<Membership>(db.prepare('SELECT data FROM organization_members').all())
function range(q: Record<string, unknown>, maxDays?: number): { from: number; to: number } | null {
  const from = number(q.from, Date.now() - 30 * DAY)
  const to = number(q.to, Date.now() + DAY)
  return Number.isFinite(from) &&
    Number.isFinite(to) &&
    from >= 0 &&
    to > from &&
    (!maxDays || to - from <= maxDays * DAY)
    ? { from, to }
    : null
}
export function missionArchive(
  siteId: string,
  from: number,
  to: number,
  status: string,
  offset: number,
  limit: number,
) {
  const where = 'site_id=? AND created_at>=? AND created_at<?' + (status ? ' AND status=?' : '')
  const args = status ? [siteId, from, to, status] : [siteId, from, to]
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE ${where}`).get(...args) as { n: number }).n
  const missions = blobs<Mission>(
    db
      .prepare(`SELECT data FROM missions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset),
  )
  return { missions, total, offset, limit }
}
function archivedRun(siteId: string, id: string) {
  const row = db.prepare('SELECT data FROM missions WHERE site_id=? AND id=?').get(siteId, id) as
    | { data: string }
    | undefined
  return row ? (JSON.parse(row.data) as Mission) : null
}
export function missionEvents(siteId: string, id: string) {
  return blobs<DetectionEvent>(
    db
      .prepare("SELECT data FROM events WHERE site_id=? AND json_extract(data, '$.runId')=? ORDER BY ts")
      .all(siteId, id),
  )
}

export function reportCSV(siteName: string, m: Mission, events: DetectionEvent[]) {
  const rows: unknown[][] = [
    [
      'record_type',
      'site',
      'run_id',
      'name',
      'status',
      'robot',
      'schedule',
      'template',
      'priority',
      'created_at',
      'started_at',
      'ended_at',
      'step',
      'waypoint',
      'action',
      'timestamp',
      'result',
      'note',
      'evidence',
    ],
  ]
  const base = [
    siteName,
    m.id,
    m.name,
    m.status,
    m.robotId ?? m.requestedRobot,
    m.scheduleId,
    m.templateId,
    m.priority,
    stamp(m.createdAt),
    stamp(m.startedAt),
    stamp(m.endedAt),
  ]
  rows.push(['run', ...base, '', '', '', '', '', '', ''])
  m.steps.forEach((s, i) =>
    s.actions.forEach((a) =>
      rows.push(['planned_action', ...base, i + 1, s.waypointId, a.type, '', '', `${a.durationS}s`, '']),
    ),
  )
  m.results.forEach((r) =>
    rows.push([
      'result',
      ...base,
      r.stepIdx + 1,
      r.waypointId,
      r.action,
      stamp(r.ts),
      r.ok ? 'pass' : 'flagged',
      r.note,
      r.snapshot,
    ]),
  )
  events.forEach((e) =>
    rows.push([
      'event',
      ...base,
      '',
      e.zone,
      e.type,
      stamp(e.ts),
      `${e.severity}/${e.lifecycle}`,
      `${e.id}: ${e.label} — ${e.detail}`,
      e.evidence
        .map((x) => x.url ?? '')
        .filter(Boolean)
        .join(' | '),
    ]),
  )
  return csv(rows)
}
export function reportHTML(siteName: string, m: Mission, events: DetectionEvent[]) {
  const h = escapeHTML
  const table = (heads: string[], rows: unknown[][]) =>
    `<table><thead><tr>${heads.map((x) => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((x) => `<td>${h(x)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${heads.length}">No records / 暂无记录</td></tr>`}</tbody></table>`
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(m.id)} · Inspection report</title><style>body{font:14px/1.5 Arial,sans-serif;color:#171717;margin:40px auto;max-width:1080px;padding:0 24px}h1{font-size:26px;margin-bottom:4px}h2{font-size:18px;margin-top:28px}table{border-collapse:collapse;width:100%;margin:12px 0;table-layout:fixed}th,td{border:1px solid #bbb;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eee}.muted{color:#666;font-size:12px}@media print{body{margin:0;padding:0;font-size:10px}h2{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}.hint{display:none}@page{size:A4 landscape;margin:12mm}}</style><h1>Inspection report / 巡检报告</h1><div>${h(siteName)} · ${h(m.id)} · ${h(m.name)}</div><p class="muted hint">Print with your browser to save as PDF / 使用浏览器打印可保存为 PDF。All times UTC / 时间均为 UTC。</p>${table(['Status / 状态', 'Robot / 机器人', 'Schedule / 排程', 'Template / 模板', 'Created / 创建', 'Started / 开始', 'Ended / 结束'], [[m.status, m.robotId ?? m.requestedRobot, m.scheduleId, m.templateId, stamp(m.createdAt), stamp(m.startedAt), stamp(m.endedAt)]])}<h2>Planned inspection / 巡检计划</h2>${table(
    ['Step / 步骤', 'Waypoint / 点位', 'Actions / 动作'],
    m.steps.map((s, i) => [i + 1, s.waypointId, s.actions.map((a) => `${a.type} (${a.durationS}s)`).join(', ')]),
  )}<h2>Recorded results / 执行结果</h2>${table(
    [
      'Time / 时间',
      'Step / 步骤',
      'Waypoint / 点位',
      'Action / 动作',
      'Result / 结果',
      'Note / 说明',
      'Evidence / 证据',
    ],
    m.results.map((r) => [
      stamp(r.ts),
      r.stepIdx + 1,
      r.waypointId,
      r.action,
      r.ok ? 'Pass / 正常' : 'Flagged / 异常',
      r.note,
      r.snapshot,
    ]),
  )}<h2>Linked events / 关联事件</h2>${table(
    ['Time / 时间', 'Event / 事件', 'Severity / 等级', 'Status / 状态', 'Detail / 详情', 'Evidence / 证据'],
    events.map((e) => [
      stamp(e.ts),
      `${e.id}: ${e.label}`,
      e.severity,
      e.lifecycle,
      e.detail,
      e.evidence
        .map((x) => x.url ?? '')
        .filter(Boolean)
        .join(', '),
    ]),
  )}<p class="muted">Generated / 生成于 ${h(stamp(Date.now()))}. The report contains recorded data; missing results remain missing. 报告仅包含实际记录，未收到的结果不推断为成功。</p></html>`
}

export type CalendarEntry = {
  id: string
  kind: 'planned' | 'actual'
  at: number
  name: string
  scheduleId?: string
  runId?: string
  status?: string
  robot?: string
}
export function plannedCalendar(
  schedules: Schedule[],
  templates: { id: string; name: string }[],
  from: number,
  to: number,
  now = Date.now(),
) {
  const entries: CalendarEntry[] = []
  let truncated = false
  for (const s of schedules) {
    if (!s.enabled || !s.nextRunAt) continue
    const minimum = Math.max(from, now)
    let at = s.nextRunAt
    if (s.cadence.kind === 'interval' && s.cadence.everyMin > 0 && at < minimum)
      at += Math.ceil((minimum - at) / (s.cadence.everyMin * 60_000)) * s.cadence.everyMin * 60_000
    while (at < to) {
      if (at >= minimum) {
        if (entries.length >= 5000) {
          truncated = true
          break
        }
        entries.push({
          id: `${s.id}:${at}`,
          kind: 'planned',
          at,
          name: templates.find((t) => t.id === s.templateId)?.name ?? s.templateId,
          scheduleId: s.id,
          robot: s.assign.kind === 'robot' ? s.assign.robotId : 'auto',
        })
      }
      if (s.cadence.kind === 'once') break
      if (s.cadence.kind === 'interval') {
        const next = at + s.cadence.everyMin * 60_000
        if (!(next > at)) break
        at = next
      } else {
        const prior = at
        const [hh, mm] = s.cadence.at.split(':').map(Number)
        for (let d = 0; d < 8; d++) {
          const next = new Date(prior)
          next.setDate(next.getDate() + d)
          next.setHours(hh, mm, 0, 0)
          if (next.getTime() > prior && s.cadence.days.includes(next.getDay())) {
            at = next.getTime()
            break
          }
        }
        if (at === prior) break
      }
    }
  }
  return { entries, truncated }
}

export function registerOperations(app: FastifyInstance, worlds: Map<string, World>) {
  initOperations()
  const actor = new WeakMap<FastifyRequest, string>()
  app.addHook('onRequest', async (req) => {
    const u = requestUser(req)
    if (u) actor.set(req, u.username)
  })
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? ''
    const auth = route.startsWith('/api/auth/') && !route.endsWith('/me')
    const mutation =
      (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || route.endsWith('/report')) &&
      route.startsWith('/api/') &&
      !route.startsWith('/api/integration/')
    if (route.endsWith('/control/:id/input')) return // high-rate input; lease acquisition/release remain audited
    if (!auth && !mutation) return
    const p = (req.params ?? {}) as Record<string, unknown>
    const body = (req.body ?? {}) as Record<string, unknown>
    const cookie = reply.getHeader('set-cookie')
    const issued = typeof cookie === 'string' ? readSession(cookie)?.username : undefined
    const who =
      (actor.get(req) ?? issued ?? (route === '/api/auth/login' ? text(body.username, 100) : '')) || 'anonymous'
    const target = [p.username, p.id, p.camId, p.robotId]
      .filter((x) => typeof x === 'string')
      .map((x) => text(x, 100))
      .join(' / ')
    db.prepare('INSERT INTO audit_log(ts,actor,action,site_id,target,status) VALUES(?,?,?,?,?,?)').run(
      Date.now(),
      who,
      `${req.method} ${route}`,
      text(p.siteId) || null,
      target,
      reply.statusCode,
    )
    // 90 days, checked by indexed timestamp. No bodies, URLs, headers, IPs or credentials stored.
    db.prepare('DELETE FROM audit_log WHERE ts<?').run(Date.now() - 90 * DAY)
  })
  const S = '/api/sites/:siteId'
  app.get(`${S}/mission-archive`, async (req, reply) => {
    const { siteId } = req.params as { siteId: string }
    if (!worlds.has(siteId)) return reply.code(404).send({ error: 'site not loaded' })
    const q = req.query as Record<string, unknown>
    const r = range(q)
    if (!r || (q.status && !statuses.includes(String(q.status))))
      return reply.code(400).send({ error: 'invalid date range or status' })
    return missionArchive(
      siteId,
      r.from,
      r.to,
      text(q.status),
      integer(q.offset, 0, 1_000_000),
      Math.max(1, integer(q.limit, 50, 500)),
    )
  })
  app.get(`${S}/mission-archive/:id`, async (req, reply) => {
    const { siteId, id } = req.params as { siteId: string; id: string }
    if (!worlds.has(siteId)) return reply.code(404).send({ error: 'site not loaded' })
    const mission = archivedRun(siteId, id)
    if (!mission) return reply.code(404).send({ error: 'run not found' })
    return { mission, events: missionEvents(siteId, id) }
  })
  app.get(`${S}/mission-archive/:id/report`, async (req, reply) => {
    const { siteId, id } = req.params as { siteId: string; id: string }
    if (!worlds.has(siteId)) return reply.code(404).send({ error: 'site not loaded' })
    const format = (req.query as { format?: string }).format ?? 'html'
    if (!['html', 'csv'].includes(format)) return reply.code(400).send({ error: 'format must be html or csv' })
    const m = archivedRun(siteId, id)
    if (!m) return reply.code(404).send({ error: 'run not found' })
    const events = missionEvents(siteId, id)
    const site = getSiteRow(siteId)?.name ?? siteId
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
    if (format === 'csv')
      return reply
        .header('Content-Disposition', `attachment; filename="inspection-${id.replace(/[^a-zA-Z0-9_-]/g, '')}.csv"`)
        .type('text/csv; charset=utf-8')
        .send(reportCSV(site, m, events))
    return reply
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(reportHTML(site, m, events))
  })
  app.get(`${S}/mission-calendar`, async (req, reply) => {
    const { siteId } = req.params as { siteId: string }
    const w = worlds.get(siteId)
    if (!w) return reply.code(404).send({ error: 'site not loaded' })
    const r = range(req.query as Record<string, unknown>, 45)
    if (!r) return reply.code(400).send({ error: 'calendar range must be 1–45 days' })
    const actual = missionArchive(siteId, r.from, r.to, '', 0, 5000)
    const planned = plannedCalendar(w.schedules, w.templates, r.from, r.to)
    const entries: CalendarEntry[] = [
      ...planned.entries,
      ...actual.missions.map((m) => ({
        id: m.id,
        kind: 'actual' as const,
        at: m.createdAt,
        name: m.name,
        runId: m.id,
        scheduleId: m.scheduleId,
        status: m.status,
        robot: m.robotId ?? m.requestedRobot,
      })),
    ]
    return {
      entries: entries.sort((a, b) => a.at - b.at),
      truncated: planned.truncated || actual.total > 5000,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  })
  app.get('/api/organization/units', { preHandler: requireRole('admin') }, async () => ({
    units: units(),
    members: members(),
    users: listUsers().map((u) => ({ username: u.username, displayName: u.displayName })),
  }))
  const saveUnit = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const id = (req.params as { id?: string }).id ?? randomUUID()
    const all = units()
    const old = all.find((x) => x.id === id)
    if (req.method === 'PATCH' && !old) return reply.code(404).send({ error: 'unit not found' })
    const b = { ...old, ...(req.body as Record<string, unknown>) }
    const name = text(b.name)
    const kind = text(b.kind) as Unit['kind']
    const parentId = text(b.parentId) || undefined
    const siteId = text(b.siteId) || undefined
    if (!name || !['factory', 'department', 'position'].includes(kind))
      return reply.code(400).send({ error: 'name and valid kind required' })
    if (siteId && !getSiteRow(siteId)) return reply.code(400).send({ error: 'site not found' })
    if (parentId) {
      const parent = all.find((u) => u.id === parentId)
      if (!parent || parent.kind === 'position' || kind === 'factory')
        return reply.code(400).send({ error: 'invalid parent' })
      let next: Unit | undefined = parent
      const seen = new Set<string>([id])
      while (next) {
        if (seen.has(next.id)) return reply.code(400).send({ error: 'organization cycle' })
        seen.add(next.id)
        next = all.find((u) => u.id === next?.parentId)
      }
    }
    if (
      old &&
      old.kind !== kind &&
      (all.some((u) => u.parentId === id) || members().some((m) => m.departmentId === id || m.positionId === id))
    )
      return reply.code(409).send({ error: 'unit is in use; remove assignments before changing kind' })
    const unit: Unit = { id, name, kind, parentId, siteId }
    db.prepare('INSERT OR REPLACE INTO organization_units VALUES(?,?,?)').run(id, JSON.stringify(unit), siteId ?? null)
    return { unit }
  }
  app.post('/api/organization/units', { preHandler: requireRole('admin') }, saveUnit)
  app.patch('/api/organization/units/:id', { preHandler: requireRole('admin') }, saveUnit)
  app.delete('/api/organization/units/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!units().some((u) => u.id === id)) return reply.code(404).send({ error: 'unit not found' })
    if (units().some((u) => u.parentId === id) || members().some((m) => m.departmentId === id || m.positionId === id))
      return reply.code(409).send({ error: 'unit has children or assigned members' })
    db.prepare('DELETE FROM organization_units WHERE id=?').run(id)
    return { ok: true }
  })
  app.put('/api/organization/members/:username', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { username } = req.params as { username: string }
    if (!getUser(username)) return reply.code(404).send({ error: 'user not found' })
    const b = (req.body ?? {}) as Record<string, unknown>
    const member: Membership = {
      username,
      departmentId: text(b.departmentId) || undefined,
      positionId: text(b.positionId) || undefined,
    }
    const all = units()
    if (
      (member.departmentId && !all.some((u) => u.id === member.departmentId && u.kind === 'department')) ||
      (member.positionId && !all.some((u) => u.id === member.positionId && u.kind === 'position'))
    )
      return reply.code(400).send({ error: 'invalid department or position' })
    db.prepare('INSERT OR REPLACE INTO organization_members VALUES(?,?)').run(username, JSON.stringify(member))
    return { member }
  })
  app.get('/api/audit-log', { preHandler: requireRole('admin') }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const r = range(q)
    if (!r) return reply.code(400).send({ error: 'invalid date range' })
    const clauses = ['ts>=?', 'ts<?']
    const args: (string | number)[] = [r.from, r.to]
    if (q.actor) {
      clauses.push('actor=?')
      args.push(text(q.actor))
    }
    if (q.kind === 'login') clauses.push("action LIKE '%/api/auth/%'")
    else if (q.kind === 'operation') clauses.push("action NOT LIKE '%/api/auth/%'")
    const where = clauses.join(' AND ')
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).get(...args) as { n: number }).n
    const offset = integer(q.offset, 0, 1_000_000),
      limit = Math.max(1, integer(q.limit, 50, 200))
    return {
      logs: db
        .prepare(
          `SELECT id,ts,actor,action,site_id AS siteId,target,status FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset),
      total,
      offset,
      limit,
      retentionDays: 90,
    }
  })
}
