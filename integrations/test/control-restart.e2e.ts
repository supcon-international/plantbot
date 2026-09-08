import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {spawnProc,waitFor,api,integration} from './harness.js'
test('manual control restart restores stop lock, invalidates token and never replays axes',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pb-control-restart-')),base='http://127.0.0.1:18823',key='pbk_dev_plant07'
 const env={API_PORT:'18823',PB_DATA_DIR:dir,PB_DEV_KEYS:'1',PB_DEMO:'1',SESSION_SECRET:'manual-control-restart-test'}
 let proc=spawnProc('server/src/index.ts',env,'control-restart')
 const stop=async()=>{if(proc.exitCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done}}
 const north=(method:string,path:string,body?:unknown)=>integration(base,key,method,path,body)
 try {
  await waitFor(async()=>(await fetch(`${base}/api/health`)).ok,8000,'platform ready',100)
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'plantbot'})})
  const stack={base,cookie:login.headers.get('set-cookie')!.split(';')[0]}
  await north('POST','/robots',{serial:'RESTART-CONTROL',model:'Test',level:'dispatchable',teleop:{forward:.5,lateral:0,turn:0,watchdog:'native'}})
  await north('POST','/robots/RESTART-CONTROL/state',{x:0,z:0,battery:90,mode:'idle'})
  const path='/api/sites/plant-07/robots/ext-restart-control/control'
  const r=await api(stack,'POST',path,{target:'drive'});assert.equal(r.status,201)
  const {session,token}=r.body
  await north('POST','/robots/RESTART-CONTROL/control',{id:session.id,sequence:0,status:'ready'})
  const input=()=>fetch(`${base}${path}/${session.id}/input`,{method:'PUT',headers:{cookie:stack.cookie,'x-control-token':token,'content-type':'application/json'},body:JSON.stringify({sequence:1,axes:{forward:.3}})})
  assert.equal((await input()).status,200)
  assert.equal((await north('GET','/robots/RESTART-CONTROL/control')).body.frame.axes.forward,.3)
  await stop();proc=spawnProc('server/src/index.ts',env,'control-restarted')
  await waitFor(async()=>(await fetch(`${base}/api/health`)).ok,8000,'platform restarted',100)
  const frame=(await north('GET','/robots/RESTART-CONTROL/control')).body.frame
  assert.equal(frame.status,'stopping');assert.deepEqual(frame.axes,{});assert.equal(frame.remainingMs,0)
  assert.equal((await input()).status,403,'restart invalidates token')
  assert.equal((await api(stack,'POST',path,{target:'drive'})).status,409,'stop lock restored')
  await north('POST','/robots/RESTART-CONTROL/control',{id:session.id,sequence:frame.sequence-1,status:'stopped'})
  assert.ok((await api(stack,'GET',path)).body.session,'old stop receipt cannot unlock')
  await north('POST','/robots/RESTART-CONTROL/control',{id:session.id,sequence:frame.sequence,status:'stopped'})
  assert.equal((await api(stack,'GET',path)).body.session,null)
 }finally{await stop();rmSync(dir,{recursive:true,force:true})}
})
