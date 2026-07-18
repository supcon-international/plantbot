// Dev orchestrator: run the vendor ADAPTERS as their own processes with
// prefixed logs. Plantbot is a pure integration layer — the robots themselves
// (the SIMULATORS) now live in the sibling `plantbotsimulator` repo, and the
// adapters connect to them exactly as they would to real robots:
//   plant-07  → Spot (bosdyn gRPC)
//   plant-12  → Jueying X30 (robotserver TCP)
//   campus    → GS·F2 ×2 (GoRobot cloud) + Spot + X30  (three vendors, one site)
//
// If plantbotsimulator is checked out as a sibling (or PLANTBOT_SIM_DIR points
// at it), we start its sims too, so `pnpm dev` still spins up the full demo
// stack with real RTSP video. Without it, the adapters run alone and report
// their robots OFFLINE until you point them at real robots — the honest
// production shape. Crashed children respawn after 2 s.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

const SIM_DIR = process.env.PLANTBOT_SIM_DIR || join(ROOT, '..', '..', 'plantbotsimulator')
const SIM_TSX = join(SIM_DIR, 'node_modules', '.bin', 'tsx')
const SIMS_UP = existsSync(SIM_TSX)

const P07 = 'pbk_dev_plant07'
const P12 = 'pbk_dev_plant12'
const CE = 'pbk_dev_campuseast'

// adapters live here; sims live in plantbotsimulator (layer: 'sim' | 'adp')
const ADAPTERS = [
  { name: 'gs·adp', entry: 'gosuncn/adapter/main.ts', color: '95', env: { GOSUNCN_BASE: 'http://127.0.0.1:9101', PLANTBOT_KEY: CE } },
  { name: 'spot07·adp', entry: 'spot/adapter/main.ts', color: '93', env: { SPOT_PORT: '9103', SPOT_PROFILE: 'plant07', PLANTBOT_KEY: P07 } },
  { name: 'x30p12·adp', entry: 'deeprobotics/adapter/main.ts', color: '96', env: { DR_PORT: '30000', DR_PROFILE: 'plant12', PLANTBOT_KEY: P12 } },
  { name: 'spotCE·adp', entry: 'spot/adapter/main.ts', color: '93', env: { SPOT_PORT: '9113', SPOT_PROFILE: 'campus', PLANTBOT_KEY: CE } },
  { name: 'x30CE·adp', entry: 'deeprobotics/adapter/main.ts', color: '96', env: { DR_PORT: '30010', DR_PROFILE: 'campus', PLANTBOT_KEY: CE } },
].map((p) => ({ ...p, layer: 'adp' }))

// sims: identical env/ports the adapters expect — started from plantbotsimulator
const SIMS = [
  { name: 'gs·sim', entry: 'gosuncn/sim/main.ts', color: '35', env: { GOSUNCN_SIM_PORT: '9101' } },
  { name: 'spot07·sim', entry: 'spot/sim/main.ts', color: '33', env: { SPOT_SIM_PORT: '9103', SPOT_SERIAL: 'BD-91250107', SPOT_NICK: 'plant07-spot' } },
  { name: 'x30p12·sim', entry: 'deeprobotics/sim/main.ts', color: '36', env: { DR_SIM_PORT: '30000' } },
  { name: 'spotCE·sim', entry: 'spot/sim/main.ts', color: '33', env: { SPOT_SIM_PORT: '9113', SPOT_SERIAL: 'BD-91250203', SPOT_NICK: 'campus-spot', SPOT_SIM_HOME_X: '2', SPOT_SIM_HOME_Y: '-5', SPOT_SIM_DOCK_X: '-18.4', SPOT_SIM_DOCK_Y: '-0.3' } },
  { name: 'x30CE·sim', entry: 'deeprobotics/sim/main.ts', color: '36', env: { DR_SIM_PORT: '30010', DR_SIM_HOME_X: '0', DR_SIM_HOME_Y: '9' } },
].map((p) => ({ ...p, layer: 'sim' }))

const procs = SIMS_UP ? [...SIMS, ...ADAPTERS] : ADAPTERS

if (SIMS_UP) console.log(`[dev-all] simulators from ${SIM_DIR}`)
else
  console.log(
    '[dev-all] plantbotsimulator not found — running adapters only (robots show OFFLINE).\n' +
      '[dev-all] clone it beside this repo (or set PLANTBOT_SIM_DIR) for the full demo stack with RTSP video.',
  )

let stopping = false
const children = new Set()

function launch(p) {
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m`
  const sim = p.layer === 'sim'
  const child = spawn(sim ? SIM_TSX : TSX, [p.entry], {
    cwd: sim ? SIM_DIR : ROOT,
    env: { ...process.env, ...p.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
