// Dev orchestrator: run all three simulator+adapter pairs as separate
// processes with prefixed logs. Each one is independently startable
// (`pnpm --filter integrations sim:spot` etc.) — this script only saves six
// terminal tabs. Crashed children respawn after 2 s.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

const procs = [
  ['sim:gosuncn', 'gosuncn/sim/main.ts', '35'],
  ['sim:deepro', 'deeprobotics/sim/main.ts', '36'],
  ['sim:spot', 'spot/sim/main.ts', '33'],
  ['adp:gosuncn', 'gosuncn/adapter/main.ts', '95'],
  ['adp:deepro', 'deeprobotics/adapter/main.ts', '96'],
  ['adp:spot', 'spot/adapter/main.ts', '93'],
]

let stopping = false
const children = new Set()

function launch([name, entry, color]) {
  const tag = `\x1b[${color}m[${name}]\x1b[0m`
  const child = spawn(TSX, [entry], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    setTimeout(() => launch([name, entry, color]), 2000)
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
