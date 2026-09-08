// Standalone Adapter service. Each vendor stays in its own supervised process;
// vision is a separate resource-limited service in the same deployment package.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDORS, validateConnectorConfig, type ConnectorVendor } from './shared/connector-catalog.js'

const root = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(process.env.PB_ADAPTER_CONFIG ?? 'adapter.json', 'utf8'))
const devices = config.devices ?? []
const key = process.env.PB_SITE_KEY ?? config.siteKey
if (!/^https?:\/\//.test(config.serverUrl ?? '') || !key)
  throw new Error('Adapter requires serverUrl and PB_SITE_KEY')
if (!Array.isArray(devices) || devices.length > 32) throw new Error('At most 32 devices are supported')
const serials = new Set<string>()
for (const d of devices) {
  const error = validateConnectorConfig(d.vendor, d.config ?? {})
  if (error) throw new Error(error)
  if (serials.has(d.config.serial.toLowerCase())) throw new Error('Duplicate robot serial')
  serials.add(d.config.serial.toLowerCase())
}
let stopping = false
const children = new Set<ChildProcess>(),
  timers = new Set<NodeJS.Timeout>()
const inherit = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'TZ',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]
const baseEnv: Record<string, string> = {}
for (const k of inherit) if (process.env[k] !== undefined) baseEnv[k] = process.env[k]!
function launch(d: any, delay = 1000) {
  if (stopping) return
  const spec = VENDORS[d.vendor as ConnectorVendor],
    c = d.config
  const env = {
    ...baseEnv,
    PLANTBOT_BASE: config.serverUrl.replace(/\/$/, ''),
    PLANTBOT_KEY: key,
    STREAM_BASE: '/media',
    PB_SERIAL: String(c.serial),
    PB_CALLSIGN: String(c.callsign ?? c.serial),
    PB_STREAMS: JSON.stringify(c.streams ?? []),
    ...spec.env(c),
    ...(c.dockX !== undefined && c.dockZ !== undefined
      ? { PB_DOCK_X: String(c.dockX), PB_DOCK_Z: String(c.dockZ) }
      : {}),
  }
  const started = Date.now(),
    child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), spec.entry], {
      cwd: root,
      env,
      stdio: 'inherit',
    })
  children.add(child)
  let ended = false
  const restart = () => {
    if (ended) return
    ended = true
    children.delete(child)
    if (stopping) return
    const next = Date.now() - started > 30000 ? 1000 : Math.min(30000, delay * 2)
    const timer = setTimeout(() => {
      timers.delete(timer)
      launch(d, next)
    }, delay)
    timers.add(timer)
    console.warn(`[adapter] ${d.vendor} stopped; reconnecting in ${delay}ms`)
  }
  child.once('exit', restart)
  child.once('error', restart)
}
for (const d of devices) launch(d)
console.log(`[adapter] supervising ${devices.length} robot adapter(s); vision runs independently`)
const keepAlive = setInterval(() => {}, 60000)
function stop() {
  if (stopping) return
  stopping = true
  clearInterval(keepAlive)
  for (const t of timers) clearTimeout(t)
  for (const p of children) p.kill('SIGTERM')
  const force = setTimeout(() => {
    for (const p of children) p.kill('SIGKILL')
  }, 2000)
  force.unref()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
