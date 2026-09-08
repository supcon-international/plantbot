#!/usr/bin/env node
// Isolated source fixture: verifies dialog focus without changing web/dist.
import { webkit, chromium } from 'playwright'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireWeb = createRequire(join(root, 'web/package.json'))
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
const out = join(root, 'demos/dialog-focus-qa')
const evidence = { startedAt: new Date().toISOString(), sourceFixture: true, productionBundleTest: false, passed: false, browsers: [] }
const fixture = `
import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Dialog, DialogTrigger, DialogContent, DialogTitle, captureDialogOpener} from '/src/components/ui/dialog.tsx'
import {ConfirmProvider,useConfirm} from '/src/components/ConfirmDialog.tsx'
function Fixture() {
 const [mode,setMode] = useState(null)
 const ask=useConfirm()
 window.openFixture=()=>setMode('plain')
 return <div onClickCapture={captureDialogOpener}>
  <button id="plain" onClick={()=>setMode('plain')}>Plain dialog</button>
  <button id="native" onClick={()=>setMode('native')}>Autofocus dialog</button>
  <button id="callback" onClick={()=>setMode('callback')}>Custom focus dialog</button>
  <button id="prompt" onClick={()=>ask({title:'Prompt', input:true})}>Prompt</button>
  <button id="alternate">Alternate target</button>
  <button id="stale">Click without opening</button>
  <input id="nonbutton" aria-label="Nonbutton opener" onKeyDown={e=>e.key==='Enter' && setMode('plain')}/>
  <Dialog>
   <DialogTrigger asChild><button id="radix">Radix trigger</button></DialogTrigger>
   <DialogContent aria-describedby={undefined}><DialogTitle>Radix fixture</DialogTitle><input aria-label="Radix input"/></DialogContent>
  </Dialog>
  {mode && <Dialog open onOpenChange={open=>!open && setMode(null)}>
   <DialogContent aria-describedby={undefined}
    onOpenAutoFocus={mode==='callback' ? e=>{e.preventDefault();document.querySelector('#inside').focus()} : undefined}
    onCloseAutoFocus={mode==='callback' ? e=>{e.preventDefault();document.querySelector('#alternate').focus()} : undefined}>
    <DialogTitle>Fixture</DialogTitle>
    <input id="inside" aria-label="Inside" autoFocus={mode==='native'}/>
    <button id="nested" onClick={()=>ask({title:'Nested prompt', input:true})}>Nested prompt</button>
    <button onClick={()=>setMode(null)}>Done</button>
   </DialogContent>
  </Dialog>}
 </div>
}
createRoot(document.getElementById('root')).render(<ConfirmProvider><Fixture/></ConfirmProvider>)
`
const server = await createServer({
 configFile:join(root, 'web/vite.config.ts'), root:join(root, 'web'),
 server:{host:'127.0.0.1',port:0,open:false},
 plugins:[{name:'plantbot-focus-fixture',
 resolveId(id){if(id==='/src/__focus_fixture.tsx')return id},
 load(id){if(id==='/src/__focus_fixture.tsx')return fixture},
 configureServer(s){s.middlewares.use('/focus-fixture.html', async(req,res)=>{
  const html=await s.transformIndexHtml('/focus-fixture.html','<html><body><div id="root"></div><script type="module" src="/src/__focus_fixture.tsx"></script></body></html>')
  res.setHeader('content-type','text/html');res.end(html)
 })}
 }]
})
let browser
try {
 await server.listen()
 for (const engine of ['webkit','chromium']) {
  browser=await (engine==='webkit'?webkit.launch({headless:true}):chromium.launch({channel:'chrome',headless:true}))
  const page=await browser.newPage()
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/focus-fixture.html`)
  await page.waitForSelector('#plain')
  const active=async id=>{await page.waitForFunction(id=>document.activeElement?.id===id,id);assert.equal(await page.evaluate(()=>document.activeElement?.id),id)}
  for(const id of ['plain','native']){
   await page.click('#'+id)
   await page.getByRole('dialog',{name:'Fixture',exact:true}).waitFor()
   if(id==='native')await active('inside')
   for(let i=0;i<20;i++)await page.keyboard.press('Tab')
   assert.equal(await page.getByRole('dialog',{name:'Fixture',exact:true}).evaluate(e=>e.contains(document.activeElement)),true)
   await page.keyboard.press('Escape');await active(id)
  }
  await page.click('#callback');await active('inside');await page.keyboard.press('Escape');await active('alternate')
  await page.click('#prompt');await page.getByRole('textbox',{name:'Prompt',exact:true}).waitFor()
  assert.equal(await page.getByRole('textbox',{name:'Prompt',exact:true}).evaluate(e=>e===document.activeElement),true)
  await page.keyboard.press('Escape');await active('prompt')
  await page.locator('#nonbutton').focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Fixture',exact:true}).waitFor()
  await page.keyboard.press('Escape');await active('nonbutton')
  await page.locator('#plain').focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Fixture',exact:true}).waitFor()
  await page.keyboard.press('Escape');await active('plain')
  await page.click('#plain');await page.getByRole('dialog',{name:'Fixture',exact:true}).waitFor();await page.click('#nested')
  await page.getByRole('dialog',{name:'Nested prompt'}).waitFor();await page.getByRole('textbox',{name:'Nested prompt',exact:true}).fill('Test');await page.keyboard.press('Escape');await active('nested')
  await page.keyboard.press('Escape');await active('plain')
  for(const keyboard of [false,true]){
   if(keyboard){await page.locator('#radix').focus();await page.keyboard.press('Enter')}else await page.click('#radix')
   await page.getByRole('dialog',{name:'Radix fixture'}).waitFor();await page.keyboard.press('Escape');await active('radix')
  }
  await page.click('#stale');await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,20)))
  await page.evaluate(()=>{document.querySelector('#alternate').focus();window.openFixture()})
  await page.getByRole('dialog',{name:'Fixture',exact:true}).waitFor();await page.keyboard.press('Escape');await active('alternate')
  assert.deepEqual(errors,[])
  evidence.browsers.push({ engine, version: browser.version(), passed: true, checks: ['Mouse and keyboard opening', '20 Tab focus trap', 'Escape restores actual opener', 'Native input autofocus', 'Caller preventDefault callbacks', 'Persistent confirmation prompt', 'Nested prompt restores each level', 'Radix Trigger mouse and keyboard restoration', 'Expired activation is discarded', 'No browser errors'] })
  await browser.close();browser=null
 }
 evidence.passed = true
 console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
 evidence.error = String(error)
 console.error(error)
 process.exitCode = 1
} finally {
 evidence.completedAt = new Date().toISOString()
 mkdirSync(out, { recursive: true })
 writeFileSync(join(out, 'result.json'), JSON.stringify(evidence, null, 2))
 await browser?.close(); await server.close()
}
