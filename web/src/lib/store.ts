import { create } from 'zustand'
import type {
  Building,
  DetectionEvent,
  DetectionRule,
  Mission,
  RobotSpec,
  SiteCamera,
  SiteInfo,
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

interface AppState {
  connected: boolean
  site?: SiteInfo
  robots: RobotSpec[]
  cameras: SiteCamera[]
  waypoints: Waypoint[]
  zones: Zone[]
  buildings: Building[]
  missions: Mission[]
  rules: DetectionRule[]
  telemetry: Record<string, Telemetry>
  history: Record<string, HistoryPoint[]>
  events: DetectionEvent[]
  toast?: DetectionEvent
  clock: number
  ack: (id: string) => void
  dismissToast: () => void
}

const EMPTY_HISTORY: HistoryPoint[] = []

/** stable-reference history selector (avoids getSnapshot loops) */
export function useHistory(id?: string) {
  return useApp((s) => (id ? (s.history[id] ?? EMPTY_HISTORY) : EMPTY_HISTORY))
}

export const useApp = create<AppState>((set) => ({
  connected: false,
  robots: [],
  cameras: [],
  waypoints: [],
  zones: [],
  buildings: [],
  missions: [],
  rules: [],
  telemetry: {},
  history: {},
  events: [],
  clock: Date.now(),
  ack: async (id: string) => {
    set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, acked: true } : e)) }))
    try {
      await fetch(`/api/events/${id}/ack`, { method: 'POST' })
    } catch {
      /* optimistic */
    }
  },
  dismissToast: () => set({ toast: undefined }),
}))

export const api = {
  createMission: (body: unknown) =>
    fetch('/api/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  abortMission: (id: string) => fetch(`/api/missions/${id}/abort`, { method: 'POST' }),
  goto: (robotId: string, x: number, z: number) =>
    fetch(`/api/robots/${robotId}/goto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, z }),
    }),
  createRule: (body: unknown) =>
    fetch('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  patchRule: (id: string, body: unknown) =>
    fetch(`/api/rules/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteRule: (id: string) => fetch(`/api/rules/${id}`, { method: 'DELETE' }),
  getCatalog: () => fetch('/api/catalog').then((r) => r.json()),
  registerRobot: (body: unknown) =>
    fetch('/api/robots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  installPayload: (robotId: string, payloadId: string) =>
    fetch(`/api/robots/${robotId}/payloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payloadId }),
    }).then((r) => r.json()),
  removePayload: (robotId: string, payloadId: string) =>
    fetch(`/api/robots/${robotId}/payloads/${payloadId}`, { method: 'DELETE' }),
}

let ws: WebSocket | null = null
let retry = 0
let started = false

export function startRealtime() {
  if (started) return
  started = true
  connect()
  setInterval(() => useApp.setState({ clock: Date.now() }), 1000)
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)

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
        rules: msg.rules ?? [],
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
        events: s.events.map((e) => (e.id === msg.id ? { ...e, acked: true } : e)),
      }))
    } else if (msg.t === 'fleet') {
      useApp.setState({ robots: msg.robots })
    } else if (msg.t === 'missions' || msg.t === 'missionResult') {
      useApp.setState({ missions: msg.missions })
    } else if (msg.t === 'rules') {
      useApp.setState({ rules: msg.rules })
    }
  }

  ws.onclose = () => {
    useApp.setState({ connected: false })
    const delay = Math.min(8000, 500 * 2 ** retry++)
    setTimeout(connect, delay)
  }
  ws.onerror = () => ws?.close()
}
