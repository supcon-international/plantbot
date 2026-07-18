// Gosuncn 对全行为端到端：真平台 + 真 sim + 真 adapter 三进程。
// 覆盖：注册 / 遥测流动 / 告警→事件（快照+置信度）/ 读数 / goto / dock(一键充电) /
// mission 指派与 abort / announce / 掉线→恢复 / 厂商线协议怪癖（Basic 登录、手动模式前置、10s 流地址）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { standUpVendor, waitFor, api, integration, fleetRobot, sampleTelemetry, assertArrives, assertOfflineRecovers, simsAvailable, type VendorStack } from './harness.js'

const P = 18801
const SIM = 19001
const SITE = 'campus-east'
const KEY = 'pbk_dev_campuseast'
const SN1 = 'GSCN-F2-2024-0117'
const RID1 = 'ext-gscn-f2-2024-0117'

let vs: VendorStack
let stack: VendorStack['stack']

const SKIP = !simsAvailable() // plantbotsimulator sibling not checked out → skip vendor-behaviour suite

before(async () => {
  if (SKIP) return
  vs = await standUpVendor({
    port: P,
    site: SITE,
    serial: SN1,
    robotId: RID1,
    sim: { entry: 'gosuncn/sim/main.ts', env: { GOSUNCN_SIM_PORT: String(SIM), GOSUNCN_SIM_ALARM_MS: '4000' }, tag: 'gsim' },
    adapter: {
      entry: 'gosuncn/adapter/main.ts',
      env: (base) => ({ PLANTBOT_BASE: base, GOSUNCN_BASE: `http://127.0.0.1:${SIM}`, PLANTBOT_KEY: KEY }),
      tag: 'gadp',
    },
    registerTimeoutMs: 40_000,
  })
  stack = vs.stack
})

after(() => vs?.stop())

test('注册：两台 F2 以正确等级出现', { skip: SKIP, timeout: 30_000 }, async () => {
  const r1 = await fleetRobot(stack, SITE, SN1)
  const r2 = await waitFor(() => fleetRobot(stack, SITE, 'GSCN-F2-2024-0118'), 20_000, 'unit2')
  assert.equal(r1.integrationLevel, 'dispatchable')
  assert.equal(r2.integrationLevel, 'state-only')
  assert.equal(r1.adapter, 'external')
  assert.ok(r1.payloads.some((p: any) => p.stream === 'gs1-rear'), 'rear channel registered')
})

test('遥测：位姿在界内流动，巡逻中出现运动', { skip: SKIP, timeout: 40_000 }, async () => {
  const frames = await waitFor(async () => {
    const f = await sampleTelemetry(stack.base, SITE, RID1, 8000)
    return f.length >= 4 ? f : null
  }, 30_000, 'telemetry frames')
  for (const t of frames) {
    assert.ok(t.x >= -20 && t.x <= 20 && t.z >= -11 && t.z <= 11, `pos in bounds (${t.x},${t.z})`)
    assert.ok(t.battery > 0 && t.battery <= 100)
  }
  const moved = frames.some((t) => t.speed > 0.1)
  const posDelta = Math.hypot(frames.at(-1)!.x - frames[0].x, frames.at(-1)!.z - frames[0].z)
  assert.ok(moved || posDelta > 0.3, 'robot patrols (speed or displacement observed)')
})

test('事件桥：厂商告警映射为平台事件，带快照与置信度', { skip: SKIP, timeout: 70_000 }, async () => {
  const ev = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/events?limit=120`)
    return body?.events?.find(
      (e: any) => e.source === 'integration' && ['unattended-bag', 'crowding', 'tailgating', 'ebike-blocking', 'fall'].includes(e.type),
    )
  }, 60_000, 'mapped vendor alarm event')
  assert.ok(ev.confidence > 0 && ev.confidence <= 1, 'reliability → confidence')
  assert.ok(String(ev.snapshot ?? '').includes('/api/snapshots/'), 'platform evidence-capture snapshot attached')
  assert.match(ev.detail, /GoRobot #\d+/, 'vendor alarm id kept in detail')
})

test('读数：环境三件套进 metric 时序', { skip: SKIP, timeout: 40_000 }, async () => {
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/robots/${RID1}/readings`)
    const s = JSON.stringify(body)
    return s.includes('amb.temp.c') && s.includes('noise.db') ? body : null
  }, 35_000, 'ambient readings')
})

test('goto 闭环：tap-to-dispatch → navigateToPoint → 到点', { skip: SKIP, timeout: 90_000 }, async () => {
  const target = { x: -12, z: 7.6 }
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID1}/goto`, target)
  assert.equal(r.status, 200)
  await assertArrives(stack, SITE, RID1, target)
  const st = await integration(stack.base, KEY, 'POST', `/robots/${SN1}/state`, {})
  assert.equal(st.body.ordersPending, 0, 'order queue drained')
})

test('dock 语义：平台 dock 命令 → 厂商一键充电 → charging', { skip: SKIP, timeout: 120_000 }, async () => {
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID1}/commands`, { type: 'dock' })
  assert.equal(r.body.command.accepted, true)
  await waitFor(async () => {
    const f = await sampleTelemetry(stack.base, SITE, RID1, 1500)
    return f.some((t) => t.mode === 'charging') ? true : null
  }, 100_000, 'charging mode reached')
})

test('mission：显式指派 → 逐点巡查 → done；abort 生效', { skip: SKIP, timeout: 180_000 }, async () => {
  // 指派两点任务
  const m1 = await api(stack, 'POST', `/api/sites/${SITE}/missions`, {
    name: 'e2e patrol short',
    requestedRobot: RID1,
    steps: [
      { waypointId: 'CP-01', actions: [{ type: 'capture_photo', durationS: 2 }] },
      { waypointId: 'CP-02', actions: [{ type: 'capture_photo', durationS: 2 }] },
    ],
  })
  assert.equal(m1.status, 200)
  const done = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    const m = body.missions.find((x: any) => x.id === m1.body.mission.id)
    return m?.status === 'done' ? m : null
  }, 120_000, 'mission done')
  assert.ok(done.results.length >= 1, 'completion note recorded')

  // 长任务 + 中途 abort
  const m2 = await api(stack, 'POST', `/api/sites/${SITE}/missions`, {
    name: 'e2e patrol long',
    requestedRobot: RID1,
    steps: ['CP-03', 'CP-04', 'CP-05', 'CP-06'].map((w) => ({ waypointId: w, actions: [{ type: 'capture_photo', durationS: 3 }] })),
  })
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    return body.missions.find((x: any) => x.id === m2.body.mission.id && x.status === 'active')
  }, 30_000, 'long mission active')
  await new Promise((r2) => setTimeout(r2, 3000))
  await api(stack, 'POST', `/api/sites/${SITE}/missions/${m2.body.mission.id}/abort`, {})
  const aborted = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    const m = body.missions.find((x: any) => x.id === m2.body.mission.id)
    return m?.status === 'aborted' ? m : null
  }, 20_000, 'mission aborted')
  assert.equal(aborted.status, 'aborted')
})

test('announce：喊话命令被接受并转发厂商', { skip: SKIP, timeout: 20_000 }, async () => {
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID1}/commands`, { type: 'announce', text: '前方巡逻，请注意安全' })
  assert.equal(r.body.command.accepted, true)
})

test('线协议怪癖：Basic 登录闸 / 手动模式前置 / 10s 流地址', { skip: SKIP, timeout: 30_000 }, async () => {
  const base = `http://127.0.0.1:${SIM}`
  // 1) 缺 Basic admin:admin → 拒
  const noBasic = await fetch(`${base}/robotservice/auth/login`, { method: 'POST', body: new FormData() })
  assert.equal(((await noBasic.json()) as any).ret, -1)
  // 2) 正确登录
  const form = new FormData()
  form.set('username', 'campus01')
  const { createHash } = await import('node:crypto')
  form.set('password', createHash('md5').update('gorobot@2025').digest('hex'))
  form.set('grant_type', 'password')
  const login = (await (
    await fetch(`${base}/robotservice/auth/login`, { method: 'POST', headers: { authorization: 'Basic YWRtaW46YWRtaW4=' }, body: form })
  ).json()) as any
  assert.equal(login.ret, 1)
  const tk = login.data.access_token
  // 3) 自动模式下临时跑路线 → 厂商前置条件拒绝
  const srp = (await (
    await fetch(`${base}/robotservice/qpid/specificRoutePatrol.action?deviceCode=F2230204118&lineCode=2`, { method: 'POST', headers: { Token: tk } })
  ).json()) as any
  assert.equal(srp.successful, false)
  assert.match(srp.msg, /手动/)
  // 4) 取流地址一次一发（10s 时效资产）
  const v1 = (await (await fetch(`${base}/robotservice/device/getVideoUrl.action?channelId=1958&protocol=websocket`, { headers: { Token: tk } })).json()) as any
  const v2 = (await (await fetch(`${base}/robotservice/device/getVideoUrl.action?channelId=1958&protocol=websocket`, { headers: { Token: tk } })).json()) as any
  assert.equal(v1.ret, 1)
  assert.notEqual(v1.data.url, v2.data.url, 'each getVideoUrl mints a fresh session url')
})

test('掉线→恢复：sim 重启后 20s 判 OFFLINE、随后自动回归', { skip: SKIP, timeout: 120_000 }, async () => {
  await assertOfflineRecovers(vs, SITE, RID1, { recoverMs: 60_000 })
})
