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

export { connectorCatalog, validateConnectorConfig, type ConnectorField } from '../../integrations/shared/connector-catalog.js'
import { VENDORS } from '../../integrations/shared/connector-catalog.js'
const str = (v: unknown, d = '') => (v === undefined || v === null || v === '' ? d : String(v))

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
  /** operator-triggered restart in flight — keep the respawn fast (don't let the
   *  exit handler reset backoff to the healthy-process default) */
  manualRestart?: boolean
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

// only these are inherited from the platform's environment — everything else
// (SESSION_SECRET, PB_*_PASSWORD, OIDC_CLIENT_SECRET, PB_SEED_KEYS, …) must never
// leak into a vendor adapter child. Adapter-facing config is set explicitly below.
const INHERIT_ENV = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const

function buildEnv(rec: ConnectorRec): Record<string, string> {
  const spec = VENDORS[rec.vendor]
  const cfg = rec.config
  const streams = Array.isArray(cfg.streams) ? (cfg.streams as { name: string; url: string; kind?: string }[]) : []
  const inherited: Record<string, string> = {}
  for (const k of INHERIT_ENV) {
    const v = process.env[k]
    if (v !== undefined) inherited[k] = v
  }
  return {
    ...inherited,
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
    if (p.manualRestart) {
      // operator asked for this restart — keep it snappy regardless of uptime
      p.manualRestart = false
      p.backoffMs = 500
    } else if (p.startedAt && Date.now() - p.startedAt > 60_000) {
      // ran long enough → treat as healthy before the crash, reset backoff
      p.backoffMs = 2000
    }
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
    // exit handler respawns with fresh config since wantUp stays true; the
    // manualRestart flag keeps the respawn fast (see the exit handler)
    p.manualRestart = true
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

/** shutdown: SIGTERM every child, then SIGKILL any that outlive a 2 s grace so a
 *  wedged adapter can't outlive the platform. Resolves once all children are down
 *  (or the grace elapses) — the caller awaits this before process.exit. */
export function shutdownConnectors(): Promise<void> {
  const pending: Promise<void>[] = []
  for (const p of procs.values()) {
    p.wantUp = false
    if (p.timer) {
      clearTimeout(p.timer)
      p.timer = undefined
    }
    const child = p.child
    if (!child) continue
    pending.push(
      new Promise<void>((resolve) => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
        child.once('exit', () => {
          clearTimeout(kill)
          resolve()
        })
        child.kill('SIGTERM')
      }),
    )
  }
  return Promise.all(pending).then(() => undefined)
}
