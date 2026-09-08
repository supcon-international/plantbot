#!/usr/bin/env node
// Run after WEB_BASE=/robots/ pnpm build. Uses an isolated database, the actual
// production bundle and a subpath reverse proxy. No production services touched.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'web/dist'),
  out = join(root, 'demos/control-qa')
assert.ok(existsSync(join(dist, 'index.html')), 'Build the production bundle first')
const data = mkdtempSync(join(tmpdir(), 'pb-ui-'))
mkdirSync(out, { recursive: true })
const apiPort = 8993,
  webPort = 5187,
  base = `http://127.0.0.1:${webPort}/robots`
const proc = spawn(join(root, 'server/node_modules/.bin/tsx'), ['server/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    PB_DATA_DIR: data,
    PB_DEMO: '1',
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
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
})
let browser,page
const children=[],checks=[],errors=[],badResponses=[],expectedRaces=[]
const child=(cwd,entry,env)=>{
 const p=spawn(join(cwd,'node_modules/.bin/tsx'),[entry],{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']})
 children.push(p);p.stdout.on('data',b=>{serverLog+=b});p.stderr.on('data',b=>{serverLog+=b});return p
}
try {
 await wait(async()=>(await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok,'API ready')
 await new Promise(r=>proxy.listen(webPort,'127.0.0.1',r))
 browser=await chromium.launch({channel:'chrome',headless:true})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 page=await context.newPage();page.setDefaultTimeout(12000)
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 page.on('response',async r=>{
  if(r.status()<400||!/\/robots\/(api|assets)\//.test(r.url()))return
  const b=await r.json().catch(()=>({}))
  if(r.status()===409&&r.url().endsWith('/input')&&['Stale input sequence','Control session is stopping or closed'].includes(b.message||b.error))expectedRaces.push(r.url())
  else badResponses.push(`${r.status()} ${r.url()}`)
 })
 await page.goto(`${base}/login`)
 await page.locator('#login-user').fill('admin');await page.locator('#login-pass').fill('plantbot')
 await page.locator('form button[type="submit"]').click();await page.waitForURL(u=>['/robots','/robots/'].includes(u.pathname))
 const api=async(method,path,body)=>{
  const r=await context.request.fetch(`${base}/api/sites/plant-07${path}`,{method,...(body?{data:body}:{})});assert.ok(r.ok(),await r.text());return r.json()
 }
 const schedules=await api('GET','/schedules')
 for(const s of schedules.schedules) await api('PATCH',`/schedules/${s.id}`,{enabled:false})
 child(resolve(root,'../plantbotsimulator'),'spot/sim/main.ts',{SPOT_SIM_PORT:'19121',SPOT_SIM_FAULT_S:'0'})
 child(join(root,'integrations'),'spot/adapter/main.ts',{SPOT_PORT:'19121',PLANTBOT_BASE:`http://127.0.0.1:${apiPort}`,PLANTBOT_KEY:'pbk_dev_plant07',STREAM_BASE:'/robots/media'})
 const RID='ext-bd-91250107', cp=`/robots/${RID}/control`
 const state=async()=>{
  const r=await fetch(`http://127.0.0.1:${apiPort}/api/integration/v1/fleet`,{headers:{authorization:'Bearer pbk_dev_plant07'}})
  return (await r.json()).telemetry?.find(t=>t.id===RID)
 }
 await wait(async()=>!!(await state()),'native robot registered')
 await page.goto(`${base}/robots/${RID}`)
 await page.getByRole('tab',{name:'Teleoperation',exact:true}).click()
 const drive=page.getByTestId('manual-drive')
 await drive.getByRole('button',{name:/take control/i}).waitFor()
 await wait(async()=>await drive.locator('video').evaluate(v=>v.readyState>=2&&v.videoWidth>0).catch(()=>false),'decoded driving camera')
 const acquire=async(panel)=>{await panel.getByRole('button',{name:/take control/i}).click();if(await page.getByRole('dialog').count())await page.getByRole('dialog').getByRole('button',{name:'End task and take control',exact:true}).click();await wait(async()=>(await panel.innerText()).includes('Control acquired'),'control ready')}
 await acquire(drive)
 const initial=await state(),forward=drive.getByRole('button',{name:'Forward',exact:true})
 const box=await forward.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await new Promise(r=>setTimeout(r,1100));await page.mouse.up()
 await wait(async()=>(await state()).speed===0,'pointer release stops')
 const moved=await state();assert.ok(Math.hypot(moved.x-initial.x,moved.z-initial.z)>.08)
 const other=await api('GET',cp);assert.equal(other.session.status,'active')
 assert.equal(other.session.token,undefined);assert.equal(other.session.tokenHash,undefined)
 await page.keyboard.down('w');await new Promise(r=>setTimeout(r,700));await page.keyboard.up('w')
 await wait(async()=>(await state()).speed===0,'key release stops')
 await page.screenshot({path:join(out,'01-robot-control-en.png'),fullPage:true})
 checks.push('Native driving with decoded camera, pointer hold/release, keyboard hold/release and measured movement/stop')
 const observer=await context.newPage();await observer.goto(`${base}/robots/${RID}`);await observer.getByRole('tab',{name:'Teleoperation',exact:true}).click()
 const observerPanel=observer.getByTestId('manual-drive')
 // Headless Chromium may transfer focus when a tab opens; acquire again only if the browser released it.
 if(!(await api('GET',cp)).session){await page.bringToFront();await acquire(drive)}
 await wait(async()=>(await observerPanel.innerText()).includes('Operator: admin'),'second tab sees owner')
 assert.equal(await observerPanel.getByRole('button',{name:'Take control',exact:true}).isDisabled(),true)
 await observerPanel.getByRole('button',{name:'Request stop',exact:true}).click()
 await wait(async()=>!(await api('GET',cp)).session,'second operator stop')
 await observer.close();await page.bringToFront()
 await acquire(drive);await page.keyboard.down('w');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.keyboard.up('w')
 await wait(async()=>!(await api('GET',cp)).session,'window blur releases control')
 checks.push('Exclusive ownership across tabs, independent stop request and blur cleanup')
 await page.goto(`${base}/live`);await page.getByRole('tab',{name:'PTZ inspection',exact:true}).click()
 const ptz=page.getByTestId('manual-ptz');await ptz.getByRole('button',{name:/take control/i}).waitFor()
 await acquire(ptz)
 await page.keyboard.down('ArrowRight');await new Promise(r=>setTimeout(r,650));await page.keyboard.up('ArrowRight')
 await page.keyboard.down('=');await new Promise(r=>setTimeout(r,500));await page.keyboard.up('=')
 const pose=await wait(async()=>{
  const camera=(await api('GET',cp)).cameras.find(c=>c.ptz?.manual)
  return camera?.position?.pan>1&&camera.position.zoom>1?camera.position:null
 },'measured PTZ position')
 await ptz.getByRole('button',{name:'Save position as preset',exact:true}).click()
 await page.getByLabel('Preset name').fill('Operator viewpoint')
 assert.ok(Math.abs(Number(await page.getByRole('spinbutton',{name:'Pan',exact:true}).inputValue())-pose.pan)<3)
 await page.getByRole('button',{name:'Save preset',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
 await wait(async()=>!(await api('GET',cp)).session,'save preset releases control')
 await page.screenshot({path:join(out,'02-camera-control-en.png'),fullPage:true})
 checks.push('Native Spot CAM pan/zoom feedback and save current position as a preset')
 await page.setViewportSize({width:390,height:844})
 await page.screenshot({path:join(out,'03-camera-control-mobile.png'),fullPage:true})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'no horizontal overflow on mobile')
 await acquire(ptz);await page.goto(`${base}/robots`)
 await wait(async()=>!(await api('GET',cp)).session,'route change releases control')
 checks.push('Mobile layout and route-change cleanup')
 const viewer=await browser.newContext();const vp=await viewer.newPage();await vp.goto(`${base}/robots/${RID}`);await vp.getByRole('tab',{name:'Teleoperation',exact:true}).click()
 await vp.getByTestId('manual-drive').waitFor()
 assert.equal(await vp.getByTestId('manual-drive').getByRole('button',{name:'Take control',exact:true}).count(),0)
 await viewer.close();checks.push('Viewer has no manual control actions')
 assert.ok(errors.filter(e=>e==='Failed to load resource: the server responded with a status of 409 (Conflict)').length<=expectedRaces.length);assert.deepEqual(errors.filter(e=>e!=='Failed to load resource: the server responded with a status of 409 (Conflict)'),[],'no browser runtime errors');assert.deepEqual(badResponses,[],'no failed API/assets')
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,checks,errors,badResponses},null,2));console.log(JSON.stringify({passed:true,checks},null,2))
} catch(error){
 await page?.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{})
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:false,checks,error:String(error),errors,badResponses,serverLog},null,2));console.error(error);process.exitCode=1
} finally {
 await browser?.close()
 for(const p of children.reverse()){if(p.exitCode===null){const closed=once(p,'close');p.kill('SIGTERM');await closed}}
 proxy.closeAllConnections();await new Promise(r=>proxy.close(r))
 if(proc.exitCode===null){const closed=once(proc,'close');proc.kill('SIGTERM');await closed}
 rmSync(data,{recursive:true,force:true})
}
