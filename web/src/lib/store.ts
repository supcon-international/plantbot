import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { BASE } from './base'
import type {
  Building,
  Channel,
  Command,
  DetectionEvent,
  DetectionRule,
  EventLifecycle,
  EventTypeDef,
  FrameTransform,
  MapAsset,
  Me,
  MetricDef,
  Mission,
  MissionTemplate,
  Reading,
  Role,
  RobotSpec,
  Schedule,
  SiteCamera,
  SiteInfo,
  SiteSummary,
  StreamSession,
  Telemetry,
  Waypoint,
  Zone,
} from './types'

interface HistoryPoint {
  t: number
  speed: number
  rssi: number
  battery: number
  latency: number
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

/** fetch with the deploy prefix (sub-path hosting) applied */
export const apiFetch = (path: string, init?: RequestInit) =>
  fetch(BASE + path, { credentials: 'same-origin', ...init })

// ---------- site selection (persisted) ----------

interface SiteState {
  siteId: string
  setSite: (id: string) => void
}

export const useSite = create<SiteState>()(
  persist((set) => ({ siteId: 'plant-07', setSite: (siteId) => set({ siteId }) }), { name: 'aegis-site' }),
)

/** site-scoped fetch — routes through /api/sites/<current site> */
export const sfetch = (path: string, init?: RequestInit) =>
  apiFetch(`/api/sites/${useSite.getState().siteId}${path}`, init)

// ---------- auth ----------

interface AuthState {
  me: Me | null
  loaded: boolean
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<string | null>
  logout: () => Promise<void>
  roleFor: (siteId: string) => Role
  /** current-site permission check */
  can: (min: Role) => boolean
}

export const useAuth = create<AuthState>((set, get) => ({
  me: null,
  loaded: false,
  refresh: async () => {
    try {
      const me = (await (await apiFetch('/api/auth/me')).json()) as Me
      set({ me, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
  login: async (username, password) => {
    const r = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!r.ok) return ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? 'login failed'
    await get().refresh()
    return null
  },
  logout: async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    await get().refresh()
  },
  roleFor: (siteId) => get().me?.sites.find((s) => s.id === siteId)?.role ?? 'viewer',
  can: (min) => ROLE_RANK[get().roleFor(useSite.getState().siteId)] >= ROLE_RANK[min],
}))

/** reactive role hook for the current site */
export function useRole(): Role {
  const me = useAuth((s) => s.me)
  const siteId = useSite((s) => s.siteId)
  return me?.sites.find((s) => s.id === siteId)?.role ?? 'viewer'
}

export function useCan(min: Role): boolean {
  return ROLE_RANK[useRole()] >= ROLE_RANK[min]
}

// ---------- realtime app state ----------

interface AppState {
  connected: boolean
  site?: SiteInfo
  sites: SiteSummary[]
  robots: RobotSpec[]
  cameras: SiteCamera[]
  waypoints: Waypoint[]
  zones: Zone[]
  buildings: Building[]
  missions: Mission[]
  templates: MissionTemplate[]
  schedules: Schedule[]
  rules: DetectionRule[]
  eventTypes: EventTypeDef[]
  channels: Channel[]
  maps: MapAsset[]
  transforms: FrameTransform[]
  metricDefs: MetricDef[]
  telemetry: Record<string, Telemetry>
  history: Record<string, HistoryPoint[]>
  /** robotId|metric → recent readings ring */
  readings: Record<string, Reading[]>
  events: DetectionEvent[]
  toast?: DetectionEvent
  clock: number
  setLifecycle: (id: string, to: EventLifecycle) => void
  ack: (id: string) => void
  dismissToast: () => void
}

const EMPTY_HISTORY: HistoryPoint[] = []
const EMPTY_READINGS: Reading[] = []

/** stable-reference history selector (avoids getSnapshot loops) */
export function useHistory(id?: string) {
  return useApp((s) => (id ? (s.history[id] ?? EMPTY_HISTORY) : EMPTY_HISTORY))
}

/** stable-reference readings selector for one robot+metric series */
export function useReadings(robotId?: string, metric?: string) {
  return useApp((s) => (robotId && metric ? (s.readings[`${robotId}|${metric}`] ?? EMPTY_READINGS) : EMPTY_READINGS))
}

const LIFECYCLE_PATH: Record<Exclude<EventLifecycle, 'new'>, string> = {
  acked: 'ack',
  resolved: 'resolve',
  dismissed: 'dismiss',
}

export const useApp = create<AppState>((set) => ({
  connected: false,
  sites: [],
  robots: [],
  cameras: [],
  waypoints: [],
  zones: [],
  buildings: [],
  missions: [],
  templates: [],
  schedules: [],
  rules: [],
  eventTypes: [],
  channels: [],
  maps: [],
  transforms: [],
  metricDefs: [],
  telemetry: {},
  history: {},
  readings: {},
  events: [],
  clock: Date.now(),
  setLifecycle: async (id: string, to: EventLifecycle) => {
    if (to === 'new') return
    set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, lifecycle: to, acked: true } : e)) }))
    try {
      await sfetch(`/events/${id}/${LIFECYCLE_PATH[to]}`, { method: 'POST' })
    } catch {
      /* optimistic */
    }
  },
  ack: (id: string) => useApp.getState().setLifecycle(id, 'acked'),
  dismissToast: () => set({ toast: undefined }),
}))

export const api = {
  createMission: (body: unknown) =>
    sfetch('/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  abortMission: (id: string) => sfetch(`/missions/${id}/abort`, { method: 'POST' }),
  goto: (robotId: string, x: number, z: number) =>
    sfetch(`/robots/${robotId}/goto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, z }),
    }),
  createRule: (body: unknown) =>
    sfetch('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  patchRule: (id: string, body: unknown) =>
    sfetch(`/rules/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteRule: (id: string) => sfetch(`/rules/${id}`, { method: 'DELETE' }),
  getCatalog: () => sfetch('/catalog').then((r) => r.json()),
  registerRobot: (body: unknown) =>
    sfetch('/robots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  installPayload: (robotId: string, payloadId: string) =>
    sfetch(`/robots/${robotId}/payloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payloadId }),
    }).then((r) => r.json()),
  removePayload: (robotId: string, payloadId: string) =>
    sfetch(`/robots/${robotId}/payloads/${payloadId}`, { method: 'DELETE' }),
  listSites: () => apiFetch('/api/sites').then((r) => r.json() as Promise<{ sites: SiteSummary[] }>),
  // integrations admin panel
  integrations: () => sfetch('/integrations').then((r) => r.json()),
  createApiKey: (label: string) =>
    sfetch('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }).then((r) => r.json()),
  deleteApiKey: (id: string) => sfetch(`/api-keys/${id}`, { method: 'DELETE' }),
  createEventType: (body: unknown) =>
    sfetch('/event-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteEventType: (id: string) => sfetch(`/event-types/${id}`, { method: 'DELETE' }),
  removeExternal: (id: string) => sfetch(`/external-robots/${id}`, { method: 'DELETE' }),
  // channels + stream sessions (playback is a lease)
  openSession: (channelId: string) =>
    sfetch(`/channels/${encodeURIComponent(channelId)}/sessions`, { method: 'POST' }).then(
      (r) => r.json() as Promise<{ session: StreamSession }>,
    ),
  // readings
  readings: (robotId: string, metric?: string) =>
    sfetch(`/robots/${robotId}/readings${metric ? `?metric=${encodeURIComponent(metric)}` : ''}`).then((r) => r.json()),
  // templates + schedules
  createTemplate: (body: unknown) =>
    sfetch('/mission-templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteTemplate: (id: string) => sfetch(`/mission-templates/${id}`, { method: 'DELETE' }),
  createSchedule: (body: unknown) =>
    sfetch('/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  patchSchedule: (id: string, body: unknown) =>
    sfetch(`/schedules/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteSchedule: (id: string) => sfetch(`/schedules/${id}`, { method: 'DELETE' }),
  pauseMission: (id: string) => sfetch(`/missions/${id}/pause`, { method: 'POST' }),
  resumeMission: (id: string) => sfetch(`/missions/${id}/resume`, { method: 'POST' }),
  // commands (semantic, server-validated)
  command: (robotId: string, command: Command) =>
    sfetch(`/robots/${robotId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    }).then((r) => r.json()),
  exportEvents: (lifecycle = 'dismissed') => sfetch(`/events/export?lifecycle=${lifecycle}`),
}

// ---------- websocket lifecycle (per-site rooms) ----------

let ws: WebSocket | null = null
let retry = 0
let started = false
let generation = 0

export function startRealtime() {
  if (started) return
  started = true
  useAuth.getState().refresh()
  api
    .listSites()
    .then(({ sites }) => {
      useApp.setState({ sites })
      // heal a stale persisted site id
      if (!sites.some((s) => s.id === useSite.getState().siteId) && sites[0])
        useSite.getState().setSite(sites[0].id)
    })
    .catch(() => {})
  connect()
  setInterval(() => useApp.setState({ clock: Date.now() }), 1000)
  useSite.subscribe((state, prev) => {
    if (state.siteId === prev.siteId) return
    // site switch: drop the old room's state, reconnect into the new one
    generation++
    retry = 0
    useApp.setState({
      connected: false,
      site: undefined,
      robots: [],
      cameras: [],
      waypoints: [],
      zones: [],
      buildings: [],
      missions: [],
      templates: [],
      schedules: [],
      rules: [],
      eventTypes: [],
      channels: [],
      maps: [],
      transforms: [],
      metricDefs: [],
      telemetry: {},
      history: {},
      readings: {},
      events: [],
      toast: undefined,
    })
    ws?.close()
    connect()
  })
}

function connect() {
  const myGen = generation
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}${BASE}/ws?site=${encodeURIComponent(useSite.getState().siteId)}`)

  ws.onopen = () => {
    retry = 0
    useApp.setState({ connected: true })
  }

  ws.onmessage = (m) => {
    let msg: any
    try {
      msg = JSON.parse(m.data)
    } catch {
      return
    }
    if (msg.t === 'hello') {
      useApp.setState({
        site: msg.site,
        robots: msg.robots,
        cameras: msg.cameras,
        waypoints: msg.waypoints ?? [],
        zones: msg.zones ?? [],
        buildings: msg.buildings ?? [],
        missions: msg.missions ?? [],
        templates: msg.templates ?? [],
        schedules: msg.schedules ?? [],
        rules: msg.rules ?? [],
        eventTypes: msg.eventTypes ?? [],
        channels: msg.channels ?? [],
        maps: msg.maps?.maps ?? [],
        transforms: msg.maps?.transforms ?? [],
        metricDefs: msg.metricDefs ?? [],
        events: msg.events ?? [],
      })
    } else if (msg.t === 'tel') {
      const tel: Record<string, Telemetry> = { ...useApp.getState().telemetry }
      const hist = { ...useApp.getState().history }
      for (const t of msg.data as Telemetry[]) {
        tel[t.id] = t
        const h = hist[t.id] ? [...hist[t.id]] : []
        h.push({ t: msg.ts, speed: t.speed, rssi: t.rssi, battery: t.battery, latency: t.latency })
        if (h.length > 150) h.shift()
        hist[t.id] = h
      }
      useApp.setState({ telemetry: tel, history: hist })
    } else if (msg.t === 'event') {
      const ev = msg.event as DetectionEvent
      useApp.setState((s) => ({
        events: [ev, ...s.events].slice(0, 400),
        toast: ev.severity === 'critical' || ev.severity === 'high' ? ev : s.toast,
      }))
    } else if (msg.t === 'ack') {
      useApp.setState((s) => ({
        events: s.events.map((e) => (e.id === msg.id ? { ...e, acked: true, lifecycle: 'acked' } : e)),
      }))
    } else if (msg.t === 'lifecycle') {
      useApp.setState((s) => ({
        events: s.events.map((e) => (e.id === msg.id ? { ...e, lifecycle: msg.lifecycle, acked: true } : e)),
      }))
    } else if (msg.t === 'readings') {
      const readings = { ...useApp.getState().readings }
      for (const r of msg.items as Reading[]) {
        const key = `${r.robotId}|${r.metric}`
        const buf = readings[key] ? [...readings[key], r] : [r]
        if (buf.length > 150) buf.shift()
        readings[key] = buf
      }
      useApp.setState({ readings })
    } else if (msg.t === 'fleet') {
      useApp.setState({ robots: msg.robots })
    } else if (msg.t === 'missions' || msg.t === 'missionResult') {
      useApp.setState((s) => ({ missions: msg.missions, schedules: msg.schedules ?? s.schedules }))
    } else if (msg.t === 'templates') {
      useApp.setState({ templates: msg.templates })
    } else if (msg.t === 'schedules') {
      useApp.setState({ schedules: msg.schedules })
    } else if (msg.t === 'rules') {
      useApp.setState({ rules: msg.rules })
    } else if (msg.t === 'eventTypes') {
      useApp.setState({ eventTypes: msg.eventTypes })
    } else if (msg.t === 'site') {
      useApp.setState({ site: msg.site })
    }
  }

  ws.onclose = () => {
    if (myGen !== generation) return // superseded by a site switch
    useApp.setState({ connected: false })
    const delay = Math.min(8000, 500 * 2 ** retry++)
    setTimeout(() => {
      if (myGen === generation) connect()
    }, delay)
  }
  ws.onerror = () => ws?.close()
}
