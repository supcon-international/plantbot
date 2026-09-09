#!/usr/bin/env node
// Verify an extracted, offline Adapter Demo archive using only its packaged images.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archive = process.argv[2] && resolve(process.argv[2])
if (!archive) throw new Error('Pass plantbot-adapter-demo-vX.Y.Z-linux-ARCH.tar.gz')
const work = mkdtempSync(join(tmpdir(), 'pb-demo-qa-')), project = `pb-demo-qa-${Date.now()}`
const out = join(root, 'demos/demo-package-qa')
mkdirSync(out, { recursive: true })
const checks = []
let folder, base, cookie = '', log = '', manifest
async function run(command, args, cwd = folder ?? root, env = {}, captureSensitive = false) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] })
  let output = '', stdout = ''
  child.stdout.on('data', b => { stdout += b })
  for (const stream of [child.stdout,child.stderr]) stream.on('data', b => { output += b; if (!captureSensitive) log += b })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${command} failed (${code}): ${captureSensitive ? '[sensitive output withheld]' : output.slice(-2000)}`)
  return (captureSensitive ? stdout : output).trim()
}
const compose = (...args) => run('docker', ['compose','-p',project,'--env-file','.env.demo','-f','compose.yaml',...args])
const composePrivate = (...args) => run('docker', ['compose','-p',project,'--env-file','.env.demo','-f','compose.yaml',...args], folder, {}, true)
async function freePort() {
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening')
  const port = server.address().port; await new Promise(r => server.close(r)); return port
}
async function api(path, method = 'GET', body) {
  const r = await fetch(base+'/api'+path, { method, signal: AbortSignal.timeout(15000), headers: { cookie, 'content-type':'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await r.json(); assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(result)}`); return result
}
async function wait(fn, label, timeout = 180000) {
  const end = Date.now()+timeout
  while (Date.now()<end) { const value = await fn(); if (value) return value; await new Promise(r=>setTimeout(r,1000)) }
  throw new Error('Timeout: '+label)
}
try {
  await run('tar',['-xzf',archive,'-C',work],root)
  folder = join(work,readdirSync(work)[0])
  await run('shasum',['-a','256','--check','SHA256SUMS'])
  manifest = JSON.parse(readFileSync(join(folder,'release.json')))
  assert.equal(manifest.component,'adapter-demo')
  assert.equal(manifest.simulator.revision,'49ba9419ca245f5e060a597bb75bb9d12be9d919')
  for (const name of ['api','gateway','relay','demo-adapter','vision-demo']) assert.ok(manifest.images[name]?.id)
  assert.doesNotMatch(readFileSync(join(folder,'compose.yaml'),'utf8'), /\bbuild:/)
  const port = await freePort(), rtspPort = await freePort()
  base = `http://127.0.0.1:${port}/robots`
  await run('bash',['start.sh'],folder,{PB_DEMO_PROJECT:project,PLANTBOT_PORT:String(port),PB_DEMO_RTSP_PORT:String(rtspPort)})
  const credentials = readFileSync(join(folder,'.env.demo'),'utf8')
  const password = credentials.match(/^PB_ADMIN_PASSWORD=(.+)$/m)?.[1]
  assert.ok(password)
  const auth = await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})})
  assert.equal(auth.status,200); cookie=auth.headers.get('set-cookie').split(';')[0]
  const health = await api('/health'); assert.equal(health.demo,false)
  assert.deepEqual((await api('/sites')).sites.map(s=>s.id),['demo-lab'])
  checks.push('Complete offline package starts without build/model downloads; dedicated demo-lab and random Server alarms disabled')
  const S='/sites/demo-lab'
  const installed = JSON.parse(await composePrivate('exec','-T','demo-adapter','node','-e',"console.log(require('node:fs').readFileSync('/config/installation.json','utf8'))"))
  // Keep secrets out of QA artefacts; this key is used only for readback.
  const fleet = async () => {
    const r=await fetch(base+'/api/integration/v1/fleet',{headers:{authorization:`Bearer ${installed.key}`}})
    assert.ok(r.ok); return r.json()
  }
  const f=await fleet()
  for(const id of ['ext-demo-spot','ext-demo-x30','ext-demo-f2']) assert.ok(f.telemetry.some(t=>t.id===id&&t.mode!=='offline'),id)
  checks.push('Spot, X30 and F2 native simulators register through the production Adapter runtime')
  const observed = await wait(async()=>{
    const data=await api(S+'/vision'), records=data.results.filter(r=>!r.jobId&&!r.late).sort((a,b)=>a.capturedAt-b.capturedAt)
    const ocr=records.filter(r=>r.config.preset==='ocr')
    const first=ocr.find(r=>r.status==='normal'&&r.value===70)
    const alarm=first&&ocr.find(r=>r.capturedAt>first.capturedAt&&r.status==='alert'&&r.value===85.2&&r.eventId)
    const recovery=alarm&&ocr.find(r=>r.capturedAt>alarm.capturedAt&&r.status==='normal'&&r.value===72)
    const occupied=records.find(r=>r.config.preset==='people_count'&&r.status==='normal'&&r.value===1&&!r.eventId)
    const vacant=occupied&&records.find(r=>r.config.preset==='people_count'&&r.capturedAt>occupied.capturedAt&&r.status==='normal'&&r.value===0)
    const intrusion=records.find(r=>r.config.preset==='intrusion'&&r.status==='alert'&&r.eventId)
    const clear=intrusion&&records.find(r=>r.config.preset==='intrusion'&&r.capturedAt>intrusion.capturedAt&&r.status==='normal')
    return recovery&&vacant&&clear ? {first,alarm,recovery,occupied,vacant,intrusion,clear} : null
  },'real OCR normal → 85.2 alert → recovery plus person counting/intrusion and clearing',240000)
  const events=(await api(S+'/events')).events
  const event=events.find(e=>e.id===observed.alarm.eventId)
  assert.ok(event); assert.equal(event.lifecycle,'new','Recovered reading must not falsely claim manual resolution')
  for(const result of [observed.alarm,observed.intrusion]) {
    const r=await fetch(new URL(result.evidence,base),{headers:{cookie}})
    assert.equal(r.status,200); const image=Buffer.from(await r.arrayBuffer())
    assert.equal(image.readUInt16BE(0),0xffd8); assert.ok(image.length>1000)
  }
  checks.push('Actual packaged ONNX/OCR produce 70 → 85.2 → 72, person 0/1, real alert/recovery and protected JPEG evidence; counting stays observational')
  const native = await Promise.allSettled(['ext-demo-spot','ext-demo-x30','ext-demo-f2'].map(async id => {
    const {mission} = await api(S+'/missions','POST',{name:`Demo package QA · ${id}`,requestedRobot:id,steps:[
      {waypointId:'DEMO-WP-1',actions:[{type:'capture_photo',durationS:3}]},
      {waypointId:'DEMO-WP-2',actions:[{type:'capture_photo',durationS:3}]}]})
    await wait(async()=> (await api(S+'/missions')).missions.some(m=>m.id===mission.id&&m.status==='active'),`${id} mission starts`,30000)
    for(const type of ['pause','resume']) {
      const {command}=await api(`${S}/robots/${id}/commands`,'POST',{type})
      assert.equal(command.accepted,true)
      const order=await wait(async()=> (await api(S+'/integrations')).orders.find(o=>o.robotId===id&&o.kind===type&&o.payload?.missionId===mission.id&&['done','failed'].includes(o.state)),`${id} ${type} native acknowledgement`,30000)
      assert.equal(order.state,id==='ext-demo-x30'?'failed':'done',`${id} ${type} capability must remain honest`)
      if(id==='ext-demo-x30') assert.match(order.note,/no pause\/resume/i)
      if(type==='pause'&&id!=='ext-demo-x30') {
        const a=(await fleet()).telemetry.find(t=>t.id===id)
        await new Promise(r=>setTimeout(r,1800))
        const b=(await fleet()).telemetry.find(t=>t.id===id)
        assert.ok(Math.hypot(a.x-b.x,a.z-b.z)<.3,`${id} keeps moving after pause acknowledgement`)
      }
    }
    const done=await wait(async()=>{
      const m=(await api(S+'/missions')).missions.find(m=>m.id===mission.id)
      if(['failed','aborted'].includes(m?.status)) throw new Error(`${id} native mission ${m.status}`)
      return m?.status==='done'?m:null
    },`${id} native mission finishes`,180000)
    assert.ok(done.results.some(r=>r.ok&&r.note),`${id} completed route retains its Adapter completion receipt`)
    await wait(async()=> (await fleet()).telemetry.some(t=>t.id===id&&Math.hypot(t.x-4,t.z-3)<.8),`${id} really reached the final waypoint`,15000)
    const {command}=await api(`${S}/robots/${id}/commands`,'POST',{type:'dock'})
    assert.equal(command.accepted,true)
    await wait(async()=> (await fleet()).telemetry.some(t=>t.id===id&&t.mode==='charging'),`${id} native docking reaches charging`,150000)
    return id
  }))
  for(const result of native) if(result.status==='rejected') throw result.reason
  checks.push('Three native brands finish two-point missions and dock; Spot/F2 pause and resume physically, X30 correctly rejects unsupported pause/resume')
  await compose('exec','-T','demo-adapter','ffprobe','-v','error','-rtsp_transport','tcp','-timeout','5000000','-read_intervals','%+1','-show_entries','stream=codec_name','-of','json','rtsp://127.0.0.1:8554/instrument')
  checks.push('Packaged H.264 source is available through real RTSP')
  const before=(await api(S+'/vision')).configs.map(c=>[c.id,c.revision])
  await compose('run','--rm','--no-deps','demo-seed')
  await compose('run','--rm','--no-deps','demo-seed','--rules')
  assert.deepEqual((await api(S+'/vision')).configs.map(c=>[c.id,c.revision]),before)
  checks.push('Repeated demo bootstrap is idempotent and does not rewrite monitoring configuration')
  writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,version:manifest.version,revision:manifest.revision,checks,observed},null,2))
  console.log(JSON.stringify({passed:true,checks},null,2))
} catch(error) {
  writeFileSync(join(out,'result.json'),JSON.stringify({passed:false,error:String(error),checks,version:manifest?.version,revision:manifest?.revision},null,2))
  console.error(error); process.exitCode=1
} finally {
  if(folder) await compose('--profile','server','down','-v').catch(()=>{})
  rmSync(work,{recursive:true,force:true})
}
