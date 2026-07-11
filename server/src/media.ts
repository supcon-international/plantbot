// Media relay bridge — go2rtc handles the RTSP → MSE/WebRTC hop.
// The platform never proxies video itself: it registers named sources with
// the relay (idempotent PUT) and hands the browser a session whose url is the
// relay stream name; the web player connects to <BASE>/stream/api/ws?src=<name>
// (nginx/vite route /stream → go2rtc). No relay configured → RTSP channels
// still snapshot via ffmpeg, but live playback reports 'relay offline'.

const RELAY = (process.env.MEDIA_RELAY ?? '').replace(/\/$/, '')

export const relayConfigured = () => !!RELAY

const registered = new Map<string, string>() // name -> src we last pushed

/** idempotently register an RTSP source under a stable name (fire-and-forget) */
export function ensureRelayStream(name: string, src: string): void {
  if (!RELAY || registered.get(name) === src) return
  registered.set(name, src)
  const url = `${RELAY}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`
  fetch(url, { method: 'PUT', signal: AbortSignal.timeout(4000) }).catch(() => {
    registered.delete(name) // retry on next session open
  })
}

/** stable per-channel relay name — safe charset for go2rtc + query strings */
export function relayName(siteId: string, streamKey: string): string {
  return `${siteId}-${streamKey}`.replace(/[^A-Za-z0-9_-]+/g, '-')
}
