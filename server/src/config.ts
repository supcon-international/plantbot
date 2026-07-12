// Durable platform store, backed by SQLite (db.ts). Identity (users, per-site
// API keys), site modeling (sites/waypoints/zones/cameras/transforms/maps),
// external robot registrations, custom event vocabulary — plus the ops-state
// write-through interface the World uses (rules/templates/schedules/missions/
// events/orders/commands/readings) and the boot-time hydration loaders.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db, sha256, inTx } from './db.js'
export { DATA_DIR, MAPS_DIR, importLegacyConfig, sweepRetention } from './db.js'
import type { Severity, EventCategory, SiteCamera, Waypoint, Zone, Building, FrameTransform, Reading, CommandRecord } from './fleet.js'

// ops aggregates are stored as JSON blobs — persistence only needs the keys
// it indexes on; the full shapes stay owned by world.ts (no import cycle)
type IdRow = { id: string }
type MissionRow = IdRow & { status: string; createdAt: number }
type EventRow = IdRow & { ts: number }
type OrderRow = IdRow & { state: string; updatedAt: number }

export type Role = 'viewer' | 'operator' | 'admin'
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

// ---------- users ----------

export interface UserRec {
  username: string
  displayName: string
  salt: string
  hash: string
  /** siteId → role; '*' wildcard applies to every site */
  roles: Record<string, Role>
  seeded?: boolean
}

const rowToUser = (r: Record<string, unknown>): UserRec => ({
  username: r.username as string,
  displayName: r.display_name as string,
  salt: r.salt as string,
  hash: r.hash as string,
  roles: JSON.parse(r.roles as string),
  seeded: !!r.seeded,
})

export function hashPassword(password: string, salt?: string) {
  const s = salt ?? randomBytes(12).toString('hex')
  return { salt: s, hash: scryptSync(password, s, 32).toString('hex') }
}

export function verifyPassword(user: UserRec, password: string): boolean {
  const test = scryptSync(password, user.salt, 32)
  const real = Buffer.from(user.hash, 'hex')
  return test.length === real.length && timingSafeEqual(test, real)
}

export function getUser(username: string): UserRec | null {
  const r = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined
  return r ? rowToUser(r) : null
}

export function listUsers(): UserRec[] {
  return (db.prepare('SELECT * FROM users ORDER BY username').all() as Record<string, unknown>[]).map(rowToUser)
}

export function createUser(input: { username: string; displayName?: string; password: string; roles: Record<string, Role> }): UserRec | null {
  const username = input.username.toLowerCase().replace(/[^a-z0-9_.-]+/g, '').slice(0, 32)
  if (!username || getUser(username)) return null
  const { salt, hash } = hashPassword(input.password)
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,0)').run(username, input.displayName || username, salt, hash, JSON.stringify(input.roles))
  return getUser(username)
}

export function updateUser(username: string, patch: { displayName?: string; roles?: Record<string, Role>; password?: string }): UserRec | null {
  const u = getUser(username)
  if (!u) return null
  const displayName = patch.displayName ?? u.displayName
  const roles = patch.roles ?? u.roles
  const cred = patch.password ? hashPassword(patch.password) : { salt: u.salt, hash: u.hash }
  db.prepare('UPDATE users SET display_name=?, roles=?, salt=?, hash=? WHERE username=?').run(
    displayName, JSON.stringify(roles), cred.salt, cred.hash, username)
  return getUser(username)
}

export function deleteUser(username: string): boolean {
  const u = getUser(username)
  if (!u) return false
  // never delete the last admin — that locks everyone out
  const admins = listUsers().filter((x) => Object.values(x.roles).includes('admin'))
  if (admins.length === 1 && admins[0].username === username) return false
  db.prepare('DELETE FROM users WHERE username=?').run(username)
  return true
}

/** seed the three demo accounts on an empty users table; env passwords always win */
export function bootUsers() {
  const seeds: [string, string, string, Record<string, Role>][] = [
    ['admin', 'Site Admin', 'PB_ADMIN_PASSWORD', { '*': 'admin' }],
    ['operator', 'Shift Operator', 'PB_OPERATOR_PASSWORD', { '*': 'operator' }],
    ['viewer', 'Read-only Viewer', 'PB_VIEWER_PASSWORD', { '*': 'viewer' }],
  ]
  const empty = listUsers().length === 0
  for (const [username, displayName, envVar, roles] of seeds) {
    const pw = process.env[envVar]
    const existing = getUser(username)
    if (!existing && empty) {
      const { salt, hash } = hashPassword(pw || 'plantbot')
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,1)').run(username, displayName, salt, hash, JSON.stringify(roles))
    } else if (existing?.seeded && pw) {
      // rotation without console edits: env-provided passwords override seeded accounts
      const { salt, hash } = hashPassword(pw)
      db.prepare('UPDATE users SET salt=?, hash=? WHERE username=?').run(salt, hash, username)
    }
  }
}

export function roleFor(user: UserRec | null, siteId: string): Role {
  if (!user) return 'viewer' // anonymous browsing (gate via PB_PUBLIC_VIEW=0)
  return user.roles[siteId] ?? user.roles['*'] ?? 'viewer'
}

// ---------- api keys (hashed at rest — plaintext returned exactly once) ----------

export interface ApiKeyRec {
  id: string
  siteId: string
  label: string
  prefix: string
  createdAt: number
  lastUsedAt?: number
}

const rowToKey = (r: Record<string, unknown>): ApiKeyRec => ({
  id: r.id as string,
  siteId: r.site_id as string,
  label: r.label as string,
  prefix: r.prefix as string,
  createdAt: r.created_at as number,
  lastUsedAt: (r.last_used_at as number) ?? undefined,
})

export function listApiKeys(siteId: string): ApiKeyRec[] {
  return (db.prepare('SELECT * FROM api_keys WHERE site_id=? ORDER BY created_at').all(siteId) as Record<string, unknown>[]).map(rowToKey)
}

export function newApiKey(siteId: string, label: string): ApiKeyRec & { key: string } {
  const key = `pbk_${randomBytes(24).toString('hex')}`
  const rec: ApiKeyRec = {
    id: `AK-${randomBytes(3).toString('hex')}`,
    siteId,
    label: label || 'unnamed key',
    prefix: `${key.slice(0, 12)}…`,
    createdAt: Date.now(),
  }
  db.prepare('INSERT INTO api_keys VALUES (?,?,?,?,?,?,NULL)').run(rec.id, siteId, rec.label, sha256(key), rec.prefix, rec.createdAt)
  return { ...rec, key }
}

export function deleteApiKey(siteId: string, id: string): boolean {
  const before = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE site_id=? AND id=?').get(siteId, id) as { n: number }
  if (!before.n) return false
  db.prepare('DELETE FROM api_keys WHERE site_id=? AND id=?').run(siteId, id)
  return true
}

// last_used writes are debounced — adapters hit this at 1 Hz per robot
const lastUsedFlush = new Map<string, number>()

export function findApiKey(bearer: string): { siteId: string; id: string } | null {
  const r = db.prepare('SELECT id, site_id FROM api_keys WHERE key_hash=?').get(sha256(bearer)) as
    | { id: string; site_id: string }
    | undefined
  if (!r) return null
  const now = Date.now()
  if (now - (lastUsedFlush.get(r.id) ?? 0) > 60_000) {
    lastUsedFlush.set(r.id, now)
    db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now, r.id)
  }
  return { siteId: r.site_id, id: r.id }
}

/** Adapter onboarding without a manual console visit:
 *  - PB_SEED_KEYS="plant-07=pbk_abc,…" pins production keys from the
 *    environment (systemd drop-in) — stored hashed like everything else.
 *  - PB_DEV_KEYS=1 (set by the root `pnpm dev` script only) seeds the
 *    deterministic pbk_dev_<site> keys the bundled sim adapters default to. */
export function seedApiKeys(siteIds: string[]) {
  const upsert = (siteId: string, key: string, label: string) => {
    const hash = sha256(key)
    const exists = db.prepare('SELECT 1 FROM api_keys WHERE key_hash=?').get(hash)
    if (exists) return
    db.prepare('INSERT INTO api_keys VALUES (?,?,?,?,?,?,NULL)').run(
      `AK-seed-${siteId}-${randomBytes(2).toString('hex')}`, siteId, label, hash, `${key.slice(0, 12)}…`, Date.now())
  }
  for (const pair of (process.env.PB_SEED_KEYS ?? '').split(',')) {
    const [siteId, key] = pair.split('=').map((s) => s.trim())
    if (siteId && key?.startsWith('pbk_') && siteIds.includes(siteId)) upsert(siteId, key, 'seeded adapter key (env)')
  }
  if (process.env.PB_DEV_KEYS === '1')
    for (const id of siteIds) upsert(id, `pbk_dev_${id.replace(/-/g, '')}`, 'dev adapter key')
}

// ---------- sites + geometry ----------

export interface SiteRow {
  id: string
  name: string
  operator: string
  bounds: { x: [number, number]; z: [number, number] }
  dockWp: string
  splat?: { name: string; url: string }
  buildings: Building[]
  /** built-in demo underlay meta (static web asset) — uploads override it */
  mapMeta?: import('./fleet.js').SiteMapMeta
  demo: boolean
  createdAt: number
}

const rowToSite = (r: Record<string, unknown>): SiteRow => ({
  id: r.id as string,
  name: r.name as string,
  operator: r.operator as string,
  bounds: JSON.parse(r.bounds as string),
  dockWp: r.dock_wp as string,
  splat: r.splat ? JSON.parse(r.splat as string) : undefined,
  buildings: JSON.parse(r.buildings as string),
  mapMeta: r.map_meta ? JSON.parse(r.map_meta as string) : undefined,
  demo: !!r.demo,
  createdAt: r.created_at as number,
})

export function listSiteRows(): SiteRow[] {
  return (db.prepare('SELECT * FROM sites ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToSite)
}

export function getSiteRow(id: string): SiteRow | null {
  const r = db.prepare('SELECT * FROM sites WHERE id=?').get(id) as Record<string, unknown> | undefined
  return r ? rowToSite(r) : null
}

export function createSiteRow(s: Omit<SiteRow, 'createdAt'>): void {
  db.prepare('INSERT INTO sites VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    s.id, s.name, s.operator, JSON.stringify(s.bounds), s.dockWp,
    s.splat ? JSON.stringify(s.splat) : null, JSON.stringify(s.buildings),
    s.mapMeta ? JSON.stringify(s.mapMeta) : null, s.demo ? 1 : 0, Date.now())
}

export function patchSiteRow(id: string, patch: Partial<Pick<SiteRow, 'name' | 'operator' | 'bounds' | 'dockWp'>>): boolean {
  const cur = getSiteRow(id)
  if (!cur) return false
  db.prepare('UPDATE sites SET name=?, operator=?, bounds=?, dock_wp=? WHERE id=?').run(
    patch.name ?? cur.name, patch.operator ?? cur.operator,
    JSON.stringify(patch.bounds ?? cur.bounds), patch.dockWp ?? cur.dockWp, id)
  return true
}

export function deleteSiteRow(id: string): void {
  inTx(() => {
    for (const t of ['sites', 'waypoints', 'zones', 'cameras', 'transforms', 'site_maps', 'externals', 'event_types', 'rules', 'templates', 'schedules', 'missions', 'events', 'orders', 'commands', 'readings', 'api_keys', 'connectors'])
      db.prepare(`DELETE FROM ${t} WHERE ${t === 'sites' ? 'id' : 'site_id'}=?`).run(id)
  })
}

export function loadGeometry(siteId: string): { waypoints: Waypoint[]; zones: Zone[]; cameras: SiteCamera[] } {
  const waypoints = (db.prepare('SELECT * FROM waypoints WHERE site_id=?').all(siteId) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, name: r.name as string, x: r.x as number, z: r.z as number, kind: r.kind as Waypoint['kind'],
  }))
  const zones = (db.prepare('SELECT * FROM zones WHERE site_id=?').all(siteId) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, name: r.name as string, kind: r.kind as Zone['kind'],
    polygon: JSON.parse(r.polygon as string), label: r.label ? JSON.parse(r.label as string) : undefined,
  }))
  const cameras = (db.prepare('SELECT * FROM cameras WHERE site_id=?').all(siteId) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, name: r.name as string, place: r.place as string,
    stream: r.stream_key as string, rtsp: (r.rtsp as string) ?? undefined, file: (r.file as string) ?? undefined,
    live: !!r.rtsp, source: r.rtsp ? 'RTSP camera' : 'NVR loop · demo footage',
  }))
  return { waypoints, zones, cameras }
}

export function saveGeometry(siteId: string, g: { waypoints: Waypoint[]; zones: Zone[]; cameras: SiteCamera[] }): void {
  inTx(() => {
    db.prepare('DELETE FROM waypoints WHERE site_id=?').run(siteId)
    db.prepare('DELETE FROM zones WHERE site_id=?').run(siteId)
    db.prepare('DELETE FROM cameras WHERE site_id=?').run(siteId)
    for (const w of g.waypoints)
      db.prepare('INSERT INTO waypoints VALUES (?,?,?,?,?,?)').run(siteId, w.id, w.name, w.x, w.z, w.kind)
    for (const z of g.zones)
      db.prepare('INSERT INTO zones VALUES (?,?,?,?,?,?)').run(
        siteId, z.id, z.name, z.kind, JSON.stringify(z.polygon), z.label !== undefined ? JSON.stringify(z.label) : null)
    for (const c of g.cameras)
      db.prepare('INSERT INTO cameras VALUES (?,?,?,?,?,?,?)').run(
        siteId, c.id, c.name, c.place ?? '', c.stream, c.rtsp ?? null, c.file ?? null)
  })
}

export function listTransforms(siteId: string): (FrameTransform & { id: string })[] {
  return (db.prepare('SELECT * FROM transforms WHERE site_id=?').all(siteId) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, from: r.from_frame as string, to: r.to_frame as string,
    params: JSON.parse(r.params as string), note: (r.note as string) ?? undefined,
  }))
}

export function saveTransform(siteId: string, t: FrameTransform & { id: string }): void {
  db.prepare('INSERT OR REPLACE INTO transforms VALUES (?,?,?,?,?,?)').run(
    siteId, t.id, t.from, t.to, JSON.stringify(t.params), t.note ?? null)
}

export function deleteTransform(siteId: string, id: string): boolean {
  const hit = db.prepare('SELECT 1 FROM transforms WHERE site_id=? AND id=?').get(siteId, id)
  if (!hit) return false
  db.prepare('DELETE FROM transforms WHERE site_id=? AND id=?').run(siteId, id)
  return true
}

// ---------- uploaded occupancy maps ----------

export interface PersistedMapRec {
  file: string
  resolution: number
  width: number
  height: number
  origin: [number, number]
  source: string
  uploadedAt: number
}

export function getSiteMap(siteId: string): PersistedMapRec | null {
  const r = db.prepare('SELECT * FROM site_maps WHERE site_id=?').get(siteId) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    file: r.file as string, resolution: r.resolution as number,
    width: r.width as number, height: r.height as number,
    origin: [r.origin_x as number, r.origin_z as number],
    source: r.source as string, uploadedAt: r.uploaded_at as number,
  }
}

export function saveSiteMap(siteId: string, m: PersistedMapRec): void {
  db.prepare('INSERT OR REPLACE INTO site_maps VALUES (?,?,?,?,?,?,?,?,?)').run(
    siteId, m.file, m.resolution, m.width, m.height, m.origin[0], m.origin[1], m.source, m.uploadedAt)
}

// ---------- external robot registrations ----------

export interface ExternalRec {
  serial: string
  model: string
  vendor?: string
  callsign?: string
  family?: 'quadruped' | 'ugv'
  level: 'state-only' | 'dispatchable'
  ip?: string
  protocol?: string
  home?: { x: number; z: number }
  streams?: { id: string; name: string; kind?: 'camera' | 'thermal' | 'ogi' | 'lidar' | 'gas' | 'acoustic' | 'imu'; url?: string }[]
}

export function listExternals(siteId: string): ExternalRec[] {
  return (db.prepare('SELECT rec FROM externals WHERE site_id=?').all(siteId) as { rec: string }[]).map((r) => JSON.parse(r.rec))
}

export function saveExternal(siteId: string, rec: ExternalRec): void {
  db.prepare('INSERT OR REPLACE INTO externals VALUES (?,?,?)').run(siteId, rec.serial, JSON.stringify(rec))
}

export function deleteExternal(siteId: string, serial: string): void {
  db.prepare('DELETE FROM externals WHERE site_id=? AND serial=?').run(siteId, serial)
}

// ---------- managed connectors (platform-hosted adapters) ----------

export type ConnectorVendor = 'spot' | 'deeprobotics' | 'gosuncn'

export interface ConnectorRec {
  id: string
  siteId: string
  vendor: ConnectorVendor
  name: string
  /** connection params + identity + camera streams; credentials live here —
   *  the row is only ever served on site-admin routes */
  config: Record<string, unknown>
  enabled: boolean
  createdAt: number
  updatedAt: number
}

const rowToConnector = (r: Record<string, unknown>): ConnectorRec => ({
  id: r.id as string,
  siteId: r.site_id as string,
  vendor: r.vendor as ConnectorVendor,
  name: r.name as string,
  config: JSON.parse(r.config as string),
  enabled: !!r.enabled,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
})

export function listConnectors(siteId: string): ConnectorRec[] {
  return (db.prepare('SELECT * FROM connectors WHERE site_id=? ORDER BY created_at').all(siteId) as Record<string, unknown>[]).map(rowToConnector)
}

export function listAllConnectors(): ConnectorRec[] {
  return (db.prepare('SELECT * FROM connectors ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToConnector)
}

export function getConnector(siteId: string, id: string): ConnectorRec | null {
  const r = db.prepare('SELECT * FROM connectors WHERE site_id=? AND id=?').get(siteId, id) as Record<string, unknown> | undefined
  return r ? rowToConnector(r) : null
}

export function saveConnector(rec: ConnectorRec): void {
  db.prepare('INSERT OR REPLACE INTO connectors VALUES (?,?,?,?,?,?,?,?)').run(
    rec.siteId, rec.id, rec.vendor, rec.name, JSON.stringify(rec.config), rec.enabled ? 1 : 0, rec.createdAt, rec.updatedAt)
}

export function deleteConnectorRec(siteId: string, id: string): boolean {
  const hit = db.prepare('SELECT 1 FROM connectors WHERE site_id=? AND id=?').get(siteId, id)
  if (!hit) return false
  db.prepare('DELETE FROM connectors WHERE site_id=? AND id=?').run(siteId, id)
  return true
}

// ---------- custom event vocabulary ----------

export interface CustomEventTypeRec {
  id: string
  label: string
  severity: Severity
  detail?: string
  category?: EventCategory
}

export function listEventTypes(siteId: string): CustomEventTypeRec[] {
  return (db.prepare('SELECT data FROM event_types WHERE site_id=?').all(siteId) as { data: string }[]).map((r) => JSON.parse(r.data))
}

export function saveEventType(siteId: string, t: CustomEventTypeRec): void {
  db.prepare('INSERT OR REPLACE INTO event_types VALUES (?,?,?)').run(siteId, t.id, JSON.stringify(t))
}

export function deleteEventTypeRec(siteId: string, id: string): void {
  db.prepare('DELETE FROM event_types WHERE site_id=? AND id=?').run(siteId, id)
}

// ---------- ops-state write-through (used by World via the Persist hooks) ----------

export interface Persist {
  rule(r: IdRow): void
  ruleDeleted(id: string): void
  template(t: IdRow): void
  templateDeleted(id: string): void
  schedule(s: IdRow): void
  scheduleDeleted(id: string): void
  mission(m: MissionRow): void
  event(ev: EventRow): void
  order(o: OrderRow): void
  command(rec: CommandRecord): void
  readings(batch: Reading[]): void
}

export function makePersist(siteId: string): Persist {
  const up = (table: string) => db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?,?,?)`)
  const del = (table: string) => db.prepare(`DELETE FROM ${table} WHERE site_id=? AND id=?`)
  const missionStmt = db.prepare('INSERT OR REPLACE INTO missions VALUES (?,?,?,?,?,?)')
  const eventStmt = db.prepare('INSERT OR REPLACE INTO events VALUES (?,?,?,?)')
  const orderStmt = db.prepare('INSERT OR REPLACE INTO orders VALUES (?,?,?,?,?)')
  const cmdStmt = db.prepare('INSERT OR REPLACE INTO commands VALUES (?,?,?,?)')
  const readStmt = db.prepare('INSERT INTO readings VALUES (?,?,?,?,?,?,?,?)')
  return {
    rule: (r) => up('rules').run(siteId, r.id, JSON.stringify(r)),
    ruleDeleted: (id) => del('rules').run(siteId, id),
    template: (t) => up('templates').run(siteId, t.id, JSON.stringify(t)),
    templateDeleted: (id) => del('templates').run(siteId, id),
    schedule: (s) => up('schedules').run(siteId, s.id, JSON.stringify(s)),
    scheduleDeleted: (id) => del('schedules').run(siteId, id),
    mission: (m) => missionStmt.run(siteId, m.id, JSON.stringify(m), m.status, m.createdAt, Date.now()),
    event: (ev) => eventStmt.run(siteId, ev.id, ev.ts, JSON.stringify(ev)),
    order: (o) => orderStmt.run(siteId, o.id, JSON.stringify(o), o.state, o.updatedAt),
    command: (rec) => cmdStmt.run(siteId, rec.id, rec.ts, JSON.stringify(rec)),
    readings: (batch) => {
      if (!batch.length) return
      inTx(() => {
        for (const r of batch)
          readStmt.run(siteId, r.robotId, r.metric, r.ts, r.value, r.payloadId ?? null, r.quality ?? null, r.wp ?? null)
      })
    },
  }
}

/** parsed JSON blobs — the World casts these back to its own types on hydrate */
export interface SiteOpsState {
  rules: unknown[]
  templates: unknown[]
  schedules: unknown[]
  missions: unknown[]
  events: unknown[]
  orders: unknown[]
  readings: Reading[]
}

/** boot hydration: open work + a bounded window of history */
export function loadSiteOps(siteId: string): SiteOpsState {
  const blobs = (table: string, where = '', ...args: (string | number)[]) =>
    (db.prepare(`SELECT data FROM ${table} WHERE site_id=? ${where}`).all(siteId, ...args) as { data: string }[]).map((r) => JSON.parse(r.data))
  return {
    rules: blobs('rules'),
    templates: blobs('templates'),
    schedules: blobs('schedules'),
    missions: (db.prepare(
      "SELECT data FROM missions WHERE site_id=? AND (status IN ('queued','active') OR updated_at > ?) ORDER BY created_at",
    ).all(siteId, Date.now() - 48 * 3600_000) as { data: string }[]).map((r) => JSON.parse(r.data)),
    events: (db.prepare('SELECT data FROM events WHERE site_id=? ORDER BY ts DESC LIMIT 400').all(siteId) as { data: string }[])
      .map((r) => JSON.parse(r.data)),
    orders: (db.prepare("SELECT data FROM orders WHERE site_id=? AND state IN ('pending','acked')").all(siteId) as { data: string }[])
      .map((r) => JSON.parse(r.data)),
    readings: (db.prepare(
      'SELECT robot_id, metric, ts, value, payload_id, quality, wp FROM readings WHERE site_id=? AND ts > ? ORDER BY ts',
    ).all(siteId, Date.now() - 30 * 60_000) as Record<string, unknown>[]).map((r) => ({
      robotId: r.robot_id as string, payloadId: (r.payload_id as string) ?? 'adapter', metric: r.metric as string,
      ts: r.ts as number, value: r.value as number,
      quality: (r.quality as Reading['quality']) ?? undefined, wp: (r.wp as string) ?? undefined,
    })),
  }
}

/** id-sequence maxima per table so hydrated Worlds never reuse ids (audit-safe) */
export function loadSeqs(siteId: string) {
  const max = (table: string, prefixLen: number) =>
    (db.prepare(
      `SELECT COALESCE(MAX(CAST(substr(id, ?) AS INTEGER)), 0) AS m FROM ${table} WHERE site_id=?`,
    ).get(prefixLen + 1, siteId) as { m: number }).m
  return {
    rule: max('rules', 3), // RL-
    ev: max('events', 3), // EV-
    mission: max('missions', 2), // M-
    order: max('orders', 3), // OR-
    tmpl: max('templates', 2), // T-
    sched: max('schedules', 3), // SC-
    cmd: max('commands', 4), // CMD-
  }
}

/** readings range query for the REST endpoint (beyond the in-memory ring) */
export function queryReadings(siteId: string, robotId: string, metric: string | undefined, since: number, limit: number): Reading[] {
  const rows = metric
    ? db.prepare('SELECT * FROM readings WHERE site_id=? AND robot_id=? AND metric=? AND ts>? ORDER BY ts DESC LIMIT ?')
        .all(siteId, robotId, metric, since, limit)
    : db.prepare('SELECT * FROM readings WHERE site_id=? AND robot_id=? AND ts>? ORDER BY ts DESC LIMIT ?')
        .all(siteId, robotId, since, limit)
  return (rows as Record<string, unknown>[]).reverse().map((r) => ({
    robotId: r.robot_id as string, payloadId: (r.payload_id as string) ?? 'adapter', metric: r.metric as string,
    ts: r.ts as number, value: r.value as number,
    quality: (r.quality as Reading['quality']) ?? undefined, wp: (r.wp as string) ?? undefined,
  }))
}
