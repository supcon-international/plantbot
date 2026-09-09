#!/usr/bin/env node
// Verify an extracted, offline Adapter Demo archive using only its packaged images.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
const secrets = new Set()
const externalProject = `${project}-external`, serverProject = `${project}-server`
let externalReady = false, serverFixtureReady = false
let folder, base, cookie = '', log = '', manifest
function redact(value) {
  let text = String(value)
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]')
  return text.replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:siteKey|apiKey|password|session_secret|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/rtsp:\/\/[^\s/@]+:[^\s/@]+@/gi, 'rtsp://[redacted]@')
}
async function run(command, args, cwd = folder ?? root, env = {}, captureSensitive = false) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] })
  let output = '', stdout = ''
  child.stdout.on('data', b => { stdout += b })
  for (const stream of [child.stdout,child.stderr]) stream.on('data', b => { output += b; if (!captureSensitive) log += b })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${command} failed (${code}): ${captureSensitive ? '[sensitive output withheld]' : redact(output.slice(-2000))}`)
  return (captureSensitive ? stdout : output).trim()
}
const compose = (...args) => run('docker', ['compose','-p',project,'--env-file','.env.demo','-f','compose.yaml',...args])
const composePrivate = (...args) => run('docker', ['compose','-p',project,'--env-file','.env.demo','-f','compose.yaml',...args], folder, {}, true)
const externalCompose = (...args) => run('docker', ['compose','-p',externalProject,'--env-file','.env.external','-f','compose.yaml',...args])
const externalPrivate = (...args) => run('docker', ['compose','-p',externalProject,'--env-file','.env.external','-f','compose.yaml',...args], folder, {}, true)
const serverCompose = (...args) => run('docker', ['compose','-p',serverProject,'--env-file','.env.external','-f','qa-server.json',...args])
async function login(password) {
  secrets.add(password)
  const auth = await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})})
  assert.equal(auth.status,200)
  cookie=auth.headers.get('set-cookie').split(';')[0]; secrets.add(cookie)
}
async function noRandomNativeAlarms(command) {
  // Match the production entrypoint's unprivileged UID; container root lacks
  // SYS_PTRACE and cannot read another UID's /proc/<pid>/environ.
  const policy=JSON.parse(await command('exec','--user','1000:1000','-T','demo-adapter','node','-e',`
    const fs=require('node:fs'), policies={f2:[],x30:[]};
    for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))) {
      try {
        const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
        for(const [vendor,path,flag] of [['f2','gosuncn/sim/main.ts','GOSUNCN_SIM_ALARMS=0'],['x30','deeprobotics/sim/main.ts','DR_SIM_FAULTS=0']]) {
          if(args.some(x=>x===path||x.endsWith('/'+path))) {
            policies[vendor].push(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0').includes(flag));
          }
        }
      } catch(error) { if(error.code!=='ENOENT') throw new Error('Cannot inspect simulator process '+pid+': '+error.code); }
    }
    console.log(JSON.stringify(Object.fromEntries(Object.entries(policies).map(([vendor,states])=>[vendor,{processes:states.length,disabled:states.length>0&&states.every(Boolean)}]))));
  `))
  assert.ok(policy.f2.disabled,`Actual F2 simulator processes must disable random inspection and native fault generation: ${JSON.stringify(policy.f2)}`)
  assert.ok(policy.x30.disabled,`Actual X30 simulator processes must disable random localization faults: ${JSON.stringify(policy.x30)}`)
  const events=(await api('/sites/demo-lab/events?limit=500')).events
  assert.ok(events.every(e=>['vision-ocr','vision-intrusion'].includes(e.type)),'All demo Events must come from the real visual rules')
  const nativeLogs=await command('logs','--no-color','demo-adapter')
  assert.doesNotMatch(nativeLogs,/\[gosuncn-adp\].*(?:告警上报|本体故障上报)/,'Native F2 random alarms must remain absent for the full observed run')
  assert.doesNotMatch(nativeLogs,/\[deepro-adp\].*上报定位丢失故障事件/,'Native X30 random localization faults must remain absent for the full observed run')
}
async function diagnostics() {
  if (!folder) return
  const stacks = [['complete', compose], ...(externalReady ? [['external', externalCompose]] : []), ...(serverFixtureReady ? [['existing-server', serverCompose]] : [])]
  const messages = []
  for (const [name, command] of stacks) {
    for (const args of [['--profile','server','ps','--all'], ['--profile','server','logs','--no-color','--tail','150']]) {
      try { messages.push(`${name}: ${args.join(' ')}\n${await command(...args)}`) }
      catch (error) { messages.push(`${name}: ${String(error)}`) }
    }
  }
  writeFileSync(join(out,'failure.log'),redact(messages.join('\n\n')))
}
async function freePort() {
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening')
  const port = server.address().port; await new Promise(r => server.close(r)); return port
}
async function api(path, method = 'GET', body) {
  const r = await fetch(base+'/api'+path, { method, signal: AbortSignal.timeout(15000), headers: { cookie, ...(body !== undefined ? {'content-type':'application/json'} : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
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
  const demoPack=JSON.parse(readFileSync(join(folder,'demo.pack.json')))
  const expectedSimulator=JSON.parse(readFileSync(join(root,'integrations/demo/pack.json'))).simulator
  assert.match(demoPack.simulator.revision,/^[a-f0-9]{40}$/,'Demo must pin an exact simulator commit')
  assert.equal(manifest.simulator.revision,demoPack.simulator.revision)
  assert.deepEqual(demoPack.simulator,expectedSimulator,'Packaged simulator pin must match the release source')
  assert.equal(demoPack.mediaRevision,'recorded-2026-09-v1')
  for (const name of ['api','gateway','relay','demo-adapter','vision-demo']) assert.ok(manifest.images[name]?.id)
  assert.doesNotMatch(readFileSync(join(folder,'compose.yaml'),'utf8'), /\bbuild:/)
  const port = await freePort(), rtspPort = await freePort()
  base = `http://127.0.0.1:${port}/robots`
  await run('bash',['start.sh'],folder,{PB_DEMO_PROJECT:project,PLANTBOT_PORT:String(port),PB_DEMO_RTSP_PORT:String(rtspPort)})
  const credentials = readFileSync(join(folder,'.env.demo'),'utf8')
  const password = credentials.match(/^PB_ADMIN_PASSWORD=(.+)$/m)?.[1]
  assert.ok(password)
  for (const line of credentials.split('\n')) if (/^(?:SESSION_SECRET|PB_\w+_PASSWORD)=/.test(line)) secrets.add(line.slice(line.indexOf('=')+1))
  await login(password)
  const health = await api('/health'); assert.equal(health.demo,false)
  assert.deepEqual((await api('/sites')).sites.map(s=>s.id),['demo-lab'])
  checks.push('Complete offline package starts without build/model downloads; dedicated demo-lab and random Server alarms disabled')
  const S='/sites/demo-lab'
  const installed = JSON.parse(await composePrivate('exec','-T','demo-adapter','node','-e',"console.log(require('node:fs').readFileSync('/config/installation.json','utf8'))"))
  secrets.add(installed.key)
  assert.equal(installed.mediaRevision,demoPack.mediaRevision)
  const beforeLegacyProbe=await api(S+'/vision')
  await compose('exec','-T','demo-adapter','node','-e',"const fs=require('node:fs'),p='/config/installation.json';fs.copyFileSync(p,p+'.qa-backup');const state=JSON.parse(fs.readFileSync(p));delete state.mediaRevision;fs.writeFileSync(p,JSON.stringify(state));")
  try {
    await assert.rejects(compose('run','--rm','--no-deps','demo-seed'),/legacy synthetic.*incompatible.*existing rules and history were preserved/)
  } finally {
    await compose('exec','-T','demo-adapter','node','-e',"const fs=require('node:fs'),p='/config/installation.json';fs.renameSync(p+'.qa-backup',p);")
  }
  assert.deepEqual((await api(S+'/vision')).configs,beforeLegacyProbe.configs,'Legacy installation refusal preserves all existing monitoring rules')
  checks.push('Legacy media state fails explicitly without changing rules; the same installation file is restored before restart tests')
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
    for(const r of ocr) {
      if(['unknown','failed'].includes(r.status)) assert.equal(r.value,null,'Unavailable OCR must not claim a temperature or recovery')
      else {
        assert.ok([31.1,32.3,32.6,33.1,33.2,34.3].includes(r.value),`Unexpected real IR display value: ${r.value}`)
        assert.equal(r.status,r.value>33?'alert':'normal')
      }
    }
    const first=ocr.find(r=>r.status==='normal'&&[31.1,32.3,32.6].includes(r.value))
    const alarm=first&&ocr.find(r=>r.capturedAt>first.capturedAt&&r.status==='alert'&&[33.1,33.2,34.3].includes(r.value)&&r.eventId)
    const recovery=alarm&&ocr.find(r=>r.capturedAt>alarm.capturedAt&&r.status==='normal'&&[31.1,32.3,32.6].includes(r.value))
    const occupied=records.find(r=>r.config.preset==='people_count'&&r.status==='normal'&&r.value===1&&!r.eventId)
    const vacant=occupied&&records.find(r=>r.config.preset==='people_count'&&r.capturedAt>occupied.capturedAt&&r.status==='normal'&&r.value===0)
    const intrusion=records.find(r=>r.config.preset==='intrusion'&&r.status==='alert'&&r.eventId)
    const clear=intrusion&&records.find(r=>r.config.preset==='intrusion'&&r.capturedAt>intrusion.capturedAt&&r.status==='normal')
    return recovery&&vacant&&clear ? {first,alarm,recovery,occupied,vacant,intrusion,clear} : null
  },'recorded IR normal → over 33℃ alert → observed recovery plus real person counting/intrusion and clearing',240000)
  const events=(await api(S+'/events')).events
  const event=events.find(e=>e.id===observed.alarm.eventId)
  assert.ok(event); assert.equal(event.lifecycle,'new','Recovered reading must not falsely claim manual resolution')
  for(const result of [observed.alarm,observed.intrusion]) {
    const r=await fetch(new URL(result.evidence,base),{headers:{cookie}})
    assert.equal(r.status,200); const image=Buffer.from(await r.arrayBuffer())
    assert.equal(image.readUInt16BE(0),0xffd8); assert.ok(image.length>1000)
  }
  checks.push('Actual packaged ONNX/OCR read 31.1–34.3℃ across the 33℃ threshold; recorded people enter and leave, real alerts recover with protected JPEG evidence; unknown is never recovery and counting stays observational')
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
  await noRandomNativeAlarms(compose)
  checks.push('Pinned F2/X30 simulators run with random inspection/native fault generation disabled; only actual OCR/intrusion Events occur')
  await compose('exec','-T','demo-adapter','ffprobe','-v','error','-rtsp_transport','tcp','-timeout','5000000','-read_intervals','%+1','-show_entries','stream=codec_name','-of','json','rtsp://127.0.0.1:8554/instrument')
  checks.push('Packaged H.264 source is available through real RTSP')
  const before=(await api(S+'/vision')).configs.map(c=>[c.id,c.revision])
  await compose('run','--rm','--no-deps','demo-seed')
  await compose('run','--rm','--no-deps','demo-seed','--rules')
  assert.deepEqual((await api(S+'/vision')).configs.map(c=>[c.id,c.revision]),before)
  checks.push('Repeated demo bootstrap is idempotent and does not rewrite monitoring configuration')
  const originalRule=(await api(S+'/vision')).configs.find(c=>c.preset==='ocr')
  const stoppedRule=await api(`${S}/vision/configs/${originalRule.id}`,'PUT',{...originalRule,enabled:false})
  assert.equal(stoppedRule.enabled,false); assert.equal(stoppedRule.revision,originalRule.revision+1)
  const configState=(await api(S+'/vision')).configs.sort((a,b)=>a.id.localeCompare(b.id))
  const savedEvent=(await api(`${S}/events/${observed.alarm.eventId}`)).event
  const savedObservation=await api(`${S}/vision/results/${observed.alarm.id}`)
  await compose('--profile','server','stop')
  assert.equal((await compose('--profile','server','ps','--status','running','--quiet')).trim(),'','Every complete-stack service really stopped')
  await run('bash',['start.sh'],folder,{PB_DEMO_PROJECT:project})
  await login(password)
  assert.deepEqual((await api(S+'/vision')).configs.sort((a,b)=>a.id.localeCompare(b.id)),configState,'Full restart retains every rule, disabled state and revision')
  assert.deepEqual((await api(`${S}/events/${savedEvent.id}`)).event,savedEvent,'Full restart keeps the original event and lifecycle')
  assert.deepEqual(await api(`${S}/vision/results/${observed.alarm.id}`),savedObservation,'Frozen observation and event association survive restart')
  await wait(async()=>{
    const current=await fleet()
    return ['ext-demo-spot','ext-demo-x30','ext-demo-f2'].every(id=>current.telemetry.some(t=>t.id===id&&t.mode!=='offline'))
  },'all three native robots report online again after a complete restart',45000)
  checks.push('Full stop/start preserves disabled OCR rule, exact revisions/count, frozen observation and original event; all three native robots reconnect')
  // Test the shipped --external entry point against a separate, clean Server.
  // Its sole API service joins the demo network; no host-specific DNS is needed.
  await compose('--profile','server','stop')
  const externalPassword=randomBytes(24).toString('hex'), externalSecret=randomBytes(32).toString('hex')
  secrets.add(externalPassword); secrets.add(externalSecret)
  const externalPort=await freePort(), externalRtspPort=await freePort()
  writeFileSync(join(folder,'.env.external'),[
    'PB_DEMO_MODE=external','PB_DEMO_SERVER_URL=http://external-server:8787',
    'PB_DEMO_RTSP_BASE=rtsp://demo-adapter:8554','PB_DEMO_ADMIN_USER=admin',
    `PB_ADMIN_PASSWORD=${externalPassword}`,`SESSION_SECRET=${externalSecret}`,
    `PB_DEMO_RTSP_PORT=${externalRtspPort}`,
  ].join('\n')+'\n',{mode:0o600})
  externalReady=true
  await externalCompose('create','--no-build','--pull','never','demo-adapter','vision')
  writeFileSync(join(folder,'qa-server.json'),JSON.stringify({services:{'existing-api':{
    image:manifest.images.api.tag,platform:manifest.platform,pull_policy:'never',init:true,
    ports:[`127.0.0.1:${externalPort}:8787`],
    environment:{API_HOST:'0.0.0.0',API_PORT:'8787',PB_DEMO:'0',PB_PUBLIC_VIEW:'0',PUBLIC_BASE:'',
      SESSION_SECRET:'${SESSION_SECRET}',PB_ADMIN_PASSWORD:'${PB_ADMIN_PASSWORD}',
      PB_OPERATOR_PASSWORD:'${PB_ADMIN_PASSWORD}',PB_VIEWER_PASSWORD:'${PB_ADMIN_PASSWORD}'},
    volumes:['existing-data:/app/robots/server/data'],networks:{default:{aliases:['external-server']}},
    healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(x=>{if(!x.ok||x.demo)process.exit(1)}).catch(()=>process.exit(1))"],interval:'3s',timeout:'3s',retries:40},
  }},volumes:{'existing-data':{}},networks:{default:{external:true,name:`${externalProject}_default`}}},null,2))
  serverFixtureReady=true
  await serverCompose('up','-d','--no-build','--pull','never','--wait','--wait-timeout','150')
  base=`http://127.0.0.1:${externalPort}`; await login(externalPassword)
  assert.deepEqual((await api('/sites')).sites,[])
  assert.equal((await api('/health')).demo,false)
  await api('/sites','POST',{id:'demo-lab',name:'Existing operator site — QA fixture',operator:'Independent owner'})
  await api(S+'/geometry','PUT',{waypoints:[{id:'KEEP-THIS',name:'Existing geometry',kind:'nav',x:2,z:2}],zones:[],cameras:[]})
  const foreignSite=await api(S+'/fleet'), foreignKeys=await api(S+'/api-keys')
  const externalStartEnv={PB_DEMO_PROJECT:externalProject,PB_DEMO_ENV_FILE:'.env.external'}
  await assert.rejects(run('bash',['start.sh','--external'],folder,externalStartEnv),/Refusing to adopt or overwrite existing site demo-lab/)
  assert.deepEqual(await api(S+'/fleet'),foreignSite,'Foreign site metadata and geometry must stay intact')
  assert.deepEqual(await api(S+'/api-keys'),foreignKeys,'Refusal must not create a key on the foreign site')
  assert.equal((await api(S+'/vision')).configs.length,0)
  assert.equal((await externalCompose('ps','--status','running','--quiet')).trim(),'','Refused installation never starts Adapter/Vision')
  checks.push('External startup refuses an unowned demo-lab and preserves its geometry, metadata, keys and empty rule set')
  await api(S,'DELETE') // This foreign-site fixture was created by this test only.
  await run('bash',['start.sh','--external'],folder,externalStartEnv)
  const externalServices=(await run('docker',['ps','--all','--filter',`label=com.docker.compose.project=${externalProject}`,'--format','{{.Label "com.docker.compose.service"}}'])).split('\n').filter(Boolean).sort()
  assert.deepEqual(externalServices,['demo-adapter','vision'],'External mode must not create/start package api, relay or gateway services')
  const externalInstalled=JSON.parse(await externalPrivate('exec','-T','demo-adapter','node','-e',"console.log(require('node:fs').readFileSync('/config/installation.json','utf8'))"))
  secrets.add(externalInstalled.key)
  assert.equal(externalInstalled.serverUrl,'http://external-server:8787')
  const externalFleet=async()=>{
    const response=await fetch(base+'/api/integration/v1/fleet',{headers:{authorization:`Bearer ${externalInstalled.key}`}})
    assert.equal(response.status,200); return response.json()
  }
  await wait(async()=>{
    const current=await externalFleet()
    return ['ext-demo-spot','ext-demo-x30','ext-demo-f2'].every(id=>current.telemetry.some(t=>t.id===id&&t.mode!=='offline'))
  },'external Server receives three genuine native Adapter registrations',45000)
  const externalObservation=await wait(async()=>{
    const state=await api(S+'/vision')
    assert.equal(state.configs.length,3)
    return state.results.find(r=>!r.jobId&&!r.late&&r.config.preset==='ocr'&&[31.1,32.3,32.6,33.1,33.2,34.3].includes(r.value)&&r.status===(r.value>33?'alert':'normal')&&r.evidence)
  },'external Server receives an actual OCR observation from the packaged model',120000)
  const externalEvidence=await fetch(new URL(externalObservation.evidence,base),{headers:{cookie}})
  assert.equal(externalEvidence.status,200)
  const externalJpeg=Buffer.from(await externalEvidence.arrayBuffer())
  assert.ok(externalJpeg.length>1000); assert.equal(externalJpeg.readUInt16BE(0),0xffd8)
  const externalRtsp=JSON.parse(await serverCompose('exec','-T','existing-api','ffprobe','-v','error','-rtsp_transport','tcp','-timeout','5000000','-read_intervals','%+1','-show_entries','stream=codec_name','-of','json','rtsp://demo-adapter:8554/instrument'))
  assert.ok(externalRtsp.streams.some(s=>s.codec_name==='h264'),'Existing Server can decode the configured demo RTSP source')
  await noRandomNativeAlarms(externalCompose)
  checks.push('Shipped --external uses only Adapter/Vision services; isolated existing Server gets all three robots, real OCR/JPEG evidence and reachable H.264 RTSP')
  writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,version:manifest.version,revision:manifest.revision,checks,observed},null,2))
  console.log(JSON.stringify({passed:true,checks},null,2))
} catch(error) {
  await diagnostics()
  writeFileSync(join(out,'result.json'),JSON.stringify({passed:false,error:redact(error),checks,version:manifest?.version,revision:manifest?.revision},null,2))
  console.error(redact(error)); process.exitCode=1
} finally {
  if(serverFixtureReady) await serverCompose('down','-v').catch(()=>{})
  if(externalReady) await externalCompose('--profile','server','down','-v').catch(()=>{})
  if(folder) await compose('--profile','server','down','-v').catch(()=>{})
  rmSync(work,{recursive:true,force:true})
}
