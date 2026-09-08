import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from './db.js'
import { requestUser, requireRole } from './auth.js'
import { getUser, roleFor } from './config.js'
import { METRIC_DEFS } from './fleet.js'
import type { World } from './world.js'

export interface InspectionAsset {
  id: string
  name: string
  kind: string
  location: string
  waypointId: string
  manufacturer: string
  model: string
  serial: string
  notes: string
  createdAt: number
  updatedAt: number
}
export interface AssetTag {
  id: string
  assetId: string
  name: string
  waypointId: string
  dataType: 'number' | 'string' | 'boolean'
  unit: string
  address: string
  source: 'manual' | 'adapter' | 'integration'
  robotId: string
  metric: string
  createdAt: number
  updatedAt: number
}
export interface DefectUpdate {
  at: number
  by: string
  action: 'created' | 'updated' | 'comment' | 'status'
  note: string
  from?: string
  to?: string
  changes?: Record<string, { from: unknown; to: unknown }>
}
export interface Defect {
  id: string
  title: string
  description: string
  assetId: string
  tagId: string
  eventId: string
  severity: 'minor' | 'major'
  category: string
  status: 'open' | 'in_progress' | 'closed'
  submittedBy: string
  assignedTo: string
  resolution: string
  createdAt: number
  updatedAt: number
  history: DefectUpdate[]
}

type Row = { data: string }
type Body = Record<string, unknown>
const S = '/api/sites/:siteId'
const tables = { assets: 'inspection_assets', 'asset-tags': 'inspection_tags', defects: 'inspection_defects' } as const
type Resource = keyof typeof tables
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode })
}
function object(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON object required')
  return value as Body
}
function str(b: Body, key: string, required = false, max = 240): string {
  const v = b[key] ?? ''
  if (typeof v !== 'string' || v.length > max) fail(`${key} must be text (maximum ${max} characters)`)
  const out = (v as string).trim()
  if (required && !out) fail(`${key} is required`)
  return out
}
function choice<T extends string>(b: Body, key: string, values: readonly T[], fallback: T): T {
  const v = b[key] ?? fallback
  if (!values.includes(v as T)) fail(`${key} must be one of ${values.join(', ')}`)
  return v as T
}
function keys(b: Body, allowed: string[]) {
  for (const key of Object.keys(b)) if (!allowed.includes(key)) fail(`unknown field: ${key}`)
}
const assetFields = ['name', 'kind', 'location', 'waypointId', 'manufacturer', 'model', 'serial', 'notes']
const tagFields = ['assetId', 'name', 'waypointId', 'dataType', 'unit', 'address', 'source', 'robotId', 'metric']
const defectFields = ['title', 'description', 'assetId', 'tagId', 'eventId', 'severity', 'category', 'assignedTo']
function read<T>(resource: Resource, site: string, id: string): T | undefined {
  const row = db.prepare(`SELECT data FROM ${tables[resource]} WHERE site_id=? AND id=?`).get(site, id) as
    | Row
    | undefined
  return row ? (JSON.parse(row.data) as T) : undefined
}
function all<T>(resource: Resource, site: string): T[] {
  return (
    db.prepare(`SELECT data FROM ${tables[resource]} WHERE site_id=? ORDER BY updated_at DESC, id`).all(site) as Row[]
  ).map((r) => JSON.parse(r.data) as T)
}
function put(resource: Resource, site: string, item: { id: string; updatedAt: number }) {
  db.prepare(
    `INSERT INTO ${tables[resource]} (site_id,id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
  ).run(site, item.id, JSON.stringify(item), item.updatedAt)
}
function requireRecord<T>(resource: Resource, site: string, id: string): T {
  return read<T>(resource, site, id) ?? fail(`${resource} record not found`, 404)
}
function ref(resource: Resource, site: string, id: string) {
  if (id && !read(resource, site, id)) fail(`${resource} reference does not exist in this site`)
}
function waypoint(w: World, id: string) {
  if (id && !w.waypoints.some((p) => p.id === id)) fail('waypointId does not exist in this site')
}
function csv(rows: unknown[][]): string {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((v) => {
            let s = String(v ?? '')
            if (/^[\s]*[=+@-]/.test(s)) s = "'" + s
            return '"' + s.replaceAll('"', '""') + '"'
          })
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  )
}
function actor(req: FastifyRequest): string {
  return requestUser(req)?.username ?? fail('sign in required', 401)
}

/** Site resources extend the existing SQLite store; no separate service or driver runtime. */
export function registerInspectionAssets(app: FastifyInstance, getWorld: (site: string) => World | undefined) {
  for (const table of Object.values(tables))
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, id TEXT NOT NULL,
    data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(site_id,id)
  )`)
  function context(req: FastifyRequest) {
    const { siteId, id } = req.params as { siteId: string; id: string }
    const w = getWorld(siteId) ?? fail('site not loaded', 404)
    return { site: siteId, id, w }
  }
  function validateAsset(b: Body, w: World) {
    const data = Object.fromEntries(
      assetFields.map((k) => [k, str(b, k, ['name', 'kind'].includes(k), k === 'notes' ? 8000 : 240)]),
    ) as unknown as Omit<InspectionAsset, 'id' | 'createdAt' | 'updatedAt'>
    waypoint(w, data.waypointId)
    return data
  }
  function validateTag(b: Body, w: World, site: string, id?: string) {
    const data = {
      assetId: str(b, 'assetId', true),
      name: str(b, 'name', true),
      waypointId: str(b, 'waypointId', true),
      dataType: choice(b, 'dataType', ['number', 'string', 'boolean'] as const, 'number'),
      unit: str(b, 'unit', false, 40),
      address: str(b, 'address', true, 500),
      source: choice(b, 'source', ['manual', 'adapter', 'integration'] as const, 'manual'),
      robotId: str(b, 'robotId'),
      metric: str(b, 'metric'),
    }
    ref('assets', site, data.assetId)
    waypoint(w, data.waypointId)
    if (all<AssetTag>('asset-tags', site).some((t) => t.id !== id && t.name.toLowerCase() === data.name.toLowerCase()))
      fail('tag name already exists in this site', 409)
    if (data.source !== 'manual') {
      if (!data.robotId || !w.robots.some((r) => r.id === data.robotId)) fail('select a robot registered in this site')
      const metric = METRIC_DEFS.find((m) => m.id === data.metric) ?? fail('select a registered metric')
      if (data.dataType !== 'number') fail('adapter readings currently require number dataType')
      if (data.unit !== metric.unit) fail(`unit must match the metric (${metric.unit})`)
    } else {
      data.robotId = ''
      data.metric = ''
    }
    return data
  }
  function validateDefect(b: Body, site: string, existingEventId?: string) {
    const data = {
      title: str(b, 'title', true),
      description: str(b, 'description', false, 8000),
      assetId: str(b, 'assetId'),
      tagId: str(b, 'tagId'),
      eventId: str(b, 'eventId'),
      severity: choice(b, 'severity', ['minor', 'major'] as const, 'minor'),
      category: str(b, 'category', true, 100),
      assignedTo: str(b, 'assignedTo'),
    }
    ref('assets', site, data.assetId)
    ref('asset-tags', site, data.tagId)
    if (data.tagId) {
      const tag = requireRecord<AssetTag>('asset-tags', site, data.tagId)
      if (data.assetId && data.assetId !== tag.assetId) fail('tag does not belong to this asset')
      data.assetId = tag.assetId
    }
    // Events have a 90-day retention window; keep an already-validated historical
    // link editable after that source event expires. New links still require it.
    if (
      data.eventId &&
      data.eventId !== existingEventId &&
      !db.prepare('SELECT id FROM events WHERE site_id=? AND id=?').get(site, data.eventId)
    )
      fail('event does not exist in this site')
    if (data.assignedTo) {
      const user = getUser(data.assignedTo)
      if (!user || roleFor(user, site) === 'viewer') fail('assignedTo must be a site operator or administrator')
    }
    return data
  }
  app.get(`${S}/defect-assignees`, async (req) => {
    const { site } = context(req)
    // Only assignment identities are exposed, never passwords or role maps.
    return {
      items: (
        db.prepare('SELECT username,display_name FROM users ORDER BY username').all() as {
          username: string
          display_name: string
        }[]
      )
        .filter((u) => roleFor(getUser(u.username) ?? null, site) !== 'viewer')
        .map((u) => ({ username: u.username, displayName: u.display_name })),
    }
  })
  for (const resource of ['assets', 'asset-tags'] as const) {
    app.get(`${S}/${resource}`, async (req) => {
      const { site } = context(req)
      return { items: all<InspectionAsset | AssetTag>(resource, site) }
    })
    app.get(`${S}/${resource}/export`, { preHandler: requireRole('operator') }, async (req, reply) => {
      const { site } = context(req)
      const fields = ['id', ...(resource === 'assets' ? assetFields : tagFields), 'createdAt', 'updatedAt']
      const rows = all<Record<string, unknown>>(resource, site)
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${resource}.csv"`)
        .send(csv([fields, ...rows.map((r) => fields.map((k) => r[k]))]))
    })
    app.post(`${S}/${resource}`, { preHandler: requireRole('admin') }, async (req, reply) => {
      const { site, w } = context(req),
        b = object(req.body)
      keys(b, resource === 'assets' ? assetFields : tagFields)
      const data = resource === 'assets' ? validateAsset(b, w) : validateTag(b, w, site)
      const item = {
        ...data,
        id: `${resource === 'assets' ? 'asset' : 'tag'}-${randomUUID()}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      put(resource, site, item)
      return reply.code(201).send(item)
    })
    app.patch(`${S}/${resource}/:id`, { preHandler: requireRole('admin') }, async (req) => {
      const { site, id, w } = context(req),
        b = object(req.body)
      keys(b, resource === 'assets' ? assetFields : tagFields)
      const old = requireRecord<InspectionAsset | AssetTag>(resource, site, id)
      const data =
        resource === 'assets' ? validateAsset({ ...old, ...b }, w) : validateTag({ ...old, ...b }, w, site, id)
      if (
        resource === 'asset-tags' &&
        (old as AssetTag).assetId !== (data as AssetTag).assetId &&
        all<Defect>('defects', site).some((d) => d.tagId === id)
      )
        fail('a tag referenced by defects cannot move to another asset', 409)
      const item = { ...old, ...data, updatedAt: Date.now() }
      put(resource, site, item)
      return item
    })
    app.delete(`${S}/${resource}/:id`, { preHandler: requireRole('admin') }, async (req) => {
      const { site, id } = context(req)
      requireRecord(resource, site, id)
      if (
        all<Defect>('defects', site).some((d) => (resource === 'assets' ? d.assetId === id : d.tagId === id)) ||
        (resource === 'assets' && all<AssetTag>('asset-tags', site).some((t) => t.assetId === id)) ||
        (resource === 'assets' && db.prepare("SELECT 1 FROM vision_configs WHERE site_id=? AND json_extract(data,'$.assetId')=? LIMIT 1").get(site, id))
      )
        fail('record is referenced by tags, defects or vision monitoring; retain it for history', 409)
      db.prepare(`DELETE FROM ${tables[resource]} WHERE site_id=? AND id=?`).run(site, id)
      return { ok: true }
    })
  }
  function defects(req: FastifyRequest) {
    const { site } = context(req),
      q = req.query as Record<string, string>
    for (const key of ['q', 'status', 'severity', 'category', 'assetId', 'assignedTo']) {
      if (q[key] !== undefined && typeof q[key] !== 'string') fail(`${key} filter must be a single string`)
    }
    if (q.status && !['open', 'in_progress', 'closed'].includes(q.status)) fail('invalid status filter')
    if (q.severity && !['minor', 'major'].includes(q.severity)) fail('invalid severity filter')
    const text = (q.q ?? '').toLowerCase()
    return all<Defect>('defects', site).filter(
      (d) =>
        (!q.status || d.status === q.status) &&
        (!q.severity || d.severity === q.severity) &&
        (!q.category || d.category === q.category) &&
        (!q.assetId || d.assetId === q.assetId) &&
        (!q.assignedTo || d.assignedTo === q.assignedTo) &&
        (!text ||
          [d.id, d.title, d.description, d.category, d.submittedBy, d.assignedTo]
            .join(' ')
            .toLowerCase()
            .includes(text)),
    )
  }
  app.get(`${S}/defects`, async (req) => ({ items: defects(req) }))
  app.get(`${S}/defects/export`, { preHandler: requireRole('operator') }, async (req, reply) => {
    const fields = ['id', ...defectFields, 'status', 'submittedBy', 'resolution', 'createdAt', 'updatedAt', 'history']
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="defects.csv"')
      .send(
        csv([
          fields,
          ...defects(req).map((d) =>
            fields.map((k) => (k === 'history' ? JSON.stringify(d.history) : d[k as keyof Defect])),
          ),
        ]),
      )
  })
  app.get(`${S}/defects/:id`, async (req) => {
    const { site, id } = context(req)
    return requireRecord<Defect>('defects', site, id)
  })
  app.post(`${S}/defects`, { preHandler: requireRole('operator') }, async (req, reply) => {
    const { site } = context(req),
      b = object(req.body)
    keys(b, defectFields)
    const data = validateDefect(b, site),
      now = Date.now(),
      by = actor(req)
    const item: Defect = {
      ...data,
      id: `def-${randomUUID()}`,
      status: 'open',
      submittedBy: by,
      resolution: '',
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, by, action: 'created', note: data.description, to: 'open' }],
    }
    put('defects', site, item)
    return reply.code(201).send(item)
  })
  app.patch(`${S}/defects/:id`, { preHandler: requireRole('operator') }, async (req) => {
    const { site, id } = context(req),
      b = object(req.body)
    keys(b, defectFields)
    const old = requireRecord<Defect>('defects', site, id)
    if (old.status === 'closed') fail('reopen the defect before editing it', 409)
    const data = validateDefect({ ...old, ...b }, site, old.eventId),
      now = Date.now()
    const changes = Object.fromEntries(
      defectFields
        .filter((k) => old[k as keyof Defect] !== data[k as keyof typeof data])
        .map((k) => [k, { from: old[k as keyof Defect], to: data[k as keyof typeof data] }]),
    )
    if (!Object.keys(changes).length) return old
    const item: Defect = {
      ...old,
      ...data,
      updatedAt: now,
      history: [...old.history, { at: now, by: actor(req), action: 'updated', note: '', changes }],
    }
    put('defects', site, item)
    return item
  })
  app.post(`${S}/defects/:id/updates`, { preHandler: requireRole('operator') }, async (req) => {
    const { site, id } = context(req),
      b = object(req.body)
    keys(b, ['note', 'status'])
    const old = requireRecord<Defect>('defects', site, id),
      note = str(b, 'note', true, 8000)
    const status = choice(b, 'status', ['open', 'in_progress', 'closed'] as const, old.status)
    if (status === 'in_progress' && !old.assignedTo) fail('assign a responsible operator before starting work')
    if (status === 'closed' && !old.assignedTo) fail('assign a responsible operator before closing')
    const now = Date.now()
    const item: Defect = {
      ...old,
      status,
      resolution: status === 'closed' ? note : status !== old.status ? '' : old.resolution,
      updatedAt: now,
      history: [
        ...old.history,
        {
          at: now,
          by: actor(req),
          action: status === old.status ? 'comment' : 'status',
          note,
          from: old.status,
          to: status,
        },
      ],
    }
    // Comments on a closed defect do not rewrite its completion statement.
    if (old.status === 'closed' && status === 'closed') item.resolution = old.resolution
    put('defects', site, item)
    return item
  })
}
