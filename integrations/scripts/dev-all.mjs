// Dev orchestrator: run every simulator+adapter pair as its own process with
// prefixed logs. Plantbot is a pure integration layer now — all robots arrive
// through these pairs:
//   plant-07  → Spot (bosdyn gRPC)
//   plant-12  → Jueying X30 (robotserver TCP)
//   campus    → GS·F2 ×2 (GoRobot cloud) + Spot + X30  (three vendors, one site)
// Each pair is independently startable via its own env; this script just saves
// ten terminal tabs. Crashed children respawn after 2 s.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

const P07 = 'pbk_dev_plant07'
const P12 = 'pbk_dev_plant12'
const CE = 'pbk_dev_campuseast'

/** {name, entry, color, env} — color is an ANSI SGR code for the log prefix */
const procs = [
  // campus GS·F2 ×2 (GoRobot cloud)
  { name: 'gs·sim', entry: 'gosuncn/sim/main.ts', color: '35', env: { GOSUNCN_SIM_PORT: '9101' } },
  { name: 'gs·adp', entry: 'gosuncn/adapter/main.ts', color: '95', env: { GOSUNCN_BASE: 'http://127.0.0.1:9101', PLANTBOT_KEY: CE } },
  // plant-07 Spot
  { name: 'spot07·sim', entry: 'spot/sim/main.ts', color: '33', env: { SPOT_SIM_PORT: '9103', SPOT_SERIAL: 'BD-91250107', SPOT_NICK: 'plant07-spot' } },
  { name: 'spot07·adp', entry: 'spot/adapter/main.ts', color: '93', env: { SPOT_PORT: '9103', SPOT_PROFILE: 'plant07', PLANTBOT_KEY: P07 } },
  // plant-12 X30（dock 桩位在 adapter 的 DR_PROFILE 里，sim 默认即 plant-12 泊位）
  { name: 'x30p12·sim', entry: 'deeprobotics/sim/main.ts', color: '36', env: { DR_SIM_PORT: '30000' } },
  { name: 'x30p12·adp', entry: 'deeprobotics/adapter/main.ts', color: '96', env: { DR_PORT: '30000', DR_PROFILE: 'plant12', PLANTBOT_KEY: P12 } },
  // campus Spot — sim 充电桩重定到 DOCK-C（世界 (-18.4,0.3) → seed y=-z），初始位姿在主步道
  { name: 'spotCE·sim', entry: 'spot/sim/main.ts', color: '33', env: { SPOT_SIM_PORT: '9113', SPOT_SERIAL: 'BD-91250203', SPOT_NICK: 'campus-spot', SPOT_SIM_HOME_X: '2', SPOT_SIM_HOME_Y: '-5', SPOT_SIM_DOCK_X: '-18.4', SPOT_SIM_DOCK_Y: '-0.3' } },
  { name: 'spotCE·adp', entry: 'spot/adapter/main.ts', color: '93', env: { SPOT_PORT: '9113', SPOT_PROFILE: 'campus', PLANTBOT_KEY: CE } },
  // campus X30 — sim 充电桩 = adapter campus profile 的 dock（世界 (0,-9) → 地图 y=-z）
  { name: 'x30CE·sim', entry: 'deeprobotics/sim/main.ts', color: '36', env: { DR_SIM_PORT: '30010', DR_SIM_HOME_X: '0', DR_SIM_HOME_Y: '9' } },
  { name: 'x30CE·adp', entry: 'deeprobotics/adapter/main.ts', color: '96', env: { DR_PORT: '30010', DR_PROFILE: 'campus', PLANTBOT_KEY: CE } },
]

let stopping = false
const children = new Set()

function launch(p) {
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m`
  const child = spawn(TSX, [p.entry], { cwd: ROOT, env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  const pipe = (stream, out) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        out.write(`${tag} ${buf.slice(0, i)}\n`)
        buf = buf.slice(i + 1)
      }
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    children.delete(child)
    if (stopping) return
    process.stdout.write(`${tag} exited (${code}) — respawning in 2s\n`)
    setTimeout(() => launch(p), 2000)
  })
}

for (const p of procs) launch(p)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true
    for (const c of children) c.kill('SIGTERM')
    setTimeout(() => process.exit(0), 300)
  })
}
