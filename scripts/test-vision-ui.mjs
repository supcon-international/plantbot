#!/usr/bin/env node
// Run after WEB_BASE=/robots/ pnpm build. Uses an isolated database, the actual
// production bundle and a subpath reverse proxy. No production services touched.
import { chromium, firefox, webkit } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const engine = process.env.PB_UI_BROWSER ?? 'chromium'
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), 'Use chromium, firefox or webkit')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const personRegion = [[.38,.43],[.65,.43],[.65,1],[.38,1]]
const instrumentRegion = [[.7,.12],[1,.12],[1,.5],[.7,.5]]
const recordedTemperatures = [31.1,32.3,32.6,33.1,33.2,34.3]
const realTemperature = r => r.config.sourceId === 'instrument' && recordedTemperatures.includes(r.value) &&
  r.text === `${r.value}℃` && r.status === (r.value > 33 ? 'alert' : 'normal')
const personChannel = 'cam:ui-person-camera', instrumentChannel = 'cam:ui-ir-camera'
// Move the real geometry controls with keyboard input, verifying both coordinates.
const setRegion = async (page, dialog, region) => {
  for (const [index, point] of region.entries()) {
    const handle = dialog.getByRole('slider', {name: `Region point ${index + 1}`, exact: true})
    const before = (await handle.getAttribute('aria-valuetext')).match(/[\d.]+/g).map(Number)
    const target = point.map(n => Math.round(n * 100))
    await handle.focus()
    for (const axis of [0,1]) {
      const delta = target[axis] - before[axis]
      const key = axis === 0 ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : (delta > 0 ? 'ArrowDown' : 'ArrowUp')
      for (let step = 0; step < Math.abs(delta); step++) await page.keyboard.press(key)
    }
    assert.equal(await handle.getAttribute('aria-valuetext'), `${target[0]}%, ${target[1]}%`)
  }
}
const dist = join(root, 'web/dist'),
  out = join(root, 'demos/vision-qa', engine)
assert.ok(existsSync(join(dist, 'index.html')), 'Build the production bundle first')
const data = mkdtempSync(join(tmpdir(), 'pb-ui-'))
mkdirSync(out, { recursive: true })
const freePort = async () => {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return port
}
const apiPort = await freePort(),
  webPort = await freePort(),
  base = `http://127.0.0.1:${webPort}/robots`
const proc = spawn(join(root, 'server/node_modules/.bin/tsx'), ['server/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    PB_DATA_DIR: data,
    PB_DEMO: '1',
    PB_PUBLIC_VIEW: process.env.PB_UI_PUBLIC_VIEW ?? '1',
    PB_DEV_KEYS: '1',
    PUBLIC_BASE: '/robots',
    SESSION_SECRET: 'isolated-ui-test',
    PB_RECORDING_SEGMENT_SEC: '2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
proc.stdout.on('data', (b) => {
  serverLog += b
})
proc.stderr.on('data', (b) => {
  serverLog += b
})
const wait = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const result = await fn().catch(() => false)
    if (result) return result
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out: ${label}`)
}
const sockets = new Set()
const recordingPaths = new Map([
  ['/test-media/people.mp4', join(data, 'people.mp4')],
  ['/test-media/instrument.mp4', join(data, 'instrument.mp4')],
])
const proxy = createServer((req, res) => {
  if (!req.url.startsWith('/robots')) {
    res.writeHead(404)
    res.end()
    return
  }
  const url = req.url.slice(7) || '/'
  // Serve the exact isolated input files as browser-playable channels. Native
  // video uses byte ranges (including Safari's initial bytes=0-1 probe).
  const recording = recordingPaths.get(url.split('?')[0])
  if (recording) {
    const bytes = readFileSync(recording)
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
    let start = 0, end = bytes.length - 1
    if (req.headers.range) {
      if (!range || (!range[1] && !range[2])) { res.writeHead(416, {'content-range': `bytes */${bytes.length}`}); res.end(); return }
      start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]))
      end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
      if (start > end || start >= bytes.length) { res.writeHead(416, {'content-range': `bytes */${bytes.length}`}); res.end(); return }
    }
    res.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      ...(range ? {'content-range': `bytes ${start}-${end}/${bytes.length}`} : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
    return
  }
  if (/^\/(api|media)\//.test(url)) {
    const upstream = request(
      { hostname: '127.0.0.1', port: apiPort, path: url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      },
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
    return
  }
  const file = resolve(dist, `.${decodeURIComponent(url.split('?')[0])}`)
  const target =
    file.startsWith(`${dist}/`) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  }
  res.setHeader('content-type', mime[extname(target)] ?? 'application/octet-stream')
  res.end(readFileSync(target))
})
proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
proxy.on('upgrade', (req, socket, head) => {
  const upstream = connect(apiPort, '127.0.0.1', () => {
    upstream.write(
      `${req.method} ${req.url.slice(7)} HTTP/1.1\r\n${Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')}\r\n\r\n`,
    )
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream))
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
})
let browser,page,worker
const checks=[],errors=[],badResponses=[]
const mediaInputs=[],playbackFrames=[]
try {
 await wait(async()=>(await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok,'API ready')
 await new Promise(r=>proxy.listen(webPort,'127.0.0.1',r))
 const python=process.env.PB_VISION_PYTHON||join(root,'integrations/vision/.venv/bin/python')
 const movie=join(data,'people.mp4'), instrumentMovie=join(data,'instrument.mp4')
 for (const [source, output] of [['person', movie], ['instrument', instrumentMovie]]) {
  const copy=spawn(python,['integrations/vision/tests/make_video.py',output,'--source',source],{cwd:root,stdio:'inherit'})
  assert.equal((await once(copy,'exit'))[0],0)
  mediaInputs.push({source,sha256:createHash('sha256').update(readFileSync(output)).digest('hex')})
 }
 assert.notDeepEqual(readFileSync(movie),readFileSync(instrumentMovie),'Two independent real recordings')
 const configuration=join(data,'adapter.json')
 writeFileSync(configuration,JSON.stringify({id:'ui-edge',name:'Test edge adapter',serverUrl:`http://127.0.0.1:${apiPort}`,sources:[
  {id:'people',label:'Recorded facility stairs',view:'fixed',channelId:personChannel,url:movie,loop:true},
  {id:'instrument',label:'Recorded IR instrument',view:'fixed',channelId:instrumentChannel,url:instrumentMovie,loop:true},
 ]}))
 worker=spawn(python,['integrations/vision/worker.py'],{cwd:root,env:{...process.env,PB_ADAPTER_CONFIG:configuration,PB_SITE_KEY:'pbk_dev_plant07',PB_VISION_DATA:join(data,'vision')},stdio:['ignore','pipe','pipe']})
 worker.stdout.on('data',b=>{serverLog+=b});worker.stderr.on('data',b=>{serverLog+=b})
 browser=await ({chromium,firefox,webkit})[engine].launch({...(engine==='chromium'?{channel:'chrome'}:{}),headless:true})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 page=await context.newPage();page.setDefaultTimeout(15000)
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 page.on('response',r=>{if(r.status()>=400)badResponses.push(`${r.status()} ${r.url()}`)})
 await page.goto(`${base}/login`)
 await page.locator('#login-user').fill('admin');await page.locator('#login-pass').fill('plantbot')
 await page.locator('form button[type="submit"]').click();await page.waitForURL(u=>['/robots','/robots/'].includes(u.pathname))
 const api=async(method,path,body)=>{const r=await context.request.fetch(`${base}/api/sites/plant-07${path}`,{method,...(body?{data:body}:{})});assert.ok(r.ok(),await r.text());return r.json()}
 // Session API registers the same files as available video channels; the two
 // adapter sources never claim an unrelated seeded camera's identity.
 await api('PUT','/geometry',{cameras:[
  {id:'ui-person-camera',name:'Recorded facility stairs',stream:'ui-person-camera',file:'/robots/test-media/people.mp4'},
  {id:'ui-ir-camera',name:'Recorded IR instrument',stream:'ui-ir-camera',file:'/robots/test-media/instrument.mp4'},
 ]})
 await wait(async()=>(await api('GET','/vision')).adapters.some(a=>a.id==='ui-edge'&&a.sources.length===2),'two real vision sources online')
 await page.getByRole('link',{name:'Events',exact:true}).click();await page.getByRole('tab',{name:'Monitoring rules',exact:true}).click()
 await page.getByRole('button',{name:'New rule',exact:true}).click()
 let dialog=page.getByRole('dialog')
 await dialog.getByLabel('Name',{exact:true}).fill('Gate occupancy')
 await dialog.getByRole('combobox',{name:'Preset',exact:true}).click()
 assert.equal(await page.getByRole('option').count(),11)
 await page.getByRole('option',{name:'People counting',exact:true}).click()
 await dialog.getByRole('button',{name:'Run preview',exact:true}).click()
 await wait(async()=>(await dialog.innerText()).includes('Preview complete'),'real detector preview',60000)
 const img=dialog.locator('img');assert.ok(await img.evaluate(i=>i.complete&&i.naturalWidth>0))
 const point=dialog.getByRole('slider',{name:'Region point 1',exact:true});await point.focus();await page.keyboard.press('ArrowRight');assert.equal(await point.getAttribute('aria-valuenow'),'1')
 await setRegion(page,dialog,personRegion)
 await dialog.getByLabel('Archive interval (seconds)',{exact:true}).fill('3')
 await page.screenshot({path:join(out,'01-detector-preview.png'),fullPage:true,animations:'disabled'})
 await dialog.getByRole('switch',{name:'Enable after saving',exact:true}).click()
 await dialog.getByRole('button',{name:'Save rule',exact:true}).click();await dialog.waitFor({state:'hidden'})
 await wait(async()=>(await api('GET','/vision')).results.some(r=>!r.jobId&&r.config.name==='Gate occupancy'&&r.value>=1),'real person passage archived',90000)
 checks.push('All eleven presets available; real pretrained detection preview, keyboard ROI, enable and persisted result')
 await page.getByRole('button',{name:'New rule',exact:true}).click();dialog=page.getByRole('dialog')
 await dialog.getByLabel('Name',{exact:true}).fill('Temperature display')
 await dialog.getByRole('combobox',{name:'Preset',exact:true}).click();await page.getByRole('option',{name:'Display OCR',exact:true}).click()
 await dialog.getByRole('combobox',{name:'Video source',exact:true}).click();await page.getByRole('option',{name:'Recorded IR instrument',exact:true}).click()
 await dialog.getByRole('switch',{name:'Read one numeric value',exact:true}).click()
 await dialog.getByLabel('Unit',{exact:true}).fill('℃');await dialog.getByLabel('Max (optional)',{exact:true}).fill('33')
 await dialog.getByLabel('Archive interval (seconds)',{exact:true}).fill('3')
 await setRegion(page,dialog,instrumentRegion)
 await dialog.getByRole('button',{name:'Run preview',exact:true}).click()
 await wait(async()=>(await dialog.innerText()).includes('Preview complete'),'real IR overlay OCR preview',60000)
 const preview=(await api('GET','/vision')).results.find(r=>r.jobId&&r.config.name==='Temperature display')
 assert.ok(preview&&realTemperature(preview),'Preview reads the native IR temperature overlay')
 assert.ok((await dialog.innerText()).includes(String(preview.value)))
 assert.equal(preview.eventId,'','Preview cannot create an event')
 await dialog.getByRole('switch',{name:'Enable after saving',exact:true}).click();await dialog.getByRole('button',{name:'Save rule',exact:true}).click();await dialog.waitFor({state:'hidden'})
 const triggerResult=await wait(async()=>(await api('GET','/vision')).results.find(r=>!r.jobId&&r.config.name==='Temperature display'&&r.status==='alert'&&r.eventId&&realTemperature(r)),'real IR OCR alert',90000)
 const overview=await api('GET','/vision')
 const baseline=overview.configs.find(c=>c.name==='Gate occupancy')
 const ids=[]
 for(const preset of overview.presets){
  const ocr=preset.id==='ocr'
  const c={...baseline,id:undefined,revision:undefined,name:`Recorded test ${preset.id}`,preset:preset.id,sourceId:ocr?'instrument':'people',enabled:true,durationS:2,intervalS:15,threshold:preset.rule==='below'?1:0,region:ocr?instrumentRegion:personRegion,line:[[.38,.7],[.65,.7]],numeric:ocr,unit:ocr?'℃':'',max:ocr?33:null}
  ids.push((await api('POST','/vision/configs',c)).id)
 }
 const observedResults=new Map(overview.results.map(r=>[r.id,r]))
 const alarmPresets=['intrusion','crowding','absence','loitering','post_occupancy','hazard_dwell','ocr']
 await wait(async()=>{
  for(const r of (await api('GET','/vision')).results)observedResults.set(r.id,r)
  const all=[...observedResults.values()]
  return ids.every(id=>all.some(r=>r.config.id===id&&!r.jobId&&['normal','alert'].includes(r.status))) &&
   alarmPresets.every(p=>all.some(r=>r.config.name===`Recorded test ${p}`&&r.status==='alert')) &&
   all.some(r=>r.config.name==='Temperature display'&&!r.jobId&&r.capturedAt>triggerResult.capturedAt&&r.status==='normal'&&realTemperature(r))
 },'all eleven presets and natural person/IR alarm windows through the real adapter and server',120000)
 const all=[...observedResults.values()]
 for(const preset of alarmPresets)assert.ok(all.some(r=>r.config.name===`Recorded test ${preset}`&&r.status==='alert'),preset)
 checks.push('All eleven presets execute through real recordings, unchanged inference/guard, rules and outbox; configured person alarms and native IR threshold alert/recovery observed')
 await page.getByRole('row').filter({has:page.getByText('Temperature display',{exact:true})}).getByRole('button',{name:'Details',exact:true}).click()
 // A looping input truthfully archives a frame-less failed observation at
 // EOF. Choose a real numeric observation, keeping those failed rows visible.
 await page.getByRole('dialog',{name:'Rule details',exact:true}).getByRole('row').filter({has:page.getByRole('cell',{name:/^3[1-4]\.[1236] ℃$/})}).first().getByRole('button',{name:'Review observation',exact:true}).click();dialog=page.getByRole('dialog',{name:'Observation details',exact:true})
 await dialog.locator('img').waitFor();assert.ok(await dialog.locator('img').evaluate(i=>i.complete&&i.naturalWidth>0))
 await dialog.getByRole('switch',{name:'Show annotations',exact:true}).click();assert.equal(await dialog.locator('svg[viewBox="0 0 1000 1000"]').count(),0)
 const download=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download original',exact:true}).click();assert.ok((await download).suggestedFilename().endsWith('.jpg'))
 await wait(async()=>dialog.evaluate(el=>getComputedStyle(el).opacity==='1'),'opaque evidence dialog after entry transition')
 for(const width of [375,768,1440]){
  await page.setViewportSize({width,height:1000})
  const geometry=await dialog.locator('img').evaluate(img=>{const box=img.getBoundingClientRect();return {width:img.naturalWidth,height:img.naturalHeight,ratio:box.width/box.height}})
  assert.equal(geometry.width,1280);assert.equal(geometry.height,1024)
  assert.ok(Math.abs(geometry.ratio-1.25)<.01,`IR evidence preserves the full source aspect at ${width}px`)
  await page.screenshot({path:join(out,`02-ocr-evidence-${width}.png`),fullPage:true,animations:'disabled'})
 }
 await page.screenshot({path:join(out,'02-ocr-evidence.png'),fullPage:true,animations:'disabled'});await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await page.getByRole('dialog',{name:'Rule details',exact:true}).getByRole('button',{name:'Close',exact:true}).click()
 checks.push('Real PP-OCRv5 reads the native IR overlay on its independent source; evidence decoding, original/overlay and download')
 assert.ok(triggerResult,'Formal OCR has a linked event')
 const event=(await api('GET',`/events/${triggerResult.eventId}`)).event
 assert.equal(event.trigger.ruleId,triggerResult.config.id)
 assert.equal(event.trigger.value,triggerResult.value)
 assert.equal(event.trigger.configSnapshot.unit,'℃')
 assert.equal(event.trigger.configSnapshot.max,33)
 assert.equal(event.trigger.channelId,instrumentChannel)
 await page.goto(`${base}/events?ev=${encodeURIComponent(event.id)}`)
 dialog=page.getByRole('dialog',{name:event.label,exact:true});await dialog.waitFor()
 assert.ok((await dialog.innerText()).includes(String(triggerResult.value)))
 await dialog.getByRole('button',{name:/^View frozen version/}).click()
 const frozen=page.getByRole('dialog',{name:'Trigger rule version',exact:true})
 await frozen.getByText('Temperature display',{exact:true}).waitFor()
 await frozen.getByRole('button',{name:'Close',exact:true}).click()
 await dialog.getByRole('button',{name:'Review observation',exact:true}).click()
 const observed=page.getByRole('dialog',{name:'Observation details',exact:true})
 assert.ok((await observed.innerText()).includes(String(triggerResult.value)))
 await observed.getByRole('button',{name:'Close',exact:true}).click()
 await dialog.getByRole('link',{name:'View video',exact:true}).click()
 await page.waitForURL(u=>u.pathname==='/robots/live')
 const video=page.locator('video[autoplay][src*="test-media/instrument.mp4"]').first()
 await wait(async()=>video.evaluate(v=>v.readyState>=2&&v.videoWidth===1280&&v.videoHeight===1024),'native IR channel decodes the corresponding recording')
 const played=await video.evaluate(v=>v.currentTime)
 await wait(async()=>video.evaluate((v,previous)=>v.currentTime>previous+.2||v.currentTime<previous,played),'native IR playback advances')
 for(const width of [375,768,1440]){
  await page.setViewportSize({width,height:1000})
  // Responsive layout can remount the player. Wait for this viewport's actual
  // decoded frame, not the pre-resize video's metadata or playback clock.
  await wait(async()=>video.evaluate(v=>v.readyState>=2&&v.videoWidth===1280&&v.videoHeight===1024),'IR decode after viewport change')
  const position=await video.evaluate(v=>v.currentTime)
  await wait(async()=>video.evaluate((v,t)=>v.currentTime>t+.2||v.currentTime<t,position),'IR advances after viewport change')
  await video.evaluate(v=>new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('No composited video frame after resize')),8000)
   const done=()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve()})
   if(v.requestVideoFrameCallback)v.requestVideoFrameCallback(done);else requestAnimationFrame(done)
  }))
  const frame=await video.evaluate(v=>{
   const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32
   const ctx=canvas.getContext('2d');ctx.drawImage(v,0,0,32,32)
   const pixels=ctx.getImageData(0,0,32,32).data
   const rgb=[...pixels].filter((_,i)=>i%4!==3)
   return {time:v.currentTime,width:v.videoWidth,height:v.videoHeight,min:Math.min(...rgb),max:Math.max(...rgb),mean:rgb.reduce((a,b)=>a+b,0)/rgb.length}
  })
  assert.ok(frame.mean>10&&frame.max-frame.min>30,`IR frame is not blank at ${width}px`)
  playbackFrames.push({viewportWidth:width,...frame})
  assert.equal(await video.evaluate(v=>getComputedStyle(v).objectFit),'contain',`IR main playback preserves all temperature text at ${width}px`)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`IR playback overflow at ${width}px`)
  await page.screenshot({path:join(out,`05-ir-playback-${width}.png`),fullPage:true,animations:'disabled'})
 }
 assert.equal(await page.getByRole('tab',{name:'Vision inspection',exact:true}).count(),0)
 await page.getByRole('link',{name:'Add rule',exact:true}).click()
 await page.waitForURL(u=>u.pathname==='/robots/events'&&u.searchParams.get('channel')===instrumentChannel)
 dialog=page.getByRole('dialog',{name:'New rule',exact:true});await dialog.waitFor()
 await dialog.getByRole('combobox',{name:'Video source',exact:true}).waitFor()
 assert.ok((await dialog.innerText()).includes('Recorded IR instrument'))
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await page.getByRole('button',{name:'Show all rules',exact:true}).click()
 checks.push('Formal OCR event traces frozen rule and observation to its independently decoded IR video; 375/768/1440px evidence and contain playback preserve the full frame, then open the shared rule editor')

 await page.getByRole('switch',{name:'Enable Temperature display',exact:true}).click()
 await wait(async()=>!(await api('GET','/vision')).configs.find(c=>c.name==='Temperature display').enabled,'disable monitoring')
 await page.reload();await page.getByRole('tab',{name:'Monitoring rules',exact:true}).click()
 assert.equal(await page.getByRole('switch',{name:'Enable Temperature display',exact:true}).getAttribute('aria-checked'),'false')
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,'03-mobile.png'),fullPage:true,animations:'disabled'})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow on mobile')
 // Reproduce an older persisted vision event whose former default confidence
 // was 1 and whose original observation is no longer available.
 const legacyReply=await context.request.post(`${base}/api/integration/v1/events`,{headers:{authorization:'Bearer pbk_dev_plant07'},data:{type:'vision-ocr',label:'Legacy confidence fixture',confidence:1}})
 assert.ok(legacyReply.ok());const legacy=(await legacyReply.json()).event
 assert.equal(legacy.confidence,1);assert.equal(legacy.trigger,undefined)
 await page.goto(`${base}/events`)
 const legacyCard=page.getByRole('button',{name:/^Legacy confidence fixture/})
 await legacyCard.waitFor();assert.ok((await legacyCard.innerText()).includes('Unknown'))
 await page.getByRole('radio',{name:'Table',exact:true}).click()
 const legacyRow=page.getByRole('row').filter({has:page.getByText('Legacy confidence fixture',{exact:true})})
 assert.ok((await legacyRow.innerText()).includes('Unknown'))
 assert.ok(!(await legacyRow.innerText()).includes('100%'))
 await legacyRow.getByRole('button',{name:'Legacy confidence fixture',exact:true}).click()
 dialog=page.getByRole('dialog',{name:'Legacy confidence fixture',exact:true})
 assert.ok((await dialog.innerText()).includes('Unknown'))
 assert.ok(!(await dialog.innerText()).includes('100%'))
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await page.getByRole('tab',{name:'Monitoring rules',exact:true}).click()
 checks.push('Older vision events without trigger metadata show Unknown in board, table and details instead of the former synthetic 100%')
 // Persisted language is a user setting, and a reload verifies the actual Chinese UI.
 await page.evaluate(()=>localStorage.setItem('aegis-lang',JSON.stringify({state:{lang:'zh'},version:0})))
 await page.reload();await page.getByRole('tab',{name:'监测规则',exact:true}).click();await page.getByRole('heading',{name:'监测规则',exact:true}).waitFor();await page.screenshot({path:join(out,'04-chinese-mobile.png'),fullPage:true,animations:'disabled'});checks.push('Chinese labels and mobile rendering')
 const viewer=await browser.newContext();const vp=await viewer.newPage();vp.on('pageerror',e=>errors.push(e.message));await vp.goto(`${base}/login`)
 await vp.locator('#login-user').fill('viewer');await vp.locator('#login-pass').fill('plantbot');await vp.locator('form button[type="submit"]').click()
 await vp.waitForURL(u=>['/robots','/robots/'].includes(u.pathname));await vp.getByRole('link',{name:'Events',exact:true}).click();await vp.getByRole('tab',{name:'Monitoring rules',exact:true}).click()
 await vp.getByTestId('monitoring-rules').waitFor();assert.equal(await vp.getByRole('button',{name:'New rule',exact:true}).count(),0)
 assert.equal(await vp.getByRole('switch',{name:'Enable Gate occupancy',exact:true}).isDisabled(),true)
 await viewer.close();checks.push('Disable persists across reload, mobile layout and viewer permissions')
 for(const lang of ['en','zh'])for(const theme of ['light','dark'])for(const width of [375,768,1440]){
  await page.setViewportSize({width,height:1000})
  await page.evaluate(({lang,theme})=>{localStorage.setItem('aegis-lang',JSON.stringify({state:{lang},version:0}));localStorage.setItem('aegis-theme',JSON.stringify({state:{theme},version:0}))},{lang,theme})
  await page.reload();await page.getByRole('tab',{name:lang==='zh'?'监测规则':'Monitoring rules',exact:true}).click();await page.getByTestId('monitoring-rules').waitFor()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${lang}/${theme}/${width} overflow`)
  const a11y=await new AxeBuilder({page}).include('[data-testid="monitoring-rules"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()
  assert.deepEqual(a11y.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.html)})),[],`${lang}/${theme}/${width} accessibility`)
 }
 checks.push('Unified monitoring: English/Chinese, light/dark, 375/768/1440px; zero WCAG A/AA violations')

 assert.deepEqual(errors,[]);assert.deepEqual(badResponses,[])
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,mediaInputs,playbackFrames,checks,errors,badResponses},null,2));console.log(JSON.stringify({passed:true,mediaInputs,checks},null,2))
} catch(error){
 await page?.screenshot({path:join(out,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:false,mediaInputs,playbackFrames,checks,error:String(error),errors,badResponses,serverLog},null,2));console.error(error);process.exitCode=1
} finally {
 for(const context of browser?.contexts()??[])await context.close()
 await browser?.close()
 if(worker?.exitCode===null){const ended=once(worker,'exit');worker.kill('SIGTERM');await ended}
 for(const socket of sockets)socket.destroy()
 proxy.closeAllConnections();await new Promise(r=>proxy.close(r))
 if(proc.exitCode===null){const closed=once(proc,'close');proc.kill('SIGTERM');await closed}
 rmSync(data,{recursive:true,force:true})
}
