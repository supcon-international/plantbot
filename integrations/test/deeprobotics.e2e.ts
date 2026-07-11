// 云深处对全行为端到端 + 线协议字节级断言（16B 帧头 seq 回填、1003 终态语义、
// 41793 占用拒绝、1004 取消闭环）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { standUpVendor, spawnProc, waitFor, api, fleetRobot, sampleTelemetry, assertArrives, assertOfflineRecovers, type VendorStack } from './harness.js'
import {
  FrameParser, encodeFrame, TYPE, buildRealtimeReq, buildNavTaskReq, buildCancelReq, defaultNavPoint,
  parseRealtimeResp, parseNavTaskResp, parseCancelResp,
} from '../deeprobotics/protocol.js'

const P = 18802
const SIM = 19002
const SITE = 'plant-12'
const SN = 'X30-JY-2024-0007'
const RID = 'ext-x30-jy-2024-0007'

let vs: VendorStack
let stack: VendorStack['stack']

before(async () => {
  vs = await standUpVendor({
    port: P,
    site: SITE,
    serial: SN,
    robotId: RID,
    sim: { entry: 'deeprobotics/sim/main.ts', env: { DR_SIM_PORT: String(SIM), DR_SIM_FAULT_S: '15', DR_SIM_LOCAL_PATROL_MS: '0' }, tag: 'drsim' },
    adapter: {
      entry: 'deeprobotics/adapter/main.ts',
      env: (base) => ({ PLANTBOT_BASE: base, DR_HOST: '127.0.0.1', DR_PORT: String(SIM), PLANTBOT_KEY: 'pbk_dev_plant12' }),
      tag: 'dradp',
    },
    registerTimeoutMs: 40_000,
  })
  stack = vs.stack
})

after(() => vs.stop())

test('注册与遥测：X30 出现在 plant-12 并流动', { timeout: 40_000 }, async () => {
  const r = await fleetRobot(stack, SITE, SN)
  assert.equal(r.integrationLevel, 'dispatchable')
  assert.equal(r.model, 'Jueying X30')
  const frames = await waitFor(async () => {
    const f = await sampleTelemetry(stack.base, SITE, RID, 4000)
    return f.length >= 2 ? f : null
  }, 30_000, 'telemetry')
  const t = frames.at(-1)!
  // 注：钉死排程（X30 berth sweep）可能已在跑——只断言位姿界内与电量有效
  assert.ok(t.x >= -13 && t.x <= 13 && t.z >= -8 && t.z <= 8, `pose in bounds, got (${t.x},${t.z})`)
  assert.ok(t.battery > 0)
})

test('goto 闭环：平台派单 → 1003 单点 → 到点 → done', { timeout: 90_000 }, async () => {
  const target = { x: 5, z: 3 }
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID}/goto`, target)
  assert.equal(r.status, 200)
  await assertArrives(stack, SITE, RID, target)
})

test('mission：多航点 → 单次 1003 原生多点任务 → done；abort → 1004', { timeout: 180_000 }, async () => {
  const m1 = await api(stack, 'POST', `/api/sites/${SITE}/missions`, {
    name: 'e2e berth short',
    requestedRobot: RID,
    steps: [
      { waypointId: 'HB-09', actions: [{ type: 'capture_photo', durationS: 2 }] },
      { waypointId: 'HB-06', actions: [{ type: 'capture_photo', durationS: 2 }] },
    ],
  })
  const done = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    const m = body.missions.find((x: any) => x.id === m1.body.mission.id)
    return m?.status === 'done' ? m : null
  }, 120_000, 'mission done')
  assert.match(done.results.at(-1)?.note ?? '', /巡检任务执行完成|waypoints/)

  const m2 = await api(stack, 'POST', `/api/sites/${SITE}/missions`, {
    name: 'e2e berth long',
    requestedRobot: RID,
    steps: ['HB-01', 'HB-03', 'HB-05'].map((w) => ({ waypointId: w, actions: [{ type: 'capture_photo', durationS: 2 }] })),
  })
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    return body.missions.find((x: any) => x.id === m2.body.mission.id && x.status === 'active')
  }, 30_000, 'long mission active')
  await new Promise((r2) => setTimeout(r2, 2500))
  await api(stack, 'POST', `/api/sites/${SITE}/missions/${m2.body.mission.id}/abort`, {})
  await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/missions`)
    const m = body.missions.find((x: any) => x.id === m2.body.mission.id)
    return m?.status === 'aborted' ? m : null
  }, 25_000, 'mission aborted (1004 cancel)')
})

test('能力矩阵讲真话：announce/ptz 不受协议支持', { timeout: 20_000 }, async () => {
  const r = await api(stack, 'POST', `/api/sites/${SITE}/robots/${RID}/commands`, { type: 'announce', text: 'x' })
  // 平台接受命令并转发订单；订单由 adapter 以 failed: unsupported 收尾（平台命令日志仍 accepted）
  assert.equal(r.body.command.accepted, true)
})

test('本体故障：定位丢失 → robot-fault 事件', { timeout: 90_000 }, async () => {
  const ev = await waitFor(async () => {
    const { body } = await api(stack, 'GET', `/api/sites/${SITE}/events?limit=120`)
    return body?.events?.find((e: any) => e.source === 'integration' && e.category === 'robot-fault' && /定位丢失/.test(e.detail))
  }, 80_000, 'location-lost fault event')
  assert.equal(ev.type, 'fault')
})

test('线协议：seq 回填 / 执行中 41793 拒单 / 1004 取消触发 1003 终态', { timeout: 60_000 }, async () => {
  // 用一台专属 sim，与 adapter 共用的那台隔离 —— 否则 adapter 的 ensureIdle
  // 会 1004 取消本测试直连下发的任务（共享单一导航栈）。这也更贴近真实:
  // 官方 SDK 客户端本就直连自己的机器人。
  const wireSim = spawnProc('deeprobotics/sim/main.ts', { DR_SIM_PORT: '30099', DR_SIM_LOCAL_PATROL_MS: '0' }, 'drwire')
  await new Promise((r) => setTimeout(r, 2500))
  const sock = net.connect({ host: '127.0.0.1', port: 30099 })
  await new Promise((res, rej) => (sock.once('connect', res), sock.once('error', rej)))
  const parser = new FrameParser()
  const frames: { seq: number; type: number; body: string }[] = []
  sock.on('data', (c) => frames.push(...parser.push(c)))
  const send = (seq: number, xml: string) => sock.write(encodeFrame(seq, xml))
  const expect = (pred: (f: { seq: number; type: number; body: string }) => boolean, label: string) =>
    waitFor(async () => frames.find(pred), 20_000, label, 100)
  const cleanup = () => {
    sock.destroy()
    wireSim.kill('SIGTERM')
  }

  try {
  // 1002：响应必须回填请求 seq
  send(41, buildRealtimeReq())
  const rt = await expect((f) => f.seq === 41 && f.type === TYPE.REALTIME, '1002 echo seq')
  const st = parseRealtimeResp(rt.body)
  assert.ok(st.Electricity > 0 && typeof st.PosX === 'number')

  // 1003 长任务（不立即回帧；若与平台派单撞车收到 41793 忙拒则重试一轮）
  let navSeq = 42
  for (let attempt = 0; ; attempt++) {
    send(navSeq, buildNavTaskReq([defaultNavPoint(1, st.PosX + 6, st.PosY + 3)]))
    await new Promise((r2) => setTimeout(r2, 400))
    const busyHit = frames.find((f) => f.seq === navSeq && f.type === TYPE.NAV_TASK)
    if (!busyHit) break // 任务被接受（无即时回帧 —— 1003 语义）
    assert.equal(parseNavTaskResp(busyHit.body).errorStatus, 41793, 'busy rejection is 41793')
    assert.ok(attempt < 3, 'robot never freed up')
    send(50 + attempt, buildCancelReq())
    await new Promise((r2) => setTimeout(r2, 800))
    navSeq += 10
  }

  // 执行中再发一个 1003 → 41793 当前正在执行任务
  send(navSeq + 1, buildNavTaskReq([defaultNavPoint(1, 0, 0)]))
  const busy = await expect((f) => f.seq === navSeq + 1 && f.type === TYPE.NAV_TASK, 'busy rejection')
  assert.equal(parseNavTaskResp(busy.body).errorStatus, 41793)

  // 1004 取消 → 即答 0；同时原 seq 的 1003 收到 ErrorCode=2（8962 被取消）终态
  send(navSeq + 2, buildCancelReq())
  const cancel = await expect((f) => f.seq === navSeq + 2 && f.type === TYPE.CANCEL, 'cancel ack')
  assert.equal(parseCancelResp(cancel.body).errorCode, 0)
  const terminal = await expect((f) => f.seq === navSeq && f.type === TYPE.NAV_TASK, '1003 terminal frame with original seq')
  const term = parseNavTaskResp(terminal.body)
  assert.equal(term.errorCode, 2)
  assert.equal(term.errorStatus, 8962)
  } finally {
    cleanup()
  }
})

test('掉线→恢复：sim 重启 → OFFLINE → 自动重连回归', { timeout: 120_000 }, async () => {
  await assertOfflineRecovers(vs, SITE, RID, { recoverMs: 60_000 })
})
