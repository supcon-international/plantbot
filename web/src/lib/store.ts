import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { BASE } from './base'
import { notifyEvent } from './notify'
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
  rssi: number | null
  battery: number
  latency: number | null
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
  /** PB_PUBLIC_VIEW=0 → anonymous browsing disabled, login gate covers the app */
  publicView: boolean
  /** PB_DEMO=1 → demo instance (seeded accounts hint on the login card) */
  demo: boolean
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
  publicView: true,
  demo: false,
  refresh: async () => {
    try {
      const me = (await (await apiFetch('/api/auth/me')).json()) as Me & { publicView?: boolean; demo?: boolean }
      set({ me, loaded: true, publicView: me.publicView !== false, demo: me.demo === true })
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
    // gated deployments: the site list and WS room need the fresh session
    api.listSites().then(({ sites }) => useApp.setState({ sites })).catch(() => {})
    reconnectRealtime()
    return null
  },
  logout: async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    await get().refresh()
  },
  // per-site role from auth/me, falling back to the '*' wildcard — an empty
  // platform has no sites yet, and the platform admin still needs their rank
  roleFor: (siteId) => {
    const me = get().me
    return me?.sites.find((s) => s.id === siteId)?.role ?? me?.user?.roles['*'] ?? 'viewer'
  },
  can: (min) => ROLE_RANK[get().roleFor(useSite.getState().siteId)] >= ROLE_RANK[min],
}))

/** reactive role hook for the current site (same wildcard fallback as roleFor) */
export function useRole(): Role {
  const me = useAuth((s) => s.me)
  const siteId = useSite((s) => s.siteId)
  return me?.sites.find((s) => s.id === siteId)?.role ?? me?.user?.roles['*'] ?? 'viewer'
}

export function useCan(min: Role): boolean {
  return ROLE_RANK[useRole()] >= ROLE_RANK[min]
}

// ---------- realtime app state ----------

interface AppState {
  connected: boolean
  site?: SiteInfo
  sites: SiteSummary[]
  /** true once the first /api/sites round-trip resolved (empty-state gate) */
  sitesLoaded: boolean
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
  clock: number
  setLifecycle: (id: string, to: EventLifecycle) => void
  ack: (id: string) => void
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
  sitesLoaded: false,
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
  // tolerant on purpose: gated deployments answer 401 here before sign-in —
  // an empty list keeps the shell alive instead of crashing on `{error}`
  listSites: () =>
    apiFetch('/api/sites').then(async (r) => {
      const j = (await r.json().catch(() => null)) as { sites?: SiteSummary[] } | null
      return { sites: j?.sites ?? [] }
    }),
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
  renewSession: (sid: string) =>
    sfetch(`/stream-sessions/${encodeURIComponent(sid)}/renew`, { method: 'POST' }).then(
      (r) => r.json() as Promise<{ session: StreamSession }>,
    ),
  closeSession: (sid: string) =>
    sfetch(`/stream-sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {}),
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
  // site builder (admin)
  createSite: (body: { id?: string; name: string; operator?: string }) =>
    apiFetch('/api/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  deleteSite: (siteId: string) => apiFetch(`/api/sites/${siteId}`, { method: 'DELETE' }).then((r) => r.json()),
  patchSiteMeta: (siteId: string, body: unknown) =>
    apiFetch(`/api/sites/${siteId}/meta`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  saveGeometry: (siteId: string, body: unknown) =>
    apiFetch(`/api/sites/${siteId}/geometry`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  uploadMap: (siteId: string, body: unknown) =>
    apiFetch(`/api/sites/${siteId}/map`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  fleet: (siteId: string) => apiFetch(`/api/sites/${siteId}/fleet`).then((r) => r.json()),
  // calibration transforms
  transforms: (siteId: string) => apiFetch(`/api/sites/${siteId}/transforms`).then((r) => r.json()),
  saveTransform: (siteId: string, body: unknown) =>
    apiFetch(`/api/sites/${siteId}/transforms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  deleteTransform: (siteId: string, id: string) => apiFetch(`/api/sites/${siteId}/transforms/${id}`, { method: 'DELETE' }),
  // managed connectors (admin)
  connectors: (siteId: string) => apiFetch(`/api/sites/${siteId}/connectors`).then((r) => r.json()),
  createConnector: (siteId: string, body: unknown) =>
    apiFetch(`/api/sites/${siteId}/connectors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  connectorAction: (siteId: string, id: string, action: 'start' | 'stop' | 'restart') =>
    apiFetch(`/api/sites/${siteId}/connectors/${id}/${action}`, { method: 'POST' }).then((r) => r.json()),
  deleteConnector: (siteId: string, id: string) => apiFetch(`/api/sites/${siteId}/connectors/${id}`, { method: 'DELETE' }).then((r) => r.json()),
  connectorLogs: (siteId: string, id: string) => apiFetch(`/api/sites/${siteId}/connectors/${id}/logs`).then((r) => r.json()),
  // fixed-camera CRUD (Video wall)
  addCamera: (siteId: string, body: { name: string; rtsp?: string; place?: string }) =>
    apiFetch(`/api/sites/${siteId}/cameras`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  patchCamera: (siteId: string, camId: string, body: { name?: string; rtsp?: string; place?: string }) =>
    apiFetch(`/api/sites/${siteId}/cameras/${encodeURIComponent(camId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  deleteCamera: (siteId: string, camId: string) =>
    apiFetch(`/api/sites/${siteId}/cameras/${encodeURIComponent(camId)}`, { method: 'DELETE' }).then((r) => r.json()),
  // users (platform admin)
  listUsers: () => apiFetch('/api/users').then((r) => r.json()),
  createUser: (body: unknown) =>
    apiFetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  patchUser: (username: string, body: unknown) =>
    apiFetch(`/api/users/${username}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  deleteUser: (username: string) => apiFetch(`/api/users/${username}`, { method: 'DELETE' }).then((r) => r.json()),
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
      useApp.setState({ sites, sitesLoaded: true })
      // heal a stale persisted site id
      if (!sites.some((s) => s.id === useSite.getState().siteId) && sites[0])
        useSite.getState().setSite(sites[0].id)
    })
    .catch(() => useApp.setState({ sitesLoaded: true }))
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
    })
    ws?.close()
    connect()
  })
}

/** force a fresh WS room join (after login on gated deployments, site create) */
export function reconnectRealtime() {
  generation++
  retry = 0
  ws?.close()
  connect()
}

function connect() {
  const myGen = generation
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}${BASE}/ws?site=${encodeURIComponent(useSite.getState().siteId)}`)
  const socket = ws // capture: handlers must act on THIS socket, not a later one

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
      useApp.setState((s) => ({ events: [ev, ...s.events].slice(0, 400) }))
      if (ev.severity === 'critical' || ev.severity === 'high') notifyEvent(ev)
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
    } else if (msg.t === 'missions') {
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
    } else if (msg.t === 'geo') {
      // site builder saved — geometry applies live
      useApp.setState((s) => ({
        site: msg.site ?? s.site,
        waypoints: msg.waypoints ?? s.waypoints,
        zones: msg.zones ?? s.zones,
        cameras: msg.cameras ?? s.cameras,
        channels: msg.channels ?? s.channels,
      }))
    } else if (msg.t === 'channels') {
      useApp.setState({ channels: msg.channels })
    } else if (msg.t === 'maps') {
      useApp.setState({ maps: msg.maps?.maps ?? [], transforms: msg.maps?.transforms ?? [] })
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
  socket.onerror = () => socket.close()
}
