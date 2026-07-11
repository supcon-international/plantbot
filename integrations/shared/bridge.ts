// Northbound boilerplate shared by every adapter — the pieces that carry ZERO
// vendor-protocol semantics, only Plantbot integration-API etiquette. The
// southbound side (session dances, wire framing, .action RPC) and each
// adapter's `switch (order.kind)` capability matrix stay in the vendor files:
// that switch IS the honest capability surface, don't abstract it away.

import type { PlantbotClient, PlantbotOrder, SiteFactsheet } from './plantbot.js'

/** poll /site until the platform is up — adapters must outlive platform restarts */
export async function waitForSite(pb: PlantbotClient, retryMs = 3000): Promise<SiteFactsheet> {
  for (;;) {
    const s = await pb.site()
    if (s) return s
    await new Promise((r) => setTimeout(r, retryMs))
  }
}

/** adapter stream table → factsheet streams (demo loops served from STREAM_BASE) */
export function streamsToFactsheet(
  streams: readonly { id: string; name: string; kind: string; file: string }[],
  base: string,
): { id: string; name: string; kind?: string; url?: string }[] {
  return streams.map((s) => ({ id: s.id, name: s.name, kind: s.kind, url: `${base}/${s.file}` }))
}

/** vendor-side robot fault → platform 'fault' event (the robot-health stream) */
export function reportFault(pb: PlantbotClient, serial: string, detail: string): void {
  void pb.event({ type: 'fault', robotSerial: serial, detail, severity: 'high', category: 'robot-fault' })
}

/** after a state report: pull pending orders and hand each to the executor */
export async function pumpOrders(
  pb: PlantbotClient,
  serial: string,
  rep: { ordersPending: number } | null,
  exec: (order: PlantbotOrder) => void | Promise<void>,
): Promise<void> {
  if (!rep || rep.ordersPending <= 0) return
  for (const order of await pb.pullOrders(serial)) void exec(order)
}

// ---------- waypoint mission runner ----------
// Shared by vendors whose protocol has no native multi-point mission (Spot,
// GoRobot): navigate point-by-point, honor pause/abort, dwell per the step's
// action durations, settle the order. DeepRobotics does NOT use this — its
// Type 1003 is natively a multi-point task, one order maps to one 1003.

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

// ---------- per-site profile selection ----------
// spot/deeprobotics run the SAME code as two instances (one per site);
// the profile picks identity + channels + platform key (+ dock for vendors
// whose charge pile is integrator-calibrated config).

export interface VendorProfile {
  serial: string
  callsign: string
  key: string
  dock?: { x: number; z: number }
  streams: readonly { id: string; name: string; kind: string; file: string }[]
}

export function pickProfile<T extends Record<string, VendorProfile>>(
  table: T,
  envValue: string | undefined,
  fallback: keyof T,
): VendorProfile {
  return table[(envValue as keyof T) ?? fallback] ?? table[fallback]
}
