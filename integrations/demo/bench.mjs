#!/usr/bin/env node
// Only orchestration here. All simulated motion remains in the pinned external repository.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
const root = '/app/robots/integrations', sim = '/opt/plantbotsimulator'
const config = JSON.parse(readFileSync(process.env.PB_ADAPTER_CONFIG))
const rtsp = config.devices[0].config.streams[0].url.replace(/\/restricted-area$/, '')
let stopping = false
const children = new Set(), timers = new Set()
const processes = [
  { name: 'demo-rtsp', cwd: root, args: ['demo/rtsp.mjs'] },
  { name: 'spot-simulator', cwd: sim, args: ['node_modules/tsx/dist/cli.mjs', 'spot/sim/main.ts'], env: { SPOT_SIM_PORT: '9103', SPOT_SERIAL: 'DEMO-SPOT', SPOT_SIM_DOCK_X: '-11', SPOT_SIM_DOCK_Y: '6', SPOT_SIM_FAULT_S: '0' } },
  { name: 'x30-simulator', cwd: sim, args: ['node_modules/tsx/dist/cli.mjs', 'deeprobotics/sim/main.ts'], env: { DR_SIM_PORT: '30000', DR_SIM_LOCAL_PATROL_MS: '0', DR_SIM_FAULT_S: '0', DR_SIM_FAULTS: '0' } },
  { name: 'f2-simulator', cwd: sim, args: ['node_modules/tsx/dist/cli.mjs', 'gosuncn/sim/main.ts'], env: { GOSUNCN_SIM_PORT: '9101', GOSUNCN_SIM_ALARMS: '0', SIM_RTSP_BASE: rtsp } },
  { name: 'production-adapter-runtime', cwd: root, args: ['node_modules/tsx/dist/cli.mjs', 'runtime.ts'] }
]
function start(spec) {
  if (stopping) return
  const child = spawn(process.execPath, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: 'inherit' })
  children.add(child)
  child.once('exit', code => {
    children.delete(child)
    if (!stopping) {
      console.warn(`[demo] ${spec.name} exited ${code}; restarting in 2 seconds`)
      const timer = setTimeout(() => { timers.delete(timer); start(spec) }, 2000)
      timers.add(timer)
    }
  })
  child.once('error', error => { console.error(`[demo] ${spec.name}: ${error.message}`); stop() })
}
function stop() {
  if (stopping) return
  stopping = true
  for (const timer of timers) clearTimeout(timer)
  for (const child of children) child.kill('SIGTERM')
  const force = setTimeout(() => { for (const child of children) child.kill('SIGKILL') }, 2000)
  force.unref()
}
for (const spec of processes) start(spec)
process.once('SIGTERM', stop); process.once('SIGINT', stop)
