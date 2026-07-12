// SQLite persistence — the single durable store (node:sqlite, zero deps,
// Node ≥ 22.5). Everything that must survive a restart lives here: identity
// (users/keys), site modeling (sites/waypoints/zones/cameras/transforms),
// ops state (rules/templates/schedules/missions/events/orders/commands) and
// a rolling readings window. The World keeps its in-memory read model for the
// 4 Hz hot path; mutators write through, boot hydrates.
//
// Aggregates (rule/template/schedule/mission/event/order) are stored as JSON
// blobs keyed by (site_id, id) — the TS types stay the schema of record and
// can evolve without column migrations; indexed columns exist only where we
// query (status, ts). Readings are normalized for range scans + retention.

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// PB_DATA_DIR redirects all durable state — integration e2e boots throwaway
// platforms without touching dev data
export const DATA_DIR = process.env.PB_DATA_DIR ?? join(ROOT, 'data')
export const MAPS_DIR = join(DATA_DIR, 'maps')
mkdirSync(MAPS_DIR, { recursive: true })

export const db = new DatabaseSync(join(DATA_DIR, 'plantbot.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA foreign_keys = ON')

// ---------- schema ----------

const SCHEMA_VERSION = 2

function migrate() {
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (v >= SCHEMA_VERSION) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username     TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      salt         TEXT NOT NULL,
      hash         TEXT NOT NULL,
      roles        TEXT NOT NULL,          -- json {siteId|'*': role}
      seeded       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      site_id      TEXT NOT NULL,
      label        TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,   -- sha256 hex; plaintext never stored
      prefix       TEXT NOT NULL,          -- display: pbk_xxxx…
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sites (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      operator   TEXT NOT NULL,
      bounds     TEXT NOT NULL,            -- json {x:[..],z:[..]}
      dock_wp    TEXT NOT NULL DEFAULT '',
      splat      TEXT,                     -- json {name,url} | null
      buildings  TEXT NOT NULL DEFAULT '[]',
      map_meta   TEXT,                     -- json SiteMapMeta for built-in demo underlays;
                                           -- uploaded occupancy maps live in site_maps
      demo       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waypoints (
      site_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      x REAL NOT NULL, z REAL NOT NULL, kind TEXT NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS zones (
      site_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, polygon TEXT NOT NULL, label TEXT,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS cameras (
      site_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      place TEXT NOT NULL DEFAULT '', stream_key TEXT NOT NULL,
      rtsp TEXT, file TEXT,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS transforms (
      site_id TEXT NOT NULL, id TEXT NOT NULL,
      from_frame TEXT NOT NULL, to_frame TEXT NOT NULL,
      params TEXT NOT NULL,                -- json {s,thetaRad,t:[x,z]}
      note TEXT,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS site_maps (
      site_id TEXT PRIMARY KEY,
      file TEXT NOT NULL, resolution REAL NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL,
      origin_x REAL NOT NULL, origin_z REAL NOT NULL,
      source TEXT NOT NULL, uploaded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS externals (
      site_id TEXT NOT NULL, serial TEXT NOT NULL,
      rec TEXT NOT NULL,                   -- json ExternalRec
      PRIMARY KEY (site_id, serial)
    );
    CREATE TABLE IF NOT EXISTS event_types (
      site_id TEXT NOT NULL, id TEXT NOT NULL,
      data TEXT NOT NULL,                  -- json EventTypeDef sans builtin
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS rules (
      site_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS templates (
      site_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      site_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS missions (
      site_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions (site_id, status);
    CREATE TABLE IF NOT EXISTS events (
      site_id TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (site_id, ts);
    CREATE TABLE IF NOT EXISTS orders (
      site_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS commands (
      site_id TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (site_id, id)
    );
    CREATE TABLE IF NOT EXISTS readings (
      site_id TEXT NOT NULL, robot_id TEXT NOT NULL, metric TEXT NOT NULL,
      ts INTEGER NOT NULL, value REAL NOT NULL,
      payload_id TEXT, quality TEXT, wp TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_readings ON readings (site_id, robot_id, metric, ts);
    CREATE TABLE IF NOT EXISTS connectors (
      site_id    TEXT NOT NULL, id TEXT NOT NULL,
      vendor     TEXT NOT NULL,             -- spot | deeprobotics | gosuncn
      name       TEXT NOT NULL,
      config     TEXT NOT NULL,             -- json: connection params + identity + streams
                                            -- (credentials inside — served on admin routes only)
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_id, id)
    );
  `)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
migrate()

// ---------- helpers ----------

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const J = (v: unknown) => JSON.stringify(v)

/** one-time import of the legacy config.json (pre-SQLite deployments) */
export function importLegacyConfig() {
  const legacy = join(DATA_DIR, 'config.json')
  if (!existsSync(legacy)) return
  const hasUsers = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0
  if (hasUsers) return // db already live — don't double-import
  try {
    const cfg = JSON.parse(readFileSync(legacy, 'utf8')) as {
      users?: { username: string; displayName: string; salt: string; hash: string; roles: Record<string, string>; seeded?: boolean }[]
      sites?: Record<
        string,
        {
          apiKeys?: { id: string; label: string; key: string; createdAt: number; lastUsedAt?: number }[]
          eventTypes?: unknown[]
          map?: { file: string; resolution: number; width: number; height: number; origin: [number, number]; source: string; uploadedAt: number }
          externals?: { serial: string }[]
        }
      >
    }
    const tx = db.prepare('BEGIN')
    tx.run()
    try {
      for (const u of cfg.users ?? [])
        db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?,?,?)').run(
          u.username, u.displayName, u.salt, u.hash, J(u.roles), u.seeded ? 1 : 0)
      for (const [siteId, sc] of Object.entries(cfg.sites ?? {})) {
        for (const k of sc.apiKeys ?? [])
          db.prepare('INSERT OR IGNORE INTO api_keys VALUES (?,?,?,?,?,?,?)').run(
            k.id, siteId, k.label, sha256(k.key), `${k.key.slice(0, 12)}…`, k.createdAt, k.lastUsedAt ?? null)
        for (const t of sc.eventTypes ?? [])
          db.prepare('INSERT OR IGNORE INTO event_types VALUES (?,?,?)').run(siteId, (t as { id: string }).id, J(t))
        if (sc.map)
          db.prepare('INSERT OR REPLACE INTO site_maps VALUES (?,?,?,?,?,?,?,?,?)').run(
            siteId, sc.map.file, sc.map.resolution, sc.map.width, sc.map.height,
            sc.map.origin[0], sc.map.origin[1], sc.map.source, sc.map.uploadedAt)
        for (const e of sc.externals ?? [])
          db.prepare('INSERT OR IGNORE INTO externals VALUES (?,?,?)').run(siteId, e.serial, J(e))
      }
      db.prepare('COMMIT').run()
    } catch (e) {
      db.prepare('ROLLBACK').run()
      throw e
    }
    renameSync(legacy, `${legacy}.imported`)
    console.log('[db] imported legacy config.json → plantbot.db')
  } catch (e) {
    console.error('[db] legacy config import failed:', e)
  }
}

/** retention sweeps — run at boot and hourly from index.ts */
export function sweepRetention() {
  const now = Date.now()
  db.prepare('DELETE FROM readings WHERE ts < ?').run(now - 7 * 86_400_000)
  db.prepare("DELETE FROM orders WHERE state IN ('done','failed') AND updated_at < ?").run(now - 7 * 86_400_000)
  db.prepare('DELETE FROM events WHERE ts < ?').run(now - 90 * 86_400_000)
  db.prepare('DELETE FROM commands WHERE ts < ?').run(now - 30 * 86_400_000)
  // finished runs: keep 90 days
  db.prepare("DELETE FROM missions WHERE status IN ('done','failed','aborted') AND updated_at < ?").run(now - 90 * 86_400_000)
}

export function inTx<T>(fn: () => T): T {
  db.prepare('BEGIN').run()
  try {
    const out = fn()
    db.prepare('COMMIT').run()
    return out
  } catch (e) {
    db.prepare('ROLLBACK').run()
    throw e
  }
}
