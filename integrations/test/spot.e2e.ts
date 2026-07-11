// Spot 对全行为端到端 + 会话闸断言（无 token 拒、lease 独占、pause/resume、
// dock=导航到桩+坐下充电、BehaviorFault → robot-fault 事件）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import grpc from '@grpc/grpc-js'
import { standUpVendor, waitFor, api, fleetRobot, sampleTelemetry, assertArrives, assertOfflineRecovers, type VendorStack } from './harness.js'
import { api as bosdyn } from '../spot/loader.js'

const P = 18803
const SIM = 19003
const SITE = 'plant-07'
const SN = 'BD-91250107'
const RID = 'ext-bd-91250107'

let vs: VendorStack
let stack: VendorStack['stack']

before(async () => {
  vs = await standUpVendor({
    port: P,
    site: SITE,
    serial: SN,
    robotId: RID,
    sim: { entry: 'spot/sim/main.ts', env: { SPOT_SIM_PORT: String(SIM), SPOT_SIM_FAULT_S: '12' }, tag: 'ssim' },
    adapter: {
      entry: 'spot/adapter/main.ts',
      env: (base) => ({ PLANTBOT_BASE: base, SPOT_HOST: '127.0.0.1', SPOT_PORT: String(SIM), PLANTBOT_KEY: 'pbk_dev_plant07' }),
      tag: 'sadp',
    },
  })
  stack = vs.stack
})

after(() => vs.stop())

test('注册与遥测：会话舞蹈完成后 Spot 上线', { timeout: 40_000 }, async () => {
  const r = await fleetRobot(stack, SITE, SN)
  assert.equal(r.integrationLevel, 'dispatchable')
  assert.equal(r.vendor, 'Boston Dynamics')
  const frames = await waitFor(async () => {
    const f = await sampleTelemetry(stack.base, SITE, RID, 4000)
    return f.length >= 2 ? f : null
  }, 30_000, 'telemetry')
  const t = frames.at(-1)!
  assert.ok(t.x >= -16 && t.x <= 16 && t.z >= -9 && t.z <= 9, 'pose in plant-07 bounds')
  assert.ok(t.battery > 0)
})

test('读数：电池健康 metric（batt.v / batt.temp.c）', { timeout: 40_000 }, async () => {
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/robots/${RID}/readings`)
    const s = JSON.stringify(body)
    return s.includes('batt.v') && s.includes('batt.temp.c') ? true : null
  }, 35_000, 'battery readings')
})

test('goto 闭环：NavigateToAnchor → REACHED_GOAL', { timeout: 90_000 }, async () => {
  const target = { x: 8, z: 4 }
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID}/goto`, target)
  assert.equal(r.status, 200)
  await assertArrives(stack, SITE, RID, target)
})

test('mission：逐点巡查 + pause/resume + done；abort 生效', { timeout: 240_000 }, async () => {
  const m1 = await api(stack, 'POST', `/api/sites/${SITE}/missions`, {
    name: 'e2e anchors short',
    requestedRobot: RID,
    steps: [
      { waypointId: 'WP-13', actions: [{ type: 'capture_photo', durationS: 2 }] },
      { waypointId: 'WP-03', actions: [{ type: 'capture_photo', durationS: 2 }] },
    ],
  })
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    return body.missions.find((x: any) => x.id === m1.body.mission.id && x.status === 'active')
  }, 30_000, 'active')
  // pause → 平台命令下发 pause 订单 → adapter 悬停（stand）
  const pr = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID}/commands`, { type: 'pause' })
  assert.equal(pr.body.command.accepted, true)
  await new Promise((r2) => setTimeout(r2, 4000))
  const rr = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID}/commands`, { type: 'resume' })
  assert.equal(rr.body.command.accepted, true, `resume rejected: ${JSON.stringify(rr.body.command)}`)
  const done = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    const m = body.missions.find((x: any) => x.id === m1.body.mission.id)
    return m?.status === 'done' ? m : null
  }, 150_000, 'mission done after pause/resume')
  assert.ok(done)

  const m2 = await api(stack, 'POST', `/api/sites/${SITE}/missions`, {
    name: 'e2e anchors long',
    requestedRobot: RID,
    steps: ['WP-01', 'WP-05', 'WP-08'].map((w) => ({ waypointId: w, actions: [{ type: 'capture_photo', durationS: 2 }] })),
  })
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    return body.missions.find((x: any) => x.id === m2.body.mission.id && x.status === 'active')
  }, 30_000, 'long active')
  await new Promise((r2) => setTimeout(r2, 2500))
  await api(stack, 'POST', `/api/sites/${SITE}/missions/${m2.body.mission.id}/abort`, {})
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    const m = body.missions.find((x: any) => x.id === m2.body.mission.id)
    return m?.status === 'aborted' ? m : null
  }, 25_000, 'aborted')
})

test('dock：导航到 WP-09 充电桩 → 坐下 → charging', { timeout: 150_000 }, async () => {
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID}/commands`, { type: 'dock' })
  assert.equal(r.body.command.accepted, true)
  await waitFor(async () => {
    const f = await sampleTelemetry(stack.base, SITE, RID, 1500)
    return f.some((t) => t.mode === 'charging') ? true : null
  }, 130_000, 'charging on dock')
})

test('BehaviorFault → robot-fault 事件（FALL）', { timeout: 60_000 }, async () => {
  const ev = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/events?limit=120`)
    return body?.events?.find((e: any) => e.source === 'integration' && e.category === 'robot-fault' && /BehaviorFault/.test(e.detail))
  }, 50_000, 'behavior fault event')
  assert.match(ev.detail, /FALL/)
})

test('会话闸：无 token 拒访 / lease 独占', { timeout: 30_000 }, async () => {
  const creds = grpc.credentials.createInsecure()
  const state = new (bosdyn.RobotStateService as any)(`127.0.0.1:${SIM}`, creds)
  // 1) 不带 token → UNAUTHENTICATED
  await assert.rejects(
    new Promise((res, rej) => state.GetRobotState({ header: {} }, new grpc.Metadata(), (e: any, r: any) => (e ? rej(e) : res(r)))),
    (e: any) => e.code === grpc.status.UNAUTHENTICATED,
  )
  // 2) 合法登录后 AcquireLease → 被 adapter 独占（RESOURCE_ALREADY_CLAIMED=2）
  const auth = new (bosdyn.AuthService as any)(`127.0.0.1:${SIM}`, creds)
  const tok: any = await new Promise((res, rej) =>
    auth.GetAuthToken({ header: {}, username: 'admin', password: 'spotdev2026' }, new grpc.Metadata(), (e: any, r: any) => (e ? rej(e) : res(r))),
  )
  assert.equal(tok.status, 1)
  const md = new grpc.Metadata()
  md.set('authorization', `Bearer ${tok.token}`)
  const lease = new (bosdyn.LeaseService as any)(`127.0.0.1:${SIM}`, creds)
  const acq: any = await new Promise((res, rej) =>
    lease.AcquireLease({ header: { client_name: 'e2e-intruder' }, resource: 'body' }, md, (e: any, r: any) => (e ? rej(e) : res(r))),
  )
  assert.equal(acq.status, 2, 'body lease exclusively held by adapter')
})

test('掉线→恢复：sim 重启 → 会话拆除重舞 → 回归', { timeout: 150_000 }, async () => {
  await assertOfflineRecovers(vs, SITE, RID, { recoverMs: 90_000 }) // 全套会话舞蹈重来
})
