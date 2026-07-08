import { useEffect, useRef } from 'react'
// vendored plain-JS module from go2rtc (MIT)
import { VideoRTC } from './video-rtc.js'

// register the custom element once
if (!customElements.get('video-stream')) {
  class VideoStream extends VideoRTC {}
  customElements.define('video-stream', VideoStream)
}

/**
 * Live low-latency player backed by go2rtc (RTSP → fMP4 over WebSocket MSE,
 * with WebRTC/MJPEG fallbacks handled by the vendored element).
 */
export function StreamPlayer({
  src,
  muted = true,
  className = '',
}: {
  src: string
  muted?: boolean
  className?: string
}) {
  const ref = useRef<HTMLElement & { src: string; mode: string }>(null)

  useEffect(() => {
    const el = ref.current as any
    if (!el) return
    // MSE only — WebRTC listener is disabled server-side; mode order matters.
    el.mode = 'mse'
    el.background = false
    if (el.ws || el.pc) el.ondisconnect?.() // drop previous stream before switching
    el.src = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream/api/ws?src=${encodeURIComponent(src)}`
    if (el.video) {
      el.video.controls = false
      el.video.muted = muted
      el.video.autoplay = true
    }
  }, [src, muted])

  // @ts-expect-error custom element
  return <video-stream ref={ref} class={className} style={{ display: 'block', width: '100%', height: '100%' }} />
}

export function SnapshotImg({
  src,
  refreshMs = 0,
  className = '',
  alt = '',
}: {
  src: string
  refreshMs?: number
  className?: string
  alt?: string
}) {
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => {
    if (!refreshMs) return
    const id = setInterval(() => {
      if (ref.current) ref.current.src = `${src}&t=${Date.now()}`
    }, refreshMs)
    return () => clearInterval(id)
  }, [src, refreshMs])
  return <img ref={ref} src={src} alt={alt} className={className} loading="lazy" />
}
