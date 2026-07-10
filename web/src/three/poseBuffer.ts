// Snapshot interpolation for 4 Hz telemetry (the classic netcode approach):
// render the pose as it was INTERP_DELAY_MS ago, linearly interpolated
// between the two snapshots that straddle that instant. Constant velocity
// between ticks — no stair-steps and none of the fast-slow-fast pulsing an
// exponential chaser produces when its target moves in 250 ms jumps.

export interface PoseSnap {
  t: number
  x: number
  z: number
  h: number
}

/** render this far in the past — 1.6× the 250 ms tick swallows arrival jitter */
export const INTERP_DELAY_MS = 420

export function pushSnap(buf: PoseSnap[], x: number, z: number, h: number, now: number) {
  const last = buf[buf.length - 1]
  // teleport / respawn / site switch: restart the buffer so we snap, not glide
  if (last && Math.hypot(last.x - x, last.z - z) > 5) buf.length = 0
  buf.push({ t: now, x, z, h })
  if (buf.length > 8) buf.shift()
}

const wrapPi = (a: number) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI

export function sampleSnap(buf: PoseSnap[], renderT: number): PoseSnap | null {
  if (buf.length === 0) return null
  if (renderT <= buf[0].t) return buf[0]
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].t <= renderT) {
      const a = buf[i]
      const b = buf[i + 1]
      if (!b) return a // stream stalled — hold the latest pose
      const k = (renderT - a.t) / Math.max(1, b.t - a.t)
      return { t: renderT, x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, h: a.h + wrapPi(b.h - a.h) * k }
    }
  }
  return buf[0]
}
