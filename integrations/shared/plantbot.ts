// Northbound client: the ONE way every adapter talks to Plantbot's open
// integration API (/api/integration/v1). Semantics mirror docs/integration.md:
// factsheet registration, ~1 Hz state (doubles as heartbeat), pull-based
// orders, custom events, batch readings, occupancy-map upload.
//
// The client never throws on transport errors — adapters must survive the
// platform being down (it may boot later than the sims) — so every method
// returns null/false on failure and the caller decides how loudly to care.

import type { Log } from './log.js'

export interface MissionStep {
  waypointId: string
  actions?: { type: string; durationS?: number }[]
}

export interface PlantbotOrder {
  id: string
  kind: 'goto' | 'mission' | 'announce' | 'pause' | 'resume' | 'abort' | 'ptz'
  payload: {
    x?: number
    z?: number
    dock?: boolean
    text?: string
    missionId?: string
    name?: string
    steps?: MissionStep[]
    channelId?: string
    pan?: number
    tilt?: number
    zoom?: number
  }
  state: string
  createdAt: number
}

export interface Factsheet {
  serial: string
  model: string
  vendor?: string
  callsign?: string
  family?: 'quadruped' | 'ugv'
  level: 'state-only' | 'dispatchable'
  ip?: string
  protocol?: string
  home?: { x: number; z: number }
  streams?: { id: string; name: string; kind?: string; url?: string }[]
}

export interface StateReport {
  x?: number
  z?: number
  heading?: number
  speed?: number
  battery?: number
  mode?: 'idle' | 'navigating' | 'executing' | 'teleop' | 'charging'
  errors?: string[]
}

export interface EventReport {
  type: string
  robotSerial?: string
  detail?: string
  severity?: 'critical' | 'high' | 'info'
  x?: number
  z?: number
  snapshotUrl?: string
  confidence?: number
  category?: 'security' | 'fire' | 'env' | 'equipment' | 'robot-fault'
  evidence?: { kind: 'image' | 'reading'; url?: string; reading?: { metric: string; value: number; unit?: string } }[]
  runId?: string
}

export interface SiteFactsheet {
  site: { id: string; name: string; bounds: { x: [number, number]; z: [number, number] }; [k: string]: unknown }
  waypoints: { id: string; label: string; x: number; z: number; kind?: string }[]
  zones: unknown[]
  eventTypes: { id: string; label: string; severity: string }[]
}

export class PlantbotClient {
  private base: string
  private key: string
  private log: { info: Log; warn: Log }
  private lastErr = ''

  constructor(opts: { base?: string; key: string; log: { info: Log; warn: Log } }) {
    this.base = (opts.base ?? process.env.PLANTBOT_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
    this.key = opts.key
    this.log = opts.log
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.base}/api/integration/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        this.noteErr(`${method} ${path} → ${res.status} ${text.slice(0, 140)}`)
        return null
      }
      this.lastErr = ''
      return (await res.json()) as T
    } catch (e) {
      this.noteErr(`${method} ${path} → ${(e as Error).message}`)
      return null
    }
  }

  /** collapse repeated transport failures into one warning, not a log flood */
  private noteErr(msg: string) {
    if (msg !== this.lastErr) {
      this.log.warn(`plantbot ${msg}`)
      this.lastErr = msg
    }
  }

  site(): Promise<SiteFactsheet | null> {
    return this.call('GET', '/site')
  }

  /** register/refresh the factsheet; retries until the platform accepts it */
  async registerUntilUp(fs: Factsheet, retryMs = 3000): Promise<void> {
    for (;;) {
      const ok = await this.call<{ robot: unknown }>('POST', '/robots', fs)
      if (ok) {
        this.log.info(`registered ${fs.serial} (${fs.level})`)
        return
      }
      await new Promise((r) => setTimeout(r, retryMs))
    }
  }

  /** state report; response carries ordersPending so adapters know when to pull */
  state(serial: string, s: StateReport): Promise<{ ok: boolean; ordersPending: number } | null> {
    return this.call('POST', `/robots/${encodeURIComponent(serial)}/state`, s)
  }

  async pullOrders(serial: string): Promise<PlantbotOrder[]> {
    const res = await this.call<{ orders: PlantbotOrder[] }>('GET', `/robots/${encodeURIComponent(serial)}/orders`)
    return res?.orders ?? []
  }

  orderStatus(id: string, status: 'done' | 'failed', note?: string): Promise<unknown | null> {
    return this.call('POST', `/orders/${encodeURIComponent(id)}/status`, { status, note })
  }

  async event(ev: EventReport): Promise<boolean> {
    return (await this.call('POST', '/events', ev)) !== null
  }

  async readings(serial: string, items: { metric: string; value: number; ts?: number }[]): Promise<number> {
    const res = await this.call<{ accepted: number }>('POST', `/robots/${encodeURIComponent(serial)}/readings`, {
      readings: items,
    })
    return res?.accepted ?? 0
  }

  /** ROS map_server-style occupancy upload (PNG data URL) */
  uploadMap(m: { name: string; resolution: number; origin: [number, number]; image: string }): Promise<unknown | null> {
    return this.call('POST', '/maps', m)
  }

  /** evidence-capture service: platform grabs a frame from a registered stream
   *  source and returns a hosted snapshot URL for event evidence */
  async snapshot(stream: string): Promise<string | undefined> {
    const res = await this.call<{ url?: string }>('POST', '/snapshot', { stream })
    return res?.url
  }
}
