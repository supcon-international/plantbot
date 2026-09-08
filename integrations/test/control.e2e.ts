import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { standUpVendor, waitFor, api, integration, type VendorStack, simsAvailable } from './harness.js'

describe('Native manual controls', {skip:!simsAvailable()}, () => {
const SITE = 'plant-07', RID = 'ext-bd-91250107', SN = 'BD-91250107'
let vs: VendorStack
const path = `/api/sites/${SITE}/robots/${RID}/control`
before(async () => {
  vs = await standUpVendor({ port: 18821, site: SITE, robotId: RID, serial: SN,
    sim: { entry: 'spot/sim/main.ts', env: { SPOT_SIM_PORT: '19021', SPOT_SIM_FAULT_S: '0' }, tag: 'control-sim' },
    adapter: { entry: 'spot/adapter/main.ts', env: base => ({ SPOT_PORT: '19021', PLANTBOT_BASE: base, PLANTBOT_KEY: 'pbk_dev_plant07' }), tag: 'control-adapter' } })
  await new Promise(r => setTimeout(r, 1500))
})
after(() => vs?.stop())
async function input(id: string, token: string, sequence: number, axes: Record<string, number>) {
  const r = await fetch(`${vs.stack.base}${path}/${id}/input`, { method: 'PUT', headers: { cookie: vs.stack.cookie, 'x-control-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ sequence, axes }) })
  return { status: r.status, body: await r.json() as any }
}
async function state() {
  const r = await integration(vs.stack.base, 'pbk_dev_plant07', 'GET', '/fleet')
  return r.body.telemetry.find((t: any) => t.id === RID)
}
async function acquire(target = 'drive', channelId?: string) {
  const r = await api(vs.stack, 'POST', path, { target, channelId })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  await waitFor(async () => (await api(vs.stack, 'GET', path)).body.session?.status === 'active', 4000, 'adapter readiness', 100)
  return { id: r.body.session.id, token: r.body.token }
}
async function release(id: string, token: string) {
  const r = await fetch(`${vs.stack.base}${path}/${id}`, { method: 'DELETE', headers: { cookie: vs.stack.cookie, 'x-control-token': token } })
  assert.equal(r.status, 200)
  await waitFor(async () => !(await api(vs.stack, 'GET', path)).body.session, 5000, 'stop confirmation', 100)
}

test('manual driving: exclusive lease, ordered input, native movement and release stop', { timeout: 20_000 }, async () => {
  const initial = await state()
  const { id, token } = await acquire()
  assert.equal((await api(vs.stack, 'POST', path, { target: 'drive' })).status, 409)
  assert.equal((await input(id, 'wrong', 0, { forward: 0.2 })).status, 403)
  assert.equal((await input(id, token, 0, { forward: 5 })).status, 400)
  for (let i = 1; i <= 12; i++) {
    assert.equal((await input(id, token, i, { forward: 0.4 })).status, 200)
    await new Promise(r => setTimeout(r, 160))
  }
  assert.equal((await input(id, token, 1, { forward: 0.4 })).status, 409)
  const moved = await state()
  assert.ok(Math.hypot(moved.x - initial.x, moved.z - initial.z) > 0.15, JSON.stringify({ initial, moved }))
  const blocked = await api(vs.stack, 'POST', `/api/sites/${SITE}/robots/${RID}/commands`, { type: 'dock' })
  assert.equal(blocked.body.command.accepted, false)
  await release(id, token)
  await new Promise(r => setTimeout(r, 1200))
  assert.equal((await state()).speed, 0)
  assert.equal((await input(id, token, 30, { forward: 0.4 })).status, 409)
})

test('manual driving: lost operator heartbeat expires and cannot replay', { timeout: 12_000 }, async () => {
  const { id, token } = await acquire()
  await input(id, token, 1, { forward: 0.3 })
  await waitFor(async () => !(await api(vs.stack, 'GET', path)).body.session, 5000, 'heartbeat expiry stops robot', 100)
  assert.equal((await state()).speed, 0)
  assert.equal((await input(id, token, 2, { forward: 0.3 })).status, 409)
})

test('Spot CAM: manual pan/zoom, measured pose and durable preset execution', { timeout: 20_000 }, async () => {
  const cameras = (await api(vs.stack, 'GET', path)).body.cameras
  const camera = cameras.find((c: any) => c.ptz?.manual === 'position')
  assert.ok(camera, 'discovered native Spot CAM capability')
  const { id, token } = await acquire('ptz', camera.id)
  for (let i = 1; i <= 6; i++) { await input(id, token, i, { pan: 1, zoom: 1 }); await new Promise(r => setTimeout(r, 180)) }
  const pose = await waitFor(async () => {
    const c = (await api(vs.stack, 'GET', path)).body.cameras.find((c: any) => c.id === camera.id)
    return c.position?.pan > 1 && c.position.zoom > 1 ? c.position : null
  }, 3000, 'PTZ measured movement', 100)
  assert.ok(pose.pan <= 12)
  await release(id, token)
  const preset = await api(vs.stack, 'POST', `/api/sites/${SITE}/ptz/presets`, { name: 'Control test', channelId: camera.id, pan: 20, tilt: 10, zoom: 2 })
  assert.equal(preset.status, 200, JSON.stringify(preset.body))
  const run = await api(vs.stack, 'POST', `/api/sites/${SITE}/ptz/presets/${preset.body.preset.id}/recall`, {})
  assert.equal(run.status, 200, JSON.stringify(run.body))
  await waitFor(async () => {
    const b = (await api(vs.stack, 'GET', `/api/sites/${SITE}/ptz`)).body
    return b.runs.find((r: any) => r.id === run.body.run.id)?.status === 'done'
  }, 8000, 'PTZ arrives before done', 100)
})

test('control permissions and receipts cannot cross robots or sites', async () => {
  const guest = await fetch(`${vs.stack.base}${path}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'drive'})})
  assert.equal(guest.status,401)
  const {id,token}=await acquire()
  const visible=(await api(vs.stack,'GET',path)).body.session
  assert.equal('tokenHash' in visible,false)
  assert.equal('token' in visible,false)
  const wrong=await integration(vs.stack.base,'pbk_dev_campuseast','POST',`/robots/${SN}/control`,{id,sequence:0,status:'stopped'})
  assert.equal(wrong.status,404)
  assert.equal((await integration(vs.stack.base,'pbk_dev_plant07','POST',`/robots/${SN}/control`,{id,sequence:999,status:'stopped'})).status,409)
  await release(id,token)
})

test('cancelling native camera motion waits for stop before unlocking', {timeout:12000}, async()=>{
 const camera=(await api(vs.stack,'GET',path)).body.cameras.find((c:any)=>c.ptz?.manual)
 const preset=(await api(vs.stack,'POST',`/api/sites/${SITE}/ptz/presets`,{name:'Cancel test',channelId:camera.id,pan:330,tilt:80,zoom:20})).body.preset
 const run=(await api(vs.stack,'POST',`/api/sites/${SITE}/ptz/presets/${preset.id}/recall`,{})).body.run
 await new Promise(r=>setTimeout(r,650))
 const cancelled=await api(vs.stack,'POST',`/api/sites/${SITE}/ptz/runs/${run.id}/cancel`,{})
 assert.equal(cancelled.body.run.status,'cancelled')
 assert.ok(cancelled.body.run.stopOrderId)
 await waitFor(async()=>{
  const r=(await api(vs.stack,'GET',`/api/sites/${SITE}/ptz`)).body.runs.find((r:any)=>r.id===run.id)
  return !r.interlocked && r.note==='Camera stop confirmed by adapter'
 },5000,'verified camera stop',100)
 const {id,token}=await acquire('ptz',camera.id)
 await release(id,token)
})

test('confirmed takeover reserves the robot before terminating navigation', {timeout:15000}, async()=>{
 await api(vs.stack,'POST',`/api/sites/${SITE}/robots/${RID}/goto`,{x:12,z:-5})
 await new Promise(r=>setTimeout(r,600))
 assert.equal((await api(vs.stack,'POST',path,{target:'drive'})).status,409)
 const r=await api(vs.stack,'POST',path,{target:'drive',interrupt:true})
 assert.equal(r.status,201,JSON.stringify(r.body))
 let seq=1
 const keep=setInterval(()=>void input(r.body.session.id,r.body.token,seq++,{}),200)
 try {
  await waitFor(async()=>(await api(vs.stack,'GET',path)).body.session?.status==='active',8000,'navigation ended before manual readiness',100)
 } finally { clearInterval(keep) }
 await release(r.body.session.id,r.body.token)
})

})
