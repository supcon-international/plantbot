import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

const dir = mkdtempSync(join(tmpdir(), 'plantbot-operations-'))
process.env.PB_DATA_DIR = dir
process.env.SESSION_SECRET = 'operations-tests-only'
const { registerOperations, plannedCalendar, reportHTML, reportCSV } = await import('../../../server/src/operations.js')
const { db } = await import('../../../server/src/db.js')
const { createSiteRow, createUser, makePersist, deleteUser, deleteSiteRow, roleFor, getUser } = await import(
  '../../../server/src/config.js'
)
const { login, issueSession, publicUser, requireRole } = await import('../../../server/src/auth.js')
import type { Mission, DetectionEvent, World } from '../../../server/src/world.js'
import type { Schedule } from '../../../server/src/fleet.js'
const DAY = 86_400_000
for (const id of ['archive-a', 'archive-b'])
  createSiteRow({
    id,
    name: id,
    operator: 'test',
    bounds: { x: [0, 10], z: [0, 10] },
    dockWp: '',
    buildings: [],
    demo: false,
  })
createUser({ username: 'audit-admin', password: 'valid-password-secret', roles: { '*': 'admin' } })
createUser({ username: 'audit-operator', password: 'operator-secret', roles: { 'archive-a': 'operator' } })
const worlds = new Map([
  ['archive-a', { schedules: [], templates: [] }],
  ['archive-b', { schedules: [], templates: [] }],
]) as unknown as Map<string, World>
const app = Fastify()
registerOperations(app, worlds)
app.post('/api/auth/login', async (req, reply) => {
  const b = req.body as { username: string; password: string }
  const user = login(req.ip, b.username, b.password)
  if (!user) return reply.code(401).send({ error: 'invalid credentials' })
  issueSession(req, reply, user.username)
  return { user: publicUser(user) }
})
app.patch('/api/sites/:siteId/settings/:id', { preHandler: requireRole('admin') }, async () => ({ ok: true }))
await app.ready()
async function signIn(username: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  assert.equal(r.statusCode, 200)
  return String(r.headers['set-cookie']).split(';')[0]
}
const admin = await signIn('audit-admin', 'valid-password-secret')
const operator = await signIn('audit-operator', 'operator-secret')
const persist = makePersist('archive-a')
const mission: Mission = {
  id: 'M-old',
  name: '=SUM(1,2)<img src=x onerror=alert(1)>',
  priority: 2,
  requestedRobot: 'auto',
  robotId: 'ext-a',
  recurring: false,
  status: 'done',
  steps: [{ waypointId: 'WP-1', actions: [{ type: 'capture_photo', durationS: 3 }] }],
  currentStep: 1,
  createdAt: Date.now() - 10 * DAY,
  startedAt: Date.now() - 10 * DAY + 1000,
  endedAt: Date.now() - 10 * DAY + 2000,
  results: [
    {
      ts: Date.now() - 10 * DAY + 1500,
      stepIdx: 0,
      waypointId: 'WP-1',
      action: 'capture_photo',
      ok: false,
      note: '<script>alert("x")</script>',
      snapshot: 'javascript:alert(1)',
    },
  ],
  progress: 1,
  scheduleId: 'SC-old',
}
persist.mission(mission)
const event: DetectionEvent = {
  id: 'EV-linked',
  ts: mission.createdAt + 1500,
  type: 'thermal',
  ruleId: 'RL-test',
  label: 'hot',
  detail: '=HYPERLINK("https://x")',
  severity: 'high',
  category: 'equipment',
  source: 'ext-a',
  sourceName: 'robot',
  robotId: 'ext-a',
  zone: 'area',
  confidence: 1,
  evidence: [{ kind: 'image', url: 'javascript:alert(1)' }],
  lifecycle: 'new',
  acked: false,
  runId: mission.id,
  x: 0,
  z: 0,
}
// More than World's 400-event ring: report must retain all linked records.
for (let i = 0; i < 405; i++) persist.event({ ...event, id: `EV-${i}`, ts: event.ts + i })

test('archive is durable, paginated and isolated by site; date/status validation is explicit', async () => {
  const res = await app.inject('/api/sites/archive-a/mission-archive?from=0&to=' + Date.now())
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().missions[0].id, 'M-old')
  for (let i = 0; i < 28; i++) persist.mission({ ...mission, id: `M-page-${i}`, createdAt: Date.now() - i })
  const page = await app.inject(
    '/api/sites/archive-a/mission-archive?from=0&to=' + (Date.now() + 1000) + '&limit=25&offset=25',
  )
  assert.equal(page.json().total, 29)
  assert.equal(page.json().missions.length, 4)
  assert.equal((await app.inject('/api/sites/archive-b/mission-archive/M-old')).statusCode, 404)
  assert.equal((await app.inject('/api/sites/no-site/mission-archive')).statusCode, 404)
  assert.equal((await app.inject('/api/sites/archive-a/mission-archive?from=NaN')).statusCode, 400)
  assert.equal((await app.inject('/api/sites/archive-a/mission-archive?status=pretend')).statusCode, 400)
  const detail = await app.inject('/api/sites/archive-a/mission-archive/M-old')
  assert.equal(detail.json().events.length, 405)
})

test('HTML and CSV exports preserve facts and neutralize script/formula content', async () => {
  const html = await app.inject('/api/sites/archive-a/mission-archive/M-old/report?format=html')
  assert.equal(html.statusCode, 200)
  assert.match(html.headers['content-security-policy'] as string, /default-src 'none'/)
  assert.match(html.body, /&lt;script&gt;/)
  assert.doesNotMatch(html.body, /<script|<img|href="javascript:/i)
  assert.match(html.body, /Planned inspection/)
  assert.match(html.body, /EV-404/)
  const csv = await app.inject('/api/sites/archive-a/mission-archive/M-old/report?format=csv')
  assert.match(csv.headers['content-disposition'] as string, /attachment/)
  assert.ok(csv.body.startsWith('\uFEFF'))
  assert.match(csv.body, /"'=SUM/)
  assert.match(csv.body, /planned_action/)
  assert.match(csv.body, /"result"/)
  assert.match(csv.body, /EV-404/)
  assert.equal((await app.inject('/api/sites/archive-a/mission-archive/M-old/report?format=pdf')).statusCode, 400)
  assert.match(reportCSV('test', { ...mission, name: '\t=1+1' }, []), /"'\t=1\+1"/)
  assert.doesNotMatch(reportHTML('<svg onload=alert(1)>', mission, [event]), /<svg/)
})

test('calendar shows only future forecast and distinct actual runs; recurring preview is bounded', async () => {
  const now = Date.now()
  const s: Schedule = {
    id: 'SC-1',
    templateId: 'T-1',
    assign: { kind: 'auto' },
    cadence: { kind: 'interval', everyMin: 60 },
    priority: 2,
    enabled: true,
    nextRunAt: now + 1000,
    runCount: 0,
  }
  const future = plannedCalendar([s], [{ id: 'T-1', name: 'route' }], now - DAY, now + 2 * 3600_000, now)
  assert.equal(future.entries.length, 2)
  assert.ok(future.entries.every((e) => e.kind === 'planned' && e.at >= now && !e.runId))
  assert.equal(plannedCalendar([{ ...s, enabled: false }], [], now, now + DAY, now).entries.length, 0)
  const dense = plannedCalendar([{ ...s, cadence: { kind: 'interval', everyMin: 0.001 } }], [], now, now + DAY, now)
  assert.equal(dense.entries.length, 5000)
  assert.equal(dense.truncated, true)
  worlds.get('archive-a')!.schedules = [s]
  const res = await app.inject(`/api/sites/archive-a/mission-calendar?from=${now - 12 * DAY}&to=${now + DAY}`)
  assert.equal(res.statusCode, 200)
  assert.ok(res.json().entries.some((e: { kind: string; runId: string }) => e.kind === 'actual' && e.runId === 'M-old'))
  assert.ok(res.json().entries.some((e: { kind: string }) => e.kind === 'planned'))
  assert.equal((await app.inject('/api/sites/archive-a/mission-calendar?from=0&to=' + Date.now())).statusCode, 400)
})

test('organization respects platform admin scope, prevents cycles/in-use deletion and grants no access', async () => {
  assert.equal((await app.inject('/api/organization/units')).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/organization/units', headers: { cookie: operator } })).statusCode, 403)
  const create = async (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/organization/units', headers: { cookie: admin }, payload })
  const factory = (await create({ name: 'Factory', kind: 'factory', siteId: 'archive-a' })).json().unit
  const dept = (await create({ name: 'Operations', kind: 'department', parentId: factory.id })).json().unit
  const job = (await create({ name: 'Inspector', kind: 'position', parentId: dept.id })).json().unit
  const cycle = await app.inject({
    method: 'PATCH',
    url: `/api/organization/units/${dept.id}`,
    headers: { cookie: admin },
    payload: { parentId: dept.id },
  })
  assert.equal(cycle.statusCode, 400)
  const assign = await app.inject({
    method: 'PUT',
    url: '/api/organization/members/audit-operator',
    headers: { cookie: admin },
    payload: { departmentId: dept.id, positionId: job.id },
  })
  assert.equal(assign.statusCode, 200)
  assert.equal(roleFor(getUser('audit-operator'), 'archive-b'), 'viewer')
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/organization/units/${dept.id}`, headers: { cookie: admin } }))
      .statusCode,
    409,
  )
  const directory = await app.inject({ url: '/api/organization/units', headers: { cookie: admin } })
  assert.equal(directory.json().members[0].departmentId, dept.id)
  assert.doesNotMatch(directory.body, /salt|hash|password/)
  // Site FK detaches metadata; deleting users removes their membership.
  createUser({ username: 'temporary-member', password: 'temporary-secret', roles: { 'archive-a': 'viewer' } })
  await app.inject({
    method: 'PUT',
    url: '/api/organization/members/temporary-member',
    headers: { cookie: admin },
    payload: { departmentId: dept.id },
  })
  deleteUser('temporary-member')
  assert.equal(
    (
      db.prepare('SELECT count(*) AS n FROM organization_members WHERE username=?').get('temporary-member') as {
        n: number
      }
    ).n,
    0,
  )
})

test('actual login and mutation hooks audit identity, rejection and retention without secrets', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'audit-admin', password: 'SECRET-never-store-password' },
  })
  await app.inject({
    method: 'PATCH',
    url: '/api/sites/archive-a/settings/target',
    headers: { cookie: operator, authorization: 'Bearer NEVER-STORE-TOKEN' },
    payload: { password: 'NEVER-STORE-BODY', rtsp: 'rtsp://secret:pass@example' },
  })
  await app.inject({
    method: 'PATCH',
    url: '/api/sites/archive-a/settings/target',
    headers: { cookie: admin },
    payload: { password: 'NEVER-STORE-BODY' },
  })
  const loginLog = await app.inject({ url: '/api/audit-log?from=0&kind=login', headers: { cookie: admin } })
  assert.ok(
    loginLog.json().logs.some((r: { status: number; actor: string }) => r.status === 401 && r.actor === 'audit-admin'),
  )
  const log = await app.inject({
    url: '/api/audit-log?from=0&kind=operation&actor=audit-operator&limit=1',
    headers: { cookie: admin },
  })
  assert.equal(log.json().logs.length, 1)
  assert.equal(log.json().logs[0].status, 403)
  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all())
  assert.doesNotMatch(dump, /NEVER-STORE|SECRET-never|valid-password|pb_sess=|rtsp:/)
  db.prepare('INSERT INTO audit_log(ts,actor,action,target,status) VALUES(?,?,?,?,?)').run(
    Date.now() - 100 * DAY,
    'expired',
    'POST /test',
    '',
    200,
  )
  await app.inject({
    method: 'PATCH',
    url: '/api/sites/archive-a/settings/target',
    headers: { cookie: admin },
    payload: {},
  })
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_log WHERE actor='expired'").get() as { n: number }).n, 0)
  assert.equal((await app.inject({ url: '/api/audit-log', headers: { cookie: operator } })).statusCode, 403)
  const page = await app.inject({ url: '/api/audit-log?from=0&limit=2&offset=2', headers: { cookie: admin } })
  assert.equal(page.json().logs.length, 2)
  assert.ok(page.json().total > 4)
})

after(async () => {
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
