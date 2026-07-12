// Adapter-side glue that is NOT part of the public SDK: profile tables for
// the bundled demo instances and the managed-connector identity env. The
// northbound etiquette (waitForSite/pumpOrders/runWaypointMission/reportFault)
// now lives in @plantbot/adapter-sdk and is re-exported here so the bundled
// adapters keep their import paths. Each adapter's `switch (order.kind)`
// capability matrix stays in the vendor files: that switch IS the honest
// capability surface, don't abstract it away.

export { waitForSite, pumpOrders, reportFault, runWaypointMission, type MissionRun } from '@plantbot/adapter-sdk'

/** adapter stream table → factsheet streams. Demo loops are bare filenames
 *  served from STREAM_BASE; absolute sources (rtsp://…, http://…, /path)
 *  pass through untouched — that's how a managed connector publishes the
 *  robot's native RTSP cameras. */
export function streamsToFactsheet(
  streams: readonly { id: string; name: string; kind: string; file: string }[],
  base: string,
): { id: string; name: string; kind?: string; url?: string }[] {
  const abs = /^([a-z][a-z0-9+.-]*:)?\/\//i
  return streams.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    url: abs.test(s.file) || s.file.startsWith('/') ? s.file : `${base}/${s.file}`,
  }))
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

/** vendor-map → site-world similarity transform from env — the CALIB page
 *  solves it (s, θ, t) and the connector form carries it here. Identity when
 *  unset (i.e. the robot's SLAM origin IS the site origin, the demo case).
 *  fwd: world = s·R(θ)·p + t · inv: p = R(−θ)·(world − t)/s (goto downlink) */
export function worldTransformFromEnv(): {
  fwd: (x: number, z: number) => { x: number; z: number }
  inv: (x: number, z: number) => { x: number; z: number }
} {
  const s = Number(process.env.PB_TF_SCALE ?? 1)
  const th = Number(process.env.PB_TF_THETA ?? 0)
  const tx = Number(process.env.PB_TF_TX ?? 0)
  const tz = Number(process.env.PB_TF_TZ ?? 0)
  if (!s || (s === 1 && th === 0 && tx === 0 && tz === 0))
    return { fwd: (x, z) => ({ x, z }), inv: (x, z) => ({ x, z }) }
  const c = Math.cos(th)
  const n = Math.sin(th)
  return {
    fwd: (x, z) => ({ x: s * (c * x - n * z) + tx, z: s * (n * x + c * z) + tz }),
    inv: (x, z) => {
      const dx = (x - tx) / s
      const dz = (z - tz) / s
      return { x: c * dx + n * dz, z: -n * dx + c * dz }
    },
  }
}

/** managed-connector identity: when the platform supervises this adapter it
 *  passes the robot's identity via env instead of a built-in demo profile.
 *  PB_SERIAL is the switch; PB_STREAMS is a JSON array of
 *  {id?, name, kind?, url} — rtsp:// URLs publish the robot's native cameras. */
export function customProfileFromEnv(): VendorProfile | null {
  const serial = process.env.PB_SERIAL
  if (!serial) return null
  let streams: { id: string; name: string; kind: string; file: string }[] = []
  try {
    const raw = JSON.parse(process.env.PB_STREAMS ?? '[]') as { id?: string; name?: string; kind?: string; url?: string }[]
    streams = raw
      .filter((s) => s?.name && s?.url)
      .map((s, i) => ({
        id: s.id || `cam-${i + 1}`,
        name: s.name!,
        kind: s.kind ?? 'camera',
        file: s.url!, // absolute URLs pass through streamsToFactsheet untouched
      }))
  } catch {
    console.error('[bridge] PB_STREAMS is not valid JSON — publishing no streams')
  }
  const dx = process.env.PB_DOCK_X
  const dz = process.env.PB_DOCK_Z
  return {
    serial,
    callsign: process.env.PB_CALLSIGN || serial,
    key: process.env.PLANTBOT_KEY ?? '',
    dock: dx !== undefined && dz !== undefined ? { x: Number(dx), z: Number(dz) } : undefined,
    streams,
  }
}
