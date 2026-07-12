// Managed connectors — platform-hosted vendor adapters. The deployment story
// the UI sells: pick a vendor, type the robot's address + credentials, and the
// platform runs the adapter for you. Architecture stays "pure integration
// layer": each connector is a SUPERVISED CHILD PROCESS running the exact same
// adapter code from integrations/ that an integrator would run by hand, and it
// talks back over the loopback integration API with an internally-issued key.
// No vendor protocol ever runs inside the platform's event loop — a crashing
// driver costs a respawn, not the platform.
//
// Assumes the platform host can reach the robots (on-prem / same network);
// cloud deployments keep using external adapters over the northbound API.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ConnectorRec, type ConnectorVendor,
  listAllConnectors, newApiKey, deleteApiKey, listApiKeys,
} from './config.js'

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(SERVER_ROOT, '..')
const INTEGRATIONS_DIR = join(REPO_ROOT, 'integrations')
const API_PORT = Number(process.env.API_PORT ?? 8787)

/** tsx CLI (the adapters are TS entrypoints) — pnpm hoists per workspace */
function resolveTsx(): string {
  for (const p of [
    join(INTEGRATIONS_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ])
    if (existsSync(p)) return p
  throw new Error('tsx CLI not found — managed connectors need the integrations workspace installed')
}

// ---------- vendor catalog (drives the UI form + env mapping) ----------

export interface ConnectorField {
  key: string
  label: string
  /** text | number | password */
  type?: 'text' | 'number' | 'password'
  required?: boolean
  placeholder?: string
  hint?: string
}

interface VendorSpec {
  vendor: ConnectorVendor
  title: string
  model: string
  entry: string
  /** vendor-specific connection fields (identity fields are shared) */
  fields: ConnectorField[]
  /** map config → adapter env */
  env: (cfg: Record<string, unknown>) => Record<string, string>
}

const str = (v: unknown, d = '') => (v === undefined || v === null || v === '' ? d : String(v))

const VENDORS: Record<ConnectorVendor, VendorSpec> = {
  spot: {
    vendor: 'spot',
    title: 'Boston Dynamics Spot',
    model: 'Spot',
    entry: 'spot/adapter/main.ts',
    fields: [
      { key: 'host', label: 'Robot IP', required: true, placeholder: '10.0.10.4' },
      { key: 'port', label: 'gRPC port', type: 'number', placeholder: '443' },
      { key: 'user', label: 'Username', required: true, placeholder: 'admin' },
      { key: 'pass', label: 'Password', type: 'password', required: true },
      { key: 'dockX', label: 'Dock X (m)', type: 'number', hint: 'charge-pile pose in world frame' },
      { key: 'dockZ', label: 'Dock Z (m)', type: 'number' },
    ],
    env: (c) => ({
      SPOT_HOST: str(c.host, '127.0.0.1'),
      SPOT_PORT: str(c.port, '443'),
      SPOT_USER: str(c.user, 'admin'),
      SPOT_PASS: str(c.pass),
    }),
  },
  deeprobotics: {
    vendor: 'deeprobotics',
    title: 'DeepRobotics Jueying X30',
    model: 'Jueying X30',
    entry: 'deeprobotics/adapter/main.ts',
    fields: [
      { key: 'host', label: 'Robot IP', required: true, placeholder: '192.168.1.106' },
      { key: 'port', label: 'robotserver port', type: 'number', placeholder: '30000' },
      { key: 'dockX', label: 'Dock X (m)', type: 'number', required: true, hint: 'charge-pile pose in world frame' },
      { key: 'dockZ', label: 'Dock Z (m)', type: 'number', required: true },
    ],
    env: (c) => ({
      DR_HOST: str(c.host, '127.0.0.1'),
      DR_PORT: str(c.port, '30000'),
    }),
  },
  gosuncn: {
    vendor: 'gosuncn',
    title: 'Gosuncn GS Patrol F2',
    model: 'GS Patrol F2',
    entry: 'gosuncn/adapter/main.ts',
    fields: [
      { key: 'base', label: 'GoRobot cloud URL', required: true, placeholder: 'http://10.0.0.9:9101' },
      { key: 'user', label: 'Username', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true },
      { key: 'sn', label: 'Vendor SN', required: true, placeholder: 'F2230204117', hint: 'the robot on the GoRobot cloud this connector drives' },
      { key: 'pxPerM', label: 'px per meter', type: 'number', hint: 'from the CALIB page (laser map scale)' },
      { key: 'originX', label: 'Origin X', type: 'number' },
      { key: 'originZ', label: 'Origin Z', type: 'number' },
    ],
    env: (c) => ({
      GOSUNCN_BASE: str(c.base, 'http://127.0.0.1:9101'),
      GOSUNCN_USER: str(c.user),
      GOSUNCN_PASS: str(c.pass),
      ...(str(c.sn) ? { PB_GS_SN: str(c.sn) } : {}),
      ...(c.pxPerM !== undefined && c.pxPerM !== '' ? { GOSUNCN_PX_PER_M: str(c.pxPerM) } : {}),
      ...(c.originX !== undefined && c.originX !== '' ? { GOSUNCN_ORIGIN_X: str(c.originX) } : {}),
      ...(c.originZ !== undefined && c.originZ !== '' ? { GOSUNCN_ORIGIN_Z: str(c.originZ) } : {}),
    }),
  },
}

/** identity fields shared by every vendor (gosuncn's serial comes from its cloud) */
const IDENTITY_FIELDS: ConnectorField[] = [
  { key: 'serial', label: 'Robot serial', required: true, placeholder: 'BD-91250777' },
  { key: 'callsign', label: 'Callsign', placeholder: 'SPOT·W1' },
]

export function connectorCatalog() {
  return Object.values(VENDORS).map((v) => ({
    vendor: v.vendor,
    title: v.title,
    model: v.model,
    identity: IDENTITY_FIELDS,
    fields: v.fields,
    streamsHint: true,
  }))
}

export function validateConnectorConfig(vendor: string, cfg: Record<string, unknown>): string | null {
  const spec = VENDORS[vendor as ConnectorVendor]
  if (!spec) return `unknown vendor '${vendor}'`
  const required = [...IDENTITY_FIELDS, ...spec.fields].filter((f) => f.required)
  for (const f of required) if (str(cfg[f.key]) === '') return `missing required field '${f.key}'`
  const streams = cfg.streams
  if (streams !== undefined && !Array.isArray(streams)) return `'streams' must be an array`
  for (const s of (streams as { name?: unknown; url?: unknown }[]) ?? [])
    if (str(s.name) === '' || str(s.url) === '') return `each stream needs a name and a url`
  return null
}

// ---------- internal key (per site, re-issued each boot, plaintext in memory only) ----------

const MANAGED_LABEL = 'managed connectors (internal)'
const managedKeys = new Map<string, string>()

function managedKey(siteId: string): string {
  const hit = managedKeys.get(siteId)
  if (hit) return hit
  // drop stale rows from previous boots (their plaintext died with the process)
  for (const k of listApiKeys(siteId)) if (k.label === MANAGED_LABEL) deleteApiKey(siteId, k.id)
  const fresh = newApiKey(siteId, MANAGED_LABEL)
  managedKeys.set(siteId, fresh.key)
  return fresh.key
}

// ---------- supervisor ----------

export interface ConnectorRuntime {
  status: 'running' | 'backoff' | 'stopped'
  pid?: number
  restarts: number
  since?: number
  lastExit?: string
}

interface Proc {
  child?: ChildProcess
  timer?: NodeJS.Timeout
  wantUp: boolean
  restarts: number
  backoffMs: number
  startedAt?: number
  lastExit?: string
  logs: string[]
}

const procs = new Map<string, Proc>()
const keyOf = (rec: Pick<ConnectorRec, 'siteId' | 'id'>) => `${rec.siteId}/${rec.id}`

function pushLog(p: Proc, line: string) {
  // adapter lines already carry their own HH:MM:SS — don't double-stamp
  p.logs.push(/^\d{2}:\d{2}:\d{2}\b/.test(line) ? line : `${new Date().toISOString().slice(11, 19)} ${line}`)
  if (p.logs.length > 200) p.logs.splice(0, p.logs.length - 200)
}

function buildEnv(rec: ConnectorRec): Record<string, string> {
  const spec = VENDORS[rec.vendor]
  const cfg = rec.config
  const streams = Array.isArray(cfg.streams) ? (cfg.streams as { name: string; url: string; kind?: string }[]) : []
  return {
    ...(process.env as Record<string, string>),
    PLANTBOT_BASE: `http://127.0.0.1:${API_PORT}`,
    PLANTBOT_KEY: managedKey(rec.siteId),
    STREAM_BASE: '/media',
    // custom identity — adapters build their profile from these instead of
    // the built-in demo PROFILES (see integrations/shared/bridge.ts)
    ...(str(cfg.serial) ? { PB_SERIAL: str(cfg.serial) } : {}),
    ...(str(cfg.callsign) ? { PB_CALLSIGN: str(cfg.callsign) } : {}),
    ...(str(cfg.dockX) !== '' && str(cfg.dockZ) !== '' ? { PB_DOCK_X: str(cfg.dockX), PB_DOCK_Z: str(cfg.dockZ) } : {}),
    ...(streams.length ? { PB_STREAMS: JSON.stringify(streams) } : {}),
    ...spec.env(cfg),
  }
}

function launch(rec: ConnectorRec) {
  const key = keyOf(rec)
  const p = procs.get(key) ?? { wantUp: true, restarts: 0, backoffMs: 2000, logs: [] }
  procs.set(key, p)
  p.wantUp = true
  if (p.child) return // already up
  const spec = VENDORS[rec.vendor]
  const child = spawn(process.execPath, [resolveTsx(), spec.entry], {
    cwd: INTEGRATIONS_DIR,
    env: buildEnv(rec),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.child = child
  p.startedAt = Date.now()
  pushLog(p, `▶ spawn ${rec.vendor} adapter (pid ${child.pid})`)
  const onLine = (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) pushLog(p, line.trimEnd())
  }
  child.stdout?.on('data', onLine)
  child.stderr?.on('data', onLine)
  child.on('exit', (code, signal) => {
    p.child = undefined
    p.lastExit = signal ? `signal ${signal}` : `code ${code}`
    pushLog(p, `■ exited (${p.lastExit})`)
    if (!p.wantUp) return
    // ran long enough → treat as healthy before the crash, reset backoff
    if (p.startedAt && Date.now() - p.startedAt > 60_000) p.backoffMs = 2000
    p.restarts++
    pushLog(p, `… respawn in ${p.backoffMs / 1000}s`)
    p.timer = setTimeout(() => {
      p.timer = undefined
      if (p.wantUp) launch(rec)
    }, p.backoffMs)
    p.backoffMs = Math.min(p.backoffMs * 2, 30_000)
  })
}

export function startConnector(rec: ConnectorRec) {
  launch(rec)
}

export function stopConnector(siteId: string, id: string) {
  const p = procs.get(`${siteId}/${id}`)
  if (!p) return
  p.wantUp = false
  if (p.timer) {
    clearTimeout(p.timer)
    p.timer = undefined
  }
  p.backoffMs = 2000
  p.child?.kill('SIGTERM')
}

export function restartConnector(rec: ConnectorRec) {
  const p = procs.get(keyOf(rec))
  if (p?.child) {
    // exit handler respawns with fresh config since wantUp stays true
    p.backoffMs = 500
    p.child.kill('SIGTERM')
    p.wantUp = true
  } else {
    launch(rec)
  }
}

export function dropConnector(siteId: string, id: string) {
  stopConnector(siteId, id)
  procs.delete(`${siteId}/${id}`)
}

export function connectorRuntime(siteId: string, id: string): ConnectorRuntime {
  const p = procs.get(`${siteId}/${id}`)
  if (!p) return { status: 'stopped', restarts: 0 }
  return {
    // intent-first: a just-SIGTERMed child may linger a beat — report the
    // state the operator asked for, not the in-flight teardown
    status: !p.wantUp ? 'stopped' : p.child ? 'running' : 'backoff',
    pid: p.child?.pid,
    restarts: p.restarts,
    since: p.child ? p.startedAt : undefined,
    lastExit: p.lastExit,
  }
}

export function connectorLogs(siteId: string, id: string): string[] {
  return procs.get(`${siteId}/${id}`)?.logs ?? []
}

/** boot: resume every enabled connector (call after the worlds are up) */
export function resumeConnectors(log: (msg: string) => void) {
  const enabled = listAllConnectors().filter((c) => c.enabled)
  for (const rec of enabled) launch(rec)
  if (enabled.length) log(`[connectors] resumed ${enabled.length} managed adapter(s)`)
}

/** site deletion: tear down its processes (rows go with deleteSiteRow) */
export function stopSiteConnectors(siteId: string) {
  for (const key of procs.keys())
    if (key.startsWith(`${siteId}/`)) {
      const [, id] = key.split('/')
      dropConnector(siteId, id)
    }
  managedKeys.delete(siteId)
}

/** shutdown: kill children so they don't outlive the platform */
export function shutdownConnectors() {
  for (const p of procs.values()) {
    p.wantUp = false
    if (p.timer) clearTimeout(p.timer)
    p.child?.kill('SIGTERM')
  }
}
