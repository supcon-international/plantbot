import { useEffect, useRef, useState } from 'react'
import { BASE } from '../lib/base'
import { useDataSaver, lowSrc } from '../lib/media'
// vendored plain-JS module from go2rtc (MIT)
import { VideoRTC } from './video-rtc.js'

/** data-saver-aware source with graceful fallback if the .low variant is missing */
function useVariantSrc(src: string) {
  const saver = useDataSaver((s) => s.on)
  const want = saver ? lowSrc(src) : src
  const [actual, setActual] = useState(want)
  useEffect(() => setActual(want), [want])
  const onError = () => {
    if (actual !== src) setActual(src)
  }
  return { actual, onError }
}

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
  const { actual, onError } = useVariantSrc(src)
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
  }, [actual])
  return (
    <video
      ref={ref}
      src={actual}
      onError={onError}
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
  const { actual, onError } = useVariantSrc(file ?? '')
  if (!file) return <div className={`skeleton ${className}`} />
  return <video src={`${actual}#t=0.6`} preload="metadata" muted playsInline className={className} onError={onError} />
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
