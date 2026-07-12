// @plantbot/adapter-sdk — the TypeScript client for Plantbot's open
// integration API (/api/integration/v1). Write a vendor adapter in ~50 lines:
// register a factsheet, report state at ~1 Hz, pull orders, execute them with
// your robot's own protocol, report events/readings with evidence snapshots.
//
// Design contract (mirrors docs/integration.md):
// - The client NEVER throws on transport errors. Adapters must outlive
//   platform restarts, so every method returns null/false/[] on failure and
//   the caller decides how loudly to care.
// - State reports double as the heartbeat: >20 s of silence marks the robot
//   OFFLINE on the platform; the response carries `ordersPending` so you know
//   when to pull.
// - Node ≥ 18 (global fetch). Zero dependencies.

export interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
}

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
  /** camera/thermal channels this robot publishes — url may be an
   *  adapter-hosted file/HLS URL or the robot's native rtsp:// source */
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

const consoleLog: Logger = {
  info: (m) => console.log(`[plantbot] ${m}`),
  warn: (m) => console.warn(`[plantbot] ${m}`),
}

export class PlantbotClient {
  private base: string
  private key: string
  private log: Logger
  private lastErr = ''

  constructor(opts: { key: string; base?: string; log?: Logger }) {
    this.base = (opts.base ?? process.env.PLANTBOT_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
    this.key = opts.key
    this.log = opts.log ?? consoleLog
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

  /** the site's shape: bounds, waypoints, zones, event vocabulary */
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

  /** one registration attempt (when you manage your own retry loop) */
  async register(fs: Factsheet): Promise<boolean> {
    return (await this.call('POST', '/robots', fs)) !== null
  }

  /** ~1 Hz state report; doubles as the heartbeat. The response carries
   *  ordersPending so adapters know when to pull. */
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

  /** batch payload readings. Only metrics in the site registry are accepted —
   *  the response carries that registry (`metrics`), so a rejected write
   *  (`accepted: 0`) tells you exactly which metric ids are valid. */
  async readings(
    serial: string,
    items: { metric: string; value: number; ts?: number }[],
  ): Promise<{ accepted: number; skipped: number; metrics: string[] }> {
    const res = await this.call<{ accepted: number; skipped: number; metrics: string[] }>(
      'POST',
      `/robots/${encodeURIComponent(serial)}/readings`,
      { readings: items },
    )
    return res ?? { accepted: 0, skipped: 0, metrics: [] }
  }

  /** ROS map_server-style occupancy upload (PNG data URL) */
  uploadMap(m: { name: string; resolution: number; origin: [number, number]; image: string }): Promise<unknown | null> {
    return this.call('POST', '/maps', m)
  }

  /** evidence-capture service: the platform grabs a frame from a registered
   *  stream source and returns a hosted snapshot URL for event evidence */
  async snapshot(stream: string): Promise<string | undefined> {
    const res = await this.call<{ url?: string }>('POST', '/snapshot', { stream })
    return res?.url
  }

  /** deregister (rarely needed — going silent just marks the robot OFFLINE) */
  async removeRobot(serial: string): Promise<boolean> {
    return (await this.call('DELETE', `/robots/${encodeURIComponent(serial)}`)) !== null
  }
}

// ---------- adapter etiquette helpers ----------

/** poll /site until the platform is up — adapters must outlive platform restarts */
export async function waitForSite(pb: PlantbotClient, retryMs = 3000): Promise<SiteFactsheet> {
  for (;;) {
    const s = await pb.site()
    if (s) return s
    await new Promise((r) => setTimeout(r, retryMs))
  }
}

/** vendor-side robot fault → platform 'fault' event (the robot-health stream) */
export function reportFault(pb: PlantbotClient, serial: string, detail: string): void {
  void pb.event({ type: 'fault', robotSerial: serial, detail, severity: 'high', category: 'robot-fault' })
}

/** after a state report: pull pending orders and hand each to the executor.
 *  The executor's return value is ignored — `return pb.orderStatus(…)` is fine. */
export async function pumpOrders(
  pb: PlantbotClient,
  serial: string,
  rep: { ordersPending: number } | null,
  exec: (order: PlantbotOrder) => unknown,
): Promise<void> {
  if (!rep || rep.ordersPending <= 0) return
  for (const order of await pb.pullOrders(serial)) void exec(order)
}

// ---------- waypoint mission runner ----------
// For vendors whose protocol has no native multi-point mission: navigate
// point-by-point, honor pause/abort, dwell per the step's action durations,
// settle the order. Vendors with a native task list (e.g. DeepRobotics
// Type 1003) should map one order to one vendor task instead.

export interface MissionRun {
  orderId: string
  missionId?: string
  aborted: boolean
  paused: boolean
}

export async function runWaypointMission(opts: {
  pb: PlantbotClient
  order: PlantbotOrder
  run: MissionRun
  waypoints: readonly { id: string; x: number; z: number }[]
  /** vendor motion primitive — resolve true when the point is reached */
  navTo: (x: number, z: number) => Promise<{ ok: boolean; note?: string }>
  /** vendor-flavored completion note */
  doneNote: (done: number, total: number) => string
  onSettled?: () => void
}): Promise<void> {
  const { pb, order, run, waypoints, navTo } = opts
  const steps = order.payload.steps ?? []
  let done = 0
  for (const step of steps) {
    if (run.aborted) break
    while (run.paused && !run.aborted) await new Promise((r) => setTimeout(r, 500))
    const wp = waypoints.find((w) => w.id === step.waypointId)
    if (!wp) continue
    const r = await navTo(wp.x, wp.z)
    if (!r.ok) {
      if (!run.aborted) {
        await pb.orderStatus(order.id, 'failed', `stalled at ${step.waypointId}${r.note ? `: ${r.note}` : ''}`)
        opts.onSettled?.()
        return
      }
      break
    }
    // dwell for the step's action durations — capture/scan happens on-robot
    const dwell = step.actions?.reduce((s, a) => s + (a.durationS ?? 3), 0) ?? 4
    await new Promise((r2) => setTimeout(r2, Math.min(dwell, 20) * 1000))
    done++
  }
  await pb.orderStatus(
    order.id,
    run.aborted ? 'failed' : 'done',
    run.aborted ? `aborted after ${done}/${steps.length} waypoints` : opts.doneNote(done, steps.length),
  )
  opts.onSettled?.()
}
