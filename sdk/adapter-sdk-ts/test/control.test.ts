import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pumpControl, type ControlFrame, type ManualController } from '../dist/control.js'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const frame = (more: Partial<ControlFrame> = {}): ControlFrame => ({ id: 'lease', sequence: 1, target: 'drive', status: 'active', axes: { forward: .2 }, remainingMs: 140, ...more })
function rig(read: () => Promise<{frame: ControlFrame | null} | null>, override: Partial<ManualController> = {}) {
  const events: string[] = [], receipts: any[] = []
  const pump = pumpControl({ control: read, controlStatus: async (_serial: string, receipt: any) => { receipts.push(receipt); return {ok:true} } } as any, 'robot', {
    start: async () => { events.push('start') }, apply: async () => { events.push('apply') }, stop: async () => { events.push('stop') }, ...override,
  })
  return { pump, events, receipts }
}
test('input is applied once; repeated poll does not extend its watchdog', async () => {
  const r = rig(async () => ({frame: frame()}))
  await sleep(420); await r.pump.stop()
  assert.equal(r.events.filter(x=>x==='apply').length,1)
  assert.ok(r.events.includes('stop'))
})
test('slow response consumes remaining TTL and never starts motion', async () => {
  const r=rig(async()=>{await sleep(180); return {frame:frame()}})
  await sleep(300);await r.pump.stop()
  assert.equal(r.events.includes('apply'),false)
})
test('platform connection loss stops and latches failure', async () => {
  let n=0
  const r=rig(async()=> ++n===1 ? {frame:frame()} : null)
  await sleep(320);await r.pump.stop()
  assert.ok(r.receipts.some(x=>x.status==='failed'))
  assert.equal(r.events.filter(x=>x==='apply').length,1)
  assert.ok(r.events.includes('stop'))
})
test('slow apply is followed by a final stop after the command resolves', async () => {
  const order:string[]=[]
  const r=rig(async()=>({frame:frame({remainingMs:60})}),{
    apply:async()=>{order.push('begin');await sleep(180);order.push('settled')},
    stop:async()=>{order.push('stop');await sleep(100)},
  })
  await sleep(400);await r.pump.stop()
  assert.ok(order.indexOf('stop')<order.indexOf('settled'))
  assert.ok(order.lastIndexOf('stop')>order.indexOf('settled'))
})
test('unconfirmed stop never emits stopped receipt or resumes a failed lease', async () => {
  let reads=0
  const r=rig(async()=>({frame:frame({sequence:++reads,status:reads>1?'stopping':'active'})}), {stop:async()=>{throw new Error('unreachable robot')}})
  await sleep(320);await r.pump.stop().catch(()=>{})
  assert.ok(r.receipts.some(x=>x.status==='failed'))
  assert.equal(r.receipts.some(x=>x.status==='stopped'),false)
  assert.equal(r.events.filter(x=>x==='apply').length,1)
})
