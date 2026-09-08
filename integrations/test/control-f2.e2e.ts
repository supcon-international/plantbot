import {test,before,after,describe} from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {standUpVendor,api,integration,waitFor,type VendorStack,simsAvailable} from './harness.js'
describe('Native manual controls', {skip:!simsAvailable()}, () => {
const SITE='campus-east', RID='ext-gscn-f2-2024-0117', SN='GSCN-F2-2024-0117', KEY='pbk_dev_campuseast'
const path=`/api/sites/${SITE}/robots/${RID}/control`
let vs:VendorStack
before(async()=>{
 vs=await standUpVendor({port:18822,site:SITE,robotId:RID,serial:SN,
 sim:{entry:'gosuncn/sim/main.ts',env:{GOSUNCN_SIM_PORT:'19022'},tag:'f2-control-sim'},
 adapter:{entry:'gosuncn/adapter/main.ts',env:base=>({PLANTBOT_BASE:base,PLANTBOT_KEY:KEY,GOSUNCN_BASE:'http://127.0.0.1:19022'}),tag:'f2-control-adapter'}})
 await new Promise(r=>setTimeout(r,1200))
})
after(()=>vs?.stop())
const telemetry=async()=> (await integration(vs.stack.base,KEY,'GET','/fleet')).body.telemetry.find((t:any)=>t.id===RID)
test('F2 native direction, release and disconnected-adapter lock', {timeout:20000},async()=>{
 const before=await telemetry()
 const r=await api(vs.stack,'POST',path,{target:'drive'})
 assert.equal(r.status,201,JSON.stringify(r.body))
 const {session,token}=r.body
 await waitFor(async()=>(await api(vs.stack,'GET',path)).body.session?.status==='active',5000,'F2 manual readiness',100)
 for(let sequence=1;sequence<=8;sequence++) {
  const response=await fetch(`${vs.stack.base}${path}/${session.id}/input`,{method:'PUT',headers:{cookie:vs.stack.cookie,'x-control-token':token,'content-type':'application/json'},body:JSON.stringify({sequence,axes:{forward:1}})})
  assert.equal(response.status,200)
  await new Promise(r=>setTimeout(r,160))
 }
 const moved=await telemetry()
 assert.ok(Math.hypot(moved.x-before.x,moved.z-before.z)>.1,JSON.stringify({before,moved}))
 await fetch(`${vs.stack.base}${path}/${session.id}`,{method:'DELETE',headers:{cookie:vs.stack.cookie,'x-control-token':token}})
 await waitFor(async()=>!(await api(vs.stack,'GET',path)).body.session,5000,'F2 measured stop',100)
 await waitFor(async()=>(await telemetry()).speed===0,2500,'F2 stationary telemetry',100)
 const next=await api(vs.stack,'POST',path,{target:'drive'})
 assert.equal(next.status,201)
 await waitFor(async()=>(await api(vs.stack,'GET',path)).body.session?.status==='active',5000,'second readiness',100)
 for (const pid of execFileSync('ps',['-Ao','pid,ppid'],{encoding:'utf8'}).trim().split('\n').slice(1).map(line=>line.trim().split(/\s+/).map(Number)).filter(([,parent])=>parent===vs.adp.pid).map(([pid])=>pid)) process.kill(pid,'SIGKILL')
 vs.adp.kill('SIGTERM')
 await waitFor(async()=>(await api(vs.stack,'GET',path)).body.session?.status==='stopping',7000,'unconfirmed expiry remains locked',100)
 assert.equal((await api(vs.stack,'POST',path,{target:'drive'})).status,409,'cannot unlock without physical stop confirmation')
})

})
