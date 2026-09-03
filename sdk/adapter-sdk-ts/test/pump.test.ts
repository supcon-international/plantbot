// 订单泵单测（node:test，Node ≥22.18 原生剥类型）。覆盖：去重、运动类串行 FIFO、
// preempt 抢占被调用、干预类立即执行、异常被捕获不卡泵。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pumpOrders, type PlantbotOrder } from '../src/index.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))
const rep = { ordersPending: 9 }

// 每次 pull 都回同一批（平台会重复下发未结算/重放的订单——泵靠去重挡住）
const pbOf = (orders: PlantbotOrder[]) => ({ pullOrders: async () => orders }) as any

let n = 0
function order(kind: PlantbotOrder['kind'], id?: string, createdAt = ++n): PlantbotOrder {
  return { id: id ?? `${kind}-${n}`, kind, payload: {}, state: 'queued', createdAt }
}

test('去重：同一 order.id 只执行一次（跨多次 pump）', async () => {
  const serial = 'S-dedup'
  const seen: string[] = []
  const exec = (o: PlantbotOrder) => void seen.push(o.id)
  const A = order('announce', 'A', 1)
  await pumpOrders(pbOf([A]), serial, rep, exec)
  await pumpOrders(pbOf([A]), serial, rep, exec) // 重放
  await tick()
  assert.deepEqual(seen, ['A'])
})

test('运动类串行 FIFO：B 在 A 结束后才起', async () => {
  const serial = 'S-serial'
  const started: string[] = []
  const gate: Record<string, () => void> = {}
  const exec = (o: PlantbotOrder) => {
    started.push(o.id)
    return new Promise<void>((res) => (gate[o.id] = res))
  }
  const A = order('goto', 'A', 1)
  const B = order('goto', 'B', 2)
  await pumpOrders(pbOf([A, B]), serial, rep, exec)
  await tick()
  assert.deepEqual(started, ['A'], '只有 A 起飞，B 排队')
  gate['A']() // A 结束
  await tick()
  await tick()
  assert.deepEqual(started, ['A', 'B'], 'A 结算后 B 才起')
  gate['B']()
  await tick()
})

test('preempt：运动在飞 + 新运动到达 → preempt(inflight, incoming) 被调用', async () => {
  const serial = 'S-preempt'
  const started: string[] = []
  const gate: Record<string, () => void> = {}
  const exec = (o: PlantbotOrder) => {
    started.push(o.id)
    return new Promise<void>((res) => (gate[o.id] = res))
  }
  const preemptCalls: [string, string][] = []
  const preempt = (inflight: PlantbotOrder, incoming: PlantbotOrder) => {
    preemptCalls.push([inflight.id, incoming.id])
    gate[inflight.id]?.() // adapter 取消在飞任务 → 其 exec Promise 结束
  }
  const A = order('goto', 'A', 1)
  await pumpOrders(pbOf([A]), serial, rep, exec, { preempt })
  await tick()
  assert.deepEqual(started, ['A'])
  const B = order('mission', 'B', 2)
  await pumpOrders(pbOf([B]), serial, rep, exec, { preempt })
  await tick()
  await tick()
  assert.deepEqual(preemptCalls, [['A', 'B']], 'preempt(A,B) 恰好一次')
  assert.deepEqual(started, ['A', 'B'], '抢占后 B 起飞')
  gate['B']?.()
  await tick()
})

test('干预类立即执行：pause 不排在在飞 goto 之后', async () => {
  const serial = 'S-intervene'
  const started: string[] = []
  const gate: Record<string, () => void> = {}
  const exec = (o: PlantbotOrder) => {
    started.push(o.id)
    if (o.kind === 'goto') return new Promise<void>((res) => (gate[o.id] = res))
  }
  const A = order('goto', 'A', 1)
  const P = order('pause', 'P', 2)
  await pumpOrders(pbOf([A, P]), serial, rep, exec)
  await tick()
  assert.ok(started.includes('A'), 'goto 起飞（仍在飞）')
  assert.ok(started.includes('P'), 'pause 未被 goto 阻塞，立即执行')
  gate['A']?.()
  await tick()
})

test('异常被捕获：抛错的 exec 不卡泵，后续单照跑并 warn', async () => {
  const serial = 'S-throw'
  const started: string[] = []
  const exec = (o: PlantbotOrder) => {
    started.push(o.id)
    if (o.id === 'BAD') throw new Error('boom')
  }
  const warns: string[] = []
  const log = { info() {}, warn: (m: string) => void warns.push(m) }
  const BAD = order('goto', 'BAD', 1)
  const GOOD = order('goto', 'GOOD', 2)
  await pumpOrders(pbOf([BAD, GOOD]), serial, rep, exec, { log })
  await tick()
  await tick()
  assert.deepEqual(started, ['BAD', 'GOOD'], 'BAD 抛错后 GOOD 仍执行')
  assert.ok(warns.some((w) => /BAD/.test(w)), 'warn 记录了抛错订单')
})

test('createdAt 排序：一批内按请求时间 FIFO', async () => {
  const serial = 'S-order'
  const started: string[] = []
  const gate: Record<string, () => void> = {}
  const exec = (o: PlantbotOrder) => {
    started.push(o.id)
    return new Promise<void>((res) => (gate[o.id] = res))
  }
  // 乱序投递，createdAt 反序
  const late = order('goto', 'late', 200)
  const early = order('goto', 'early', 100)
  await pumpOrders(pbOf([late, early]), serial, rep, exec)
  await tick()
  assert.deepEqual(started, ['early'], 'createdAt 小者先执行')
  gate['early']()
  await tick()
  await tick()
  assert.deepEqual(started, ['early', 'late'])
  gate['late']()
  await tick()
})
