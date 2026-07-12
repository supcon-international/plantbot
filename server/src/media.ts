// Media relay bridge — go2rtc handles the RTSP → MSE/WebRTC hop.
// The platform never proxies video itself: it registers named sources with
// the relay (idempotent PUT) and hands the browser a session whose url is the
// relay stream name; the web player connects to <BASE>/stream/api/ws?src=<name>
// (nginx/vite route /stream → go2rtc). No relay configured → RTSP channels
// still snapshot via ffmpeg, but live playback reports 'relay offline'.
//
// `pnpm dev` auto-starts a bundled go2rtc (scripts/relay.mjs) and points
// MEDIA_RELAY at it, so RTSP playback works out of the box. Because the env
// var can be set while the relay process is still coming up (or has died),
// relayOnline is a *probed* signal, not just "is the env var set" — a boot
// health loop keeps it truthful so the LIVE page never claims a dead relay
// is online.

const RELAY = (process.env.MEDIA_RELAY ?? '').replace(/\/$/, '')

export const relayConfigured = () => !!RELAY

// ---- health: probe go2rtc's API so relayOnline reflects reality ----
let relayHealthy = false
let probing = false

async function probeRelay(): Promise<void> {
  if (!RELAY || probing) return
  probing = true
  try {
    // /api returns go2rtc's info JSON — a cheap liveness check
    const res = await fetch(`${RELAY}/api`, { signal: AbortSignal.timeout(2500) })
    relayHealthy = res.ok
  } catch {
    relayHealthy = false
  } finally {
    probing = false
  }
}

/** true only when MEDIA_RELAY is set AND go2rtc actually answered a probe */
export const relayOnline = () => relayHealthy

/** start the background health loop (called once at boot when RELAY is set) */
export function startRelayHealth(): void {
  if (!RELAY) return
  void probeRelay()
  setInterval(() => void probeRelay(), 15_000).unref?.()
}

const registered = new Map<string, string>() // name -> src we last pushed

/** idempotently register an RTSP source under a stable name. Resolves true on a
 *  2xx from go2rtc; a failure clears the cache so the next session retries and
 *  also flips health to false (the relay is unreachable or rejected the src). */
export async function ensureRelayStream(name: string, src: string): Promise<boolean> {
  if (!RELAY) return false
  if (registered.get(name) === src) return relayHealthy
  const url = `${RELAY}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`
  try {
    const res = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`relay ${res.status}`)
    registered.set(name, src)
    relayHealthy = true
    return true
  } catch {
    registered.delete(name) // retry on next session open
    relayHealthy = false
    return false
  }
}

/** stable per-channel relay name — safe charset for go2rtc + query strings */
export function relayName(siteId: string, streamKey: string): string {
  return `${siteId}-${streamKey}`.replace(/[^A-Za-z0-9_-]+/g, '-')
}
