// Durable platform config — everything that must survive a restart while the
// sim itself stays ephemeral: users, per-site API keys, custom event types,
// uploaded occupancy maps and external robot registrations.
// Stored as JSON at server/data/config.json (atomic writes).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Severity, EventCategory } from './fleet.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// PB_DATA_DIR redirects all durable state (config.json, uploaded maps) —
// integration e2e tests boot throwaway platforms without touching dev data
export const DATA_DIR = process.env.PB_DATA_DIR ?? join(ROOT, 'data')
export const MAPS_DIR = join(DATA_DIR, 'maps')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
mkdirSync(MAPS_DIR, { recursive: true })

export type Role = 'viewer' | 'operator' | 'admin'
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export interface UserRec {
  username: string
  displayName: string
  salt: string
  hash: string
  /** siteId → role; '*' wildcard applies to every site */
  roles: Record<string, Role>
  seeded?: boolean
}

export interface ApiKeyRec {
  id: string
  label: string
  key: string
  createdAt: number
  lastUsedAt?: number
}

export interface CustomEventTypeRec {
  id: string
  label: string
  severity: Severity
  detail?: string
  category?: EventCategory
}

export interface PersistedMapRec {
  file: string // filename under data/maps
  resolution: number
  width: number
  height: number
  origin: [number, number]
  source: string
  uploadedAt: number
}

export interface ExternalRec {
  serial: string
  model: string
  vendor?: string
  callsign?: string
  family?: 'quadruped' | 'ugv'
  level: 'state-only' | 'dispatchable'
  ip?: string
  protocol?: string
  home?: { x: number; z: number }
  streams?: { id: string; name: string; kind?: 'camera' | 'thermal' | 'ogi' | 'lidar' | 'gas' | 'acoustic' | 'imu'; url?: string }[]
}

export interface SiteConfig {
  apiKeys: ApiKeyRec[]
  eventTypes: CustomEventTypeRec[]
  map?: PersistedMapRec
  externals: ExternalRec[]
}

export interface PlatformConfig {
  users: UserRec[]
  sites: Record<string, SiteConfig>
}

function hashPassword(password: string, salt?: string) {
  const s = salt ?? randomBytes(12).toString('hex')
  return { salt: s, hash: scryptSync(password, s, 32).toString('hex') }
}

export function verifyPassword(user: UserRec, password: string): boolean {
  const test = scryptSync(password, user.salt, 32)
  const real = Buffer.from(user.hash, 'hex')
  return test.length === real.length && timingSafeEqual(test, real)
}

function seededUsers(): UserRec[] {
  const mk = (username: string, displayName: string, envVar: string, fallback: string, roles: Record<string, Role>): UserRec => {
    const { salt, hash } = hashPassword(process.env[envVar] || fallback)
    return { username, displayName, salt, hash, roles, seeded: true }
  }
  return [
    // per-site role matrix in the spirit of Orbit/InOrbit: keep the role set
    // small (viewer < operator < admin) and scope it per site
    mk('admin', 'Site Admin', 'PB_ADMIN_PASSWORD', 'plantbot', { '*': 'admin' }),
    mk('operator', 'Shift Operator', 'PB_OPERATOR_PASSWORD', 'plantbot', { 'plant-07': 'operator', 'plant-12': 'viewer' }),
    mk('viewer', 'Read-only Viewer', 'PB_VIEWER_PASSWORD', 'plantbot', { '*': 'viewer' }),
  ]
}

let config: PlatformConfig

export function loadConfig(siteIds: string[]): PlatformConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PlatformConfig
    } catch {
      config = { users: seededUsers(), sites: {} }
    }
  } else {
    config = { users: seededUsers(), sites: {} }
  }
  // env-provided passwords always win for seeded users (rotation without edits)
  for (const [name, envVar] of [
    ['admin', 'PB_ADMIN_PASSWORD'],
    ['operator', 'PB_OPERATOR_PASSWORD'],
    ['viewer', 'PB_VIEWER_PASSWORD'],
  ] as const) {
    const pw = process.env[envVar]
    const u = config.users.find((x) => x.username === name)
    if (pw && u?.seeded) Object.assign(u, hashPassword(pw))
  }
  for (const id of siteIds) config.sites[id] ??= { apiKeys: [], eventTypes: [], externals: [] }
  seedApiKeys(siteIds)
  saveConfig()
  return config
}

/** Adapter onboarding without a manual console visit:
 *  - PB_SEED_KEYS="plant-07=pbk_abc,campus-east=pbk_def" pins production keys
 *    from the environment (systemd drop-in), so adapters and platform share
 *    secrets without anything entering git.
 *  - PB_DEV_KEYS=1 (set by the root `pnpm dev` script only) seeds the
 *    deterministic pbk_dev_<site> keys the bundled sim adapters default to. */
function seedApiKeys(siteIds: string[]) {
  const upsert = (siteId: string, key: string, label: string) => {
    const sc = config.sites[siteId]
    if (!sc || sc.apiKeys.some((k) => k.key === key)) return
    sc.apiKeys.push({ id: `AK-seed-${siteId}`, label, key, createdAt: Date.now() })
  }
  for (const pair of (process.env.PB_SEED_KEYS ?? '').split(',')) {
    const [siteId, key] = pair.split('=').map((s) => s.trim())
    if (siteId && key?.startsWith('pbk_')) upsert(siteId, key, 'seeded adapter key (env)')
  }
  if (process.env.PB_DEV_KEYS === '1')
    for (const id of siteIds) upsert(id, `pbk_dev_${id.replace(/-/g, '')}`, 'dev adapter key')
}

export function getConfig(): PlatformConfig {
  return config
}

let saveTimer: NodeJS.Timeout | null = null
export function saveConfig(defer = false) {
  if (defer) {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveConfig()
    }, 2000)
    return
  }
  const tmp = CONFIG_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(config, null, 2))
  renameSync(tmp, CONFIG_PATH)
}

export function roleFor(user: UserRec | null, siteId: string): Role {
  if (!user) return 'viewer' // anonymous keeps the public demo browsable
  return user.roles[siteId] ?? user.roles['*'] ?? 'viewer'
}

export function newApiKey(siteId: string, label: string): ApiKeyRec {
  const rec: ApiKeyRec = {
    id: `AK-${randomBytes(3).toString('hex')}`,
    label: label || 'unnamed key',
    key: `pbk_${randomBytes(24).toString('hex')}`,
    createdAt: Date.now(),
  }
  config.sites[siteId].apiKeys.push(rec)
  saveConfig()
  return rec
}

export function findApiKey(bearer: string): { siteId: string; rec: ApiKeyRec } | null {
  for (const [siteId, sc] of Object.entries(config.sites)) {
    const rec = sc.apiKeys.find((k) => k.key === bearer)
    if (rec) {
      rec.lastUsedAt = Date.now()
      saveConfig(true)
      return { siteId, rec }
    }
  }
  return null
}
