import { useEffect, useRef } from 'react'
import { BASE } from '../lib/base'
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
    el.src = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/stream/api/ws?src=${encodeURIComponent(src)}`
    if (el.video) {
      el.video.controls = false
      el.video.muted = muted
      el.video.autoplay = true
    }
  }, [src, muted])

  // @ts-expect-error custom element
  return <video-stream ref={ref} class={className} style={{ display: 'block', width: '100%', height: '100%' }} />
}

/** Native looped playback for local demo footage — no transcode hop, no dropped frames. */
export function LoopPlayer({ src, className = '' }: { src: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    // some mobile policies ignore the autoPlay attribute even when muted —
    // kick playback on data, again shortly after, and on first gesture
    const kick = () => {
      if (v.paused) v.play().catch(() => {})
    }
    kick()
    const t = setTimeout(kick, 600)
    v.addEventListener('loadeddata', kick)
    document.addEventListener('pointerdown', kick, { once: true })
    return () => {
      clearTimeout(t)
      v.removeEventListener('loadeddata', kick)
      document.removeEventListener('pointerdown', kick)
    }
  }, [src])
  return (
    <video
      ref={ref}
      src={src}
      loop
      muted
      autoPlay
      playsInline
      preload="auto"
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', background: '#060708' }}
    />
  )
}

/** Picks the right transport: local file → native loop; live stream → go2rtc MSE. */
export function FeedPlayer({ stream, file, muted = true }: { stream: string; file?: string; muted?: boolean }) {
  if (file) return <LoopPlayer src={file} />
  return <StreamPlayer src={stream} muted={muted} />
}

/** first-frame preview from a local loop file — no live snapshot service */
export function VideoThumb({ file, className = '' }: { file?: string; className?: string }) {
  if (!file) return <div className={`skeleton ${className}`} />
  return <video src={`${file}#t=0.6`} preload="metadata" muted playsInline className={className} />
}
