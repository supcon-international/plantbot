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

const engine = process.env.PB_UI_BROWSER ?? 'chromium'
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), 'Use chromium, firefox or webkit')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
const proxy = createServer((req, res) => {
  if (!req.url.startsWith('/robots')) {
    res.writeHead(404)
    res.end()
    return
  }
  const url = req.url.slice(7) || '/'
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
try {
 await wait(async()=>(await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok,'API ready')
 await new Promise(r=>proxy.listen(webPort,'127.0.0.1',r))
 const python=process.env.PB_VISION_PYTHON||join(root,'integrations/vision/.venv/bin/python')
 const movie=join(data,'feed.mp4')
 const generate=spawn(python,['integrations/vision/tests/make_video.py',movie],{cwd:root,stdio:'inherit'})
 assert.equal((await once(generate,'exit'))[0],0)
 const configuration=join(data,'adapter.json')
 writeFileSync(configuration,JSON.stringify({id:'ui-edge',name:'Test edge adapter',serverUrl:`http://127.0.0.1:${apiPort}`,sources:[{id:'camera',label:'Test camera',view:'fixed',channelId:'cam:perimeter-cam',url:movie,loop:true}]}))
 worker=spawn(python,['integrations/vision/worker.py'],{cwd:root,env:{...process.env,PB_ADAPTER_CONFIG:configuration,PB_SITE_KEY:'pbk_dev_plant07',PB_VISION_DATA:join(data,'vision')},stdio:['ignore','pipe','pipe']})
 worker.stdout.on('data',b=>{serverLog+=b});worker.stderr.on('data',b=>{serverLog+=b})
 browser=await ({chromium,firefox,webkit})[engine].launch({...(engine==='chromium'?{channel:'chrome'}:{}),headless:true})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 page=await context.newPage();page.setDefaultTimeout(15000)
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 page.on('response',r=>{if(r.status()>=400&&/\/robots\/(api|assets)\//.test(r.url()))badResponses.push(`${r.status()} ${r.url()}`)})
 await page.goto(`${base}/login`)
 await page.locator('#login-user').fill('admin');await page.locator('#login-pass').fill('plantbot')
 await page.locator('form button[type="submit"]').click();await page.waitForURL(u=>['/robots','/robots/'].includes(u.pathname))
 const api=async(method,path,body)=>{const r=await context.request.fetch(`${base}/api/sites/plant-07${path}`,{method,...(body?{data:body}:{})});assert.ok(r.ok(),await r.text());return r.json()}
 await wait(async()=>(await api('GET','/vision')).adapters.length===1,'real vision adapter online')
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
 await page.screenshot({path:join(out,'01-detector-preview.png'),fullPage:true})
 await dialog.getByRole('switch',{name:'Enable after saving',exact:true}).click()
 await dialog.getByRole('button',{name:'Save rule',exact:true}).click();await dialog.waitFor({state:'hidden'})
 await wait(async()=>(await api('GET','/vision')).results.some(r=>!r.jobId&&r.config.name==='Gate occupancy'&&r.value>=1),'real occupancy archived',60000)
 checks.push('All eleven presets available; real pretrained detection preview, keyboard ROI, enable and persisted result')
 await page.getByRole('button',{name:'New rule',exact:true}).click();dialog=page.getByRole('dialog')
 await dialog.getByLabel('Name',{exact:true}).fill('Temperature display')
 await dialog.getByRole('combobox',{name:'Preset',exact:true}).click();await page.getByRole('option',{name:'Display OCR',exact:true}).click()
 await dialog.getByRole('switch',{name:'Read one numeric value',exact:true}).click()
 await dialog.getByLabel('Unit',{exact:true}).fill('C');await dialog.getByLabel('Max (optional)',{exact:true}).fill('80')
 // Move the left ROI handles to the display half using keyboard-accessible controls.
 for(const n of [1,4]){await dialog.getByRole('slider',{name:`Region point ${n}`,exact:true}).focus();for(let i=0;i<53;i++)await page.keyboard.press('ArrowRight')}
 await dialog.getByRole('button',{name:'Run preview',exact:true}).click()
 await wait(async()=>(await dialog.innerText()).includes('Preview complete'),'real OCR preview',60000)
 assert.ok((await dialog.innerText()).includes('85.2'))
 await dialog.getByRole('switch',{name:'Enable after saving',exact:true}).click();await dialog.getByRole('button',{name:'Save rule',exact:true}).click();await dialog.waitFor({state:'hidden'})
 await wait(async()=>(await api('GET','/vision')).results.some(r=>!r.jobId&&r.config.name==='Temperature display'&&r.status==='alert'&&r.value===85.2),'OCR alert',60000)
 const overview=await api('GET','/vision')
 const baseline=overview.configs.find(c=>c.name==='Gate occupancy')
 const ids=[]
 for(const preset of overview.presets){const c={...baseline,id:undefined,revision:undefined,name:`Simulation ${preset.id}`,preset:preset.id,enabled:true,durationS:0,threshold:preset.rule==='below'?2:0,region:preset.id==='ocr'?[[.53,0],[1,0],[1,1],[.53,1]]:[[0,0],[.5,0],[.5,1],[0,1]],numeric:preset.id==='ocr',unit:preset.id==='ocr'?'C':'',max:preset.id==='ocr'?80:null};ids.push((await api('POST','/vision/configs',c)).id)}
 await wait(async()=>{const d=await api('GET','/vision');return ids.every(id=>d.results.some(r=>r.config.id===id&&!r.jobId&&['normal','alert'].includes(r.status)))},'all eleven presets through real adapter and server',60000)
 const all=(await api('GET','/vision')).results
 for(const preset of ['intrusion','crowding','absence','loitering','post_occupancy','hazard_dwell','ocr'])assert.ok(all.some(r=>r.config.name===`Simulation ${preset}`&&r.status==='alert'),preset)
 checks.push('All eleven presets execute through shared real inference, rules, outbox and Server; expected occupancy/dwell/OCR alarms observed')
 await page.getByRole('row').filter({has:page.getByText('Temperature display',{exact:true})}).getByRole('button',{name:'Details',exact:true}).click()
 await page.getByRole('button',{name:'Review observation',exact:true}).first().click();dialog=page.getByRole('dialog',{name:'Observation details',exact:true})
 await dialog.locator('img').waitFor();assert.ok(await dialog.locator('img').evaluate(i=>i.complete&&i.naturalWidth>0))
 await dialog.getByRole('switch',{name:'Show annotations',exact:true}).click();assert.equal(await dialog.locator('svg[viewBox="0 0 1000 1000"]').count(),0)
 const download=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download original',exact:true}).click();assert.ok((await download).suggestedFilename().endsWith('.jpg'))
 await page.screenshot({path:join(out,'02-ocr-evidence.png'),fullPage:true});await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await page.getByRole('dialog',{name:'Rule details',exact:true}).getByRole('button',{name:'Close',exact:true}).click()
 checks.push('Real PP-OCRv5 preview and numeric threshold alarm, evidence decoding, original/overlay and download')
 const triggerResult=all.find(r=>r.config.name==='Temperature display'&&r.status==='alert'&&r.eventId&&!r.jobId)
 assert.ok(triggerResult,'Formal OCR has a linked event')
 const event=(await api('GET',`/events/${triggerResult.eventId}`)).event
 assert.equal(event.trigger.ruleId,triggerResult.config.id)
 assert.equal(event.trigger.value,85.2)
 assert.equal(event.trigger.channelId,'cam:perimeter-cam')
 await page.goto(`${base}/events?ev=${encodeURIComponent(event.id)}`)
 dialog=page.getByRole('dialog',{name:event.label,exact:true});await dialog.waitFor()
 assert.ok((await dialog.innerText()).includes('85.2'))
 await dialog.getByRole('button',{name:/^View frozen version/}).click()
 const frozen=page.getByRole('dialog',{name:'Trigger rule version',exact:true})
 await frozen.getByText('Temperature display',{exact:true}).waitFor()
 await frozen.getByRole('button',{name:'Close',exact:true}).click()
 await dialog.getByRole('button',{name:'Review observation',exact:true}).click()
 const observed=page.getByRole('dialog',{name:'Observation details',exact:true})
 assert.ok((await observed.innerText()).includes('85.2'))
 await observed.getByRole('button',{name:'Close',exact:true}).click()
 await dialog.getByRole('link',{name:'View video',exact:true}).click()
 await page.waitForURL(u=>u.pathname==='/robots/live')
 assert.equal(await page.getByRole('tab',{name:'Vision inspection',exact:true}).count(),0)
 await page.getByRole('link',{name:'Add rule',exact:true}).click()
 await page.waitForURL(u=>u.pathname==='/robots/events'&&u.searchParams.get('channel')==='cam:perimeter-cam')
 dialog=page.getByRole('dialog',{name:'New rule',exact:true});await dialog.waitFor()
 await dialog.getByRole('combobox',{name:'Video source',exact:true}).waitFor()
 assert.ok((await dialog.innerText()).includes('Test camera'))
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await page.getByRole('button',{name:'Show all rules',exact:true}).click()
 checks.push('Formal OCR event traces frozen rule, exact observation and explicit channel; video opens the shared rule editor and has no separate vision tab')

 await page.getByRole('switch',{name:'Enable Temperature display',exact:true}).click()
 await wait(async()=>!(await api('GET','/vision')).configs.find(c=>c.name==='Temperature display').enabled,'disable monitoring')
 await page.reload();await page.getByRole('tab',{name:'Monitoring rules',exact:true}).click()
 assert.equal(await page.getByRole('switch',{name:'Enable Temperature display',exact:true}).getAttribute('aria-checked'),'false')
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,'03-mobile.png'),fullPage:true})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow on mobile')
 // Persisted language is a user setting, and a reload verifies the actual Chinese UI.
 await page.evaluate(()=>localStorage.setItem('aegis-lang',JSON.stringify({state:{lang:'zh'},version:0})))
 await page.reload();await page.getByRole('tab',{name:'监测规则',exact:true}).click();await page.getByRole('heading',{name:'监测规则',exact:true}).waitFor();await page.screenshot({path:join(out,'04-chinese-mobile.png'),fullPage:true});checks.push('Chinese labels and mobile rendering')
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
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,checks,errors,badResponses},null,2));console.log(JSON.stringify({passed:true,checks},null,2))
} catch(error){
 await page?.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{})
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:false,checks,error:String(error),errors,badResponses,serverLog},null,2));console.error(error);process.exitCode=1
} finally {
 for(const context of browser?.contexts()??[])await context.close()
 await browser?.close()
 if(worker?.exitCode===null){const ended=once(worker,'exit');worker.kill('SIGTERM');await ended}
 for(const socket of sockets)socket.destroy()
 proxy.closeAllConnections();await new Promise(r=>proxy.close(r))
 if(proc.exitCode===null){const closed=once(proc,'close');proc.kill('SIGTERM');await closed}
 rmSync(data,{recursive:true,force:true})
}
