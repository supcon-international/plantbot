import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { useApp, api } from '../lib/store'
import { useT } from '../lib/i18n'
import type { Telemetry, Waypoint } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

export type MapSel =
  | { kind: 'robot'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'waypoint'; id: string }
  | null

const FULL = { x: -16, z: -9, w: 32, h: 18 }
const MIN_W = FULL.w / 7 // max zoom-in
const MAX_W = FULL.w * 1.05

/** Occupancy PNG → theme-mapped dataURL (occupied=white laser, free=lifted floor). */
function useOccupancyUrl(image?: string) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!image) return
    const img = new Image()
    img.src = image
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height)
      const px = d.data
      for (let i = 0; i < px.length; i += 4) {
        const v = px[i]
        if (v < 80) {
          px[i] = 226; px[i + 1] = 231; px[i + 2] = 236; px[i + 3] = 240
        } else if (v > 235) {
          px[i] = 23; px[i + 1] = 26; px[i + 2] = 31; px[i + 3] = 255
        } else if (v >= 180 && v <= 225) {
          px[i + 3] = 0
        } else {
          px[i] = 92; px[i + 1] = 99; px[i + 2] = 107; px[i + 3] = 150
        }
      }
      ctx.putImageData(d, 0, 0)
      setUrl(c.toDataURL('image/png'))
    }
  }, [image])
  return url
}

/** breadcrumb trails collected client-side from telemetry */
function useTrails(telemetry: Record<string, Telemetry>) {
  const trails = useRef(new Map<string, { x: number; z: number }[]>())
  const [, bump] = useState(0)
  useEffect(() => {
    let changed = false
    for (const [id, tel] of Object.entries(telemetry)) {
      const arr = trails.current.get(id) ?? []
      const last = arr[arr.length - 1]
      if (!last || Math.hypot(tel.x - last.x, tel.z - last.z) > 0.18) {
        arr.push({ x: tel.x, z: tel.z })
        if (arr.length > 42) arr.shift()
        trails.current.set(id, arr)
        changed = true
      }
    }
    if (changed) bump((n) => n + 1)
  }, [telemetry])
  return trails.current
}

function WaypointGlyph({
  wp,
  k,
  state,
  order,
  onClick,
}: {
  wp: Waypoint
  k: number
  state: 'normal' | 'selected' | 'routed'
  order?: number
  onClick?: () => void
}) {
  const hot = state !== 'normal'
  const tone = hot ? '#f2f4f6' : wp.kind === 'dock' ? 'var(--color-ok)' : '#98a1ab'
  return (
    <g
      transform={`translate(${wp.x} ${wp.z})`}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      className="wp-glyph"
    >
      <g transform={`scale(${k})`}>
        {/* generous invisible hit area */}
        <circle r={0.62} fill="transparent" />
        <g className="wp-core" style={{ transition: 'transform 120ms ease' }}>
          <rect x={-0.3} y={-0.3} width={0.6} height={0.6} transform="rotate(45)" fill="#0c0d0f" fillOpacity={0.72} stroke={tone} strokeWidth={hot ? 0.09 : 0.06} />
          {wp.kind === 'inspect' && <circle r={0.13} fill="none" stroke={tone} strokeWidth={0.045} />}
          <circle r={0.05} fill={tone} />
        </g>
        <text y={-0.62} textAnchor="middle" fill={hot ? '#f2f4f6' : '#7b8590'} fontSize={0.4} fontFamily="var(--font-mono)" letterSpacing="0.04" style={{ userSelect: 'none' }}>
          {wp.id.replace('WP-', 'W')}
        </text>
        {/* name on hover */}
        <text y={0.98} textAnchor="middle" className="wp-name" fill="#c7ced6" fontSize={0.34} fontFamily="var(--font-mono)" style={{ opacity: 0, transition: 'opacity 120ms ease', userSelect: 'none', pointerEvents: 'none' }}>
          {wp.name}
        </text>
        {order != null && (
          <g transform="translate(0.55 -0.55)">
            <circle r={0.26} fill="#f2f4f6" />
            <text y={0.11} textAnchor="middle" fill="#0c0d0f" fontSize={0.32} fontWeight={700} fontFamily="var(--font-mono)" style={{ userSelect: 'none' }}>
              {order}
            </text>
          </g>
        )}
      </g>
    </g>
  )
}

function RobotMarker({
  tel,
  color,
  family,
  callsign,
  k,
  selected,
  onClick,
}: {
  tel: Telemetry
  color: string
  family: string
  callsign: string
  k: number
  selected: boolean
  onClick?: () => void
}) {
  const deg = (-tel.heading * 180) / Math.PI
  const tone = selected ? '#f2f4f6' : color
  const moving = tel.speed > 0.05
  return (
    <g transform={`translate(${tel.x} ${tel.z})`} style={{ transition: 'transform 260ms linear' }}>
      {/* FOV wedge — spatial layer, points along heading */}
      <g transform={`rotate(${deg})`}>
        <path d="M 0 0 L 2.3 -1.15 A 2.55 2.55 0 0 1 2.3 1.15 Z" fill="url(#fovGrad)" opacity={selected ? 0.5 : 0.3} />
      </g>
      {/* screen-constant body */}
      <g
        transform={`scale(${k})`}
        onClick={(e) => {
          e.stopPropagation()
          onClick?.()
        }}
        style={{ cursor: onClick ? 'pointer' : 'default' }}
      >
        <circle r={0.7} fill="transparent" />
        {/* breathing ring */}
        <circle r={0.34} fill="none" stroke={tone} strokeWidth={0.05} opacity={0.5}>
          {moving && <animate attributeName="r" values="0.34;0.52;0.34" dur="2.6s" repeatCount="indefinite" />}
          {moving && <animate attributeName="opacity" values="0.5;0;0.5" dur="2.6s" repeatCount="indefinite" />}
        </circle>
        {family === 'ugv' ? (
          <rect x={-0.24} y={-0.24} width={0.48} height={0.48} rx={0.08} transform={`rotate(${deg})`} fill="#0c0d0f" stroke={tone} strokeWidth={selected ? 0.09 : 0.07} />
        ) : (
          <circle r={0.26} fill="#0c0d0f" stroke={tone} strokeWidth={selected ? 0.09 : 0.07} />
        )}
        {/* heading tick */}
        <g transform={`rotate(${deg})`}>
          <path d="M 0.4 0 L 0.16 -0.13 L 0.16 0.13 Z" fill={tone} />
        </g>
        <circle r={0.07} fill={tone} />
        {/* callsign chip */}
        <g transform="translate(0 -0.72)">
          <rect x={-callsign.length * 0.115 - 0.12} y={-0.26} width={callsign.length * 0.23 + 0.24} height={0.5} rx={0.06} fill="#0c0d0f" fillOpacity={0.85} stroke={selected ? 'rgba(242,244,246,0.55)' : 'var(--color-line-2)'} strokeWidth={0.03} />
          <text y={0.12} textAnchor="middle" fill={selected ? '#f2f4f6' : '#c7ced6'} fontSize={0.36} fontFamily="var(--font-mono)" letterSpacing="0.05" style={{ userSelect: 'none' }}>
            {callsign}
          </text>
        </g>
      </g>
    </g>
  )
}

export function OpsMap({
  selection,
  onSelect,
  heightClass = 'h-[420px]',
  interactive = true,
  showEvents = true,
  labels = true,
  className = '',
  onWaypointClick,
  routePreview,
}: {
  selection?: MapSel
  onSelect?: (s: MapSel) => void
  heightClass?: string
  interactive?: boolean
  showEvents?: boolean
  labels?: boolean
  className?: string
  onWaypointClick?: (wp: Waypoint) => void
  routePreview?: string[]
}) {
  const site = useApp((s) => s.site)
  const robots = useApp((s) => s.robots)
  const telemetry = useApp((s) => s.telemetry)
  const waypoints = useApp((s) => s.waypoints)
  const zones = useApp((s) => s.zones)
  const events = useApp((s) => s.events)
  const t = useT()
  const [gotoMenu, setGotoMenu] = useState<Waypoint | null>(null)
  const occUrl = useOccupancyUrl(site?.map.image)
  const trails = useTrails(telemetry)

  // ---------- pan / zoom ----------
  const [vb, setVb] = useState(FULL)
  const svgRef = useRef<SVGSVGElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ d: number; vb: typeof FULL } | null>(null)
  const dragMoved = useRef(0)
  const suppressClick = useRef(false)

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const el = svgRef.current!
      const r = el.getBoundingClientRect()
      // preserveAspectRatio meet: uniform scale, centered
      const scale = Math.min(r.width / vb.w, r.height / vb.h)
      const ox = (r.width - vb.w * scale) / 2
      const oy = (r.height - vb.h * scale) / 2
      return { x: vb.x + (clientX - r.left - ox) / scale, z: vb.z + (clientY - r.top - oy) / scale, scale }
    },
    [vb],
  )

  const clampVb = (n: typeof FULL) => {
    const w = Math.min(MAX_W, Math.max(MIN_W, n.w))
    const h = (w * FULL.h) / FULL.w
    const x = Math.min(FULL.x + FULL.w - w * 0.25, Math.max(FULL.x - w * 0.75, n.x))
    const z = Math.min(FULL.z + FULL.h - h * 0.25, Math.max(FULL.z - h * 0.75, n.z))
    return { x, z, w, h }
  }

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const p = toWorld(clientX, clientY)
      setVb((v) => {
        const w = Math.min(MAX_W, Math.max(MIN_W, v.w * factor))
        const kx = (p.x - v.x) / v.w
        const kz = (p.z - v.z) / v.h
        const h = (w * FULL.h) / FULL.w
        return clampVb({ x: p.x - kx * w, z: p.z - kz * h, w, h })
      })
    },
    [toWorld],
  )

  useEffect(() => {
    const el = svgRef.current
    if (!el || !interactive) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.18 : 1 / 1.18)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // `site` gates the svg's existence — re-run once it mounts
  }, [zoomAt, interactive, site])

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    dragMoved.current = 0
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchStart.current = { d: Math.hypot(a.x - b.x, a.y - b.y), vb }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!interactive || !pointers.current.has(e.pointerId)) return
    const prev = pointers.current.get(e.pointerId)!
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d > 0) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const factor = pinchStart.current.d / d
        const w = Math.min(MAX_W, Math.max(MIN_W, pinchStart.current.vb.w * factor))
        const p = toWorld(mid.x, mid.y)
        const kx = (p.x - vb.x) / vb.w
        const kz = (p.z - vb.z) / vb.h
        const h = (w * FULL.h) / FULL.w
        setVb(clampVb({ x: p.x - kx * w, z: p.z - kz * h, w, h }))
      }
      return
    }

    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    dragMoved.current += Math.abs(dx) + Math.abs(dy)
    if (dragMoved.current > 4) {
      suppressClick.current = true
      const el = svgRef.current!
      const r = el.getBoundingClientRect()
      const scale = Math.min(r.width / vb.w, r.height / vb.h)
      setVb((v) => clampVb({ ...v, x: v.x - dx / scale, z: v.z - dy / scale }))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null
    setTimeout(() => (suppressClick.current = false), 0)
  }

  const pins = useMemo(
    () => (showEvents ? events.filter((e) => !e.acked && Date.now() - e.ts < 45 * 60_000).slice(0, 10) : []),
    [events, showEvents],
  )

  if (!site) return <div className={`skeleton ${heightClass} ${className}`} />

  const k = vb.w / FULL.w // screen-constant scale factor
  const zoomed = vb.w < FULL.w * 0.98

  const zoneTone = (kind: string) =>
    kind === 'restricted' ? 'var(--color-crit)' : kind === 'charging' ? 'var(--color-ok)' : '#aab3bd'

  return (
    <div className={`relative touch-none overflow-hidden bg-surface ${heightClass} ${className}`}>
      <style>{`
        .wp-glyph:hover .wp-core { transform: scale(1.3); }
        .wp-glyph:hover .wp-name { opacity: 1 !important; }
      `}</style>
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.z} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full"
        style={{ cursor: interactive ? 'grab' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.stopPropagation()
          }
        }}
        onClick={() => {
          onSelect?.(null)
          setGotoMenu(null)
        }}
        onDoubleClick={() => setVb(FULL)}
      >
        <defs>
          <radialGradient id="fovGrad" cx="0" cy="0.5" r="1">
            <stop offset="0%" stopColor="#e6e8ea" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#e6e8ea" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* occupancy base */}
        {occUrl && (
          <image
            href={occUrl}
            x={FULL.x}
            y={FULL.z}
            width={FULL.w}
            height={FULL.h}
            preserveAspectRatio="none"
            style={{ imageRendering: 'pixelated' }}
          />
        )}

        {/* zones */}
        {zones.map((z) => {
          const pts = z.polygon.map((p) => p.join(',')).join(' ')
          const tone = zoneTone(z.kind)
          const cx = z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length
          const topZ = Math.min(...z.polygon.map((p) => p[1]))
          return (
            <g key={z.id}>
              <polygon points={pts} fill={tone} opacity={0.05} />
              <polygon points={pts} fill="none" stroke={tone} strokeWidth={0.05 * k} strokeDasharray={`${0.5 * k} ${0.3 * k}`} opacity={0.55} />
              {labels && (
                <g transform={`translate(${cx} ${topZ}) scale(${k})`}>
                  <text y={0.62} textAnchor="middle" fill={tone} opacity={0.85} fontSize={0.38} fontFamily="var(--font-mono)" letterSpacing="0.08" style={{ userSelect: 'none' }}>
                    {z.name.toUpperCase()}
                  </text>
                </g>
              )}
            </g>
          )
        })}

        {/* breadcrumb trails */}
        {robots.map((r) => {
          const tr = trails.get(r.id)
          if (!tr || tr.length < 2) return null
          return (
            <polyline
              key={`tr-${r.id}`}
              points={tr.map((p) => `${p.x},${p.z}`).join(' ')}
              fill="none"
              stroke={r.color}
              strokeWidth={0.06}
              strokeLinecap="round"
              opacity={0.24}
            />
          )
        })}

        {/* mission route preview */}
        {routePreview && routePreview.length > 1 && (
          <polyline
            points={routePreview
              .map((id) => waypoints.find((w) => w.id === id))
              .filter(Boolean)
              .map((w) => `${w!.x},${w!.z}`)
              .join(' ')}
            fill="none"
            stroke="#f2f4f6"
            strokeWidth={0.06 * k + 0.02}
            strokeDasharray={`${0.4} ${0.28}`}
            opacity={0.8}
          />
        )}

        {/* waypoints */}
        {waypoints.map((wp) => {
          const orderIdx = routePreview ? routePreview.indexOf(wp.id) : -1
          const state = orderIdx >= 0 ? 'routed' : selection?.kind === 'waypoint' && selection.id === wp.id ? 'selected' : 'normal'
          return (
            <WaypointGlyph
              key={wp.id}
              wp={wp}
              k={k}
              state={state}
              order={orderIdx >= 0 ? orderIdx + 1 : undefined}
              onClick={
                onWaypointClick
                  ? () => onWaypointClick(wp)
                  : interactive
                    ? () => {
                        onSelect?.({ kind: 'waypoint', id: wp.id })
                        setGotoMenu(wp)
                      }
                    : undefined
              }
            />
          )
        })}

        {/* event pins */}
        {pins.map((e) => (
          <g
            key={e.id}
            transform={`translate(${e.x} ${e.z})`}
            onClick={(ev) => {
              ev.stopPropagation()
              interactive && onSelect?.({ kind: 'event', id: e.id })
            }}
            style={{ cursor: interactive ? 'pointer' : 'default' }}
          >
            <g transform={`scale(${k})`}>
              <circle r={0.4} fill="transparent" />
              <circle r={0.26} fill="none" stroke={SEVERITY_COLOR[e.severity]} strokeWidth={0.055} opacity={0.95}>
                {e.severity === 'critical' && <animate attributeName="r" values="0.2;0.36;0.2" dur="1.6s" repeatCount="indefinite" />}
              </circle>
              <circle r={0.08} fill={SEVERITY_COLOR[e.severity]} />
            </g>
          </g>
        ))}

        {/* planned paths + robots */}
        {robots.map((r) => {
          const tel = telemetry[r.id]
          if (!tel) return null
          const sel = selection?.kind === 'robot' && selection.id === r.id
          return (
            <g key={r.id}>
              {tel.path.length > 0 && (
                <>
                  <polyline
                    points={[`${tel.x},${tel.z}`, ...tel.path.map((p) => `${p.x},${p.z}`)].join(' ')}
                    fill="none"
                    stroke={sel ? '#f2f4f6' : r.color}
                    strokeWidth={sel ? 0.09 : 0.06}
                    strokeDasharray="0.32 0.22"
                    className="path-march"
                    opacity={sel ? 0.95 : 0.6}
                  />
                  {/* destination flag */}
                  {(() => {
                    const dst = tel.path[tel.path.length - 1]
                    return (
                      <g transform={`translate(${dst.x} ${dst.z}) scale(${k})`}>
                        <circle r={0.3} fill="none" stroke={sel ? '#f2f4f6' : r.color} strokeWidth={0.05} opacity={0.8}>
                          <animate attributeName="r" values="0.22;0.4;0.22" dur="2.2s" repeatCount="indefinite" />
                        </circle>
                        <circle r={0.06} fill={sel ? '#f2f4f6' : r.color} />
                      </g>
                    )
                  })()}
                </>
              )}
              <RobotMarker
                tel={tel}
                color={r.color}
                family={r.family}
                callsign={r.callsign}
                k={k}
                selected={!!sel}
                onClick={interactive ? () => onSelect?.({ kind: 'robot', id: r.id }) : undefined}
              />
            </g>
          )
        })}
      </svg>

      {/* zoom controls */}
      {interactive && (
        <div className="absolute bottom-3 right-3 z-10 flex flex-col overflow-hidden border border-line bg-bg/75 backdrop-blur">
          <button
            onClick={() => {
              const el = svgRef.current!.getBoundingClientRect()
              zoomAt(el.left + el.width / 2, el.top + el.height / 2, 1 / 1.35)
            }}
            className="flex h-8 w-8 items-center justify-center text-ink-3 transition-colors hover:text-ink"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => {
              const el = svgRef.current!.getBoundingClientRect()
              zoomAt(el.left + el.width / 2, el.top + el.height / 2, 1.35)
            }}
            className="flex h-8 w-8 items-center justify-center border-t border-line text-ink-3 transition-colors hover:text-ink"
          >
            <Minus size={14} />
          </button>
          {zoomed && (
            <button onClick={() => setVb(FULL)} className="flex h-8 w-8 items-center justify-center border-t border-line text-ink-3 transition-colors hover:text-ink">
              <Maximize2 size={12} />
            </button>
          )}
        </div>
      )}

      {/* waypoint teleop menu */}
      {gotoMenu && interactive && !onWaypointClick && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <div className="panel flex items-center gap-2 px-3 py-2">
            <span className="mono text-[11px] text-ink">{gotoMenu.id}</span>
            <span className="hidden text-[11px] text-ink-3 sm:block">{gotoMenu.name}</span>
            <span className="mx-1 h-4 w-px bg-line-2" />
            <span className="microlabel">{t('c.send')}</span>
            {robots.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  api.goto(r.id, gotoMenu.x, gotoMenu.z)
                  setGotoMenu(null)
                  onSelect?.({ kind: 'robot', id: r.id })
                }}
                className="mono border border-line-2 px-1.5 py-1 text-[10px] tracking-[0.06em] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
              >
                {r.callsign}
              </button>
            ))}
            <button onClick={() => setGotoMenu(null)} className="ml-1 text-ink-3 hover:text-ink">
              ×
            </button>
          </div>
        </div>
      )}

      {/* map provenance */}
      {labels && (
        <div className="pointer-events-none absolute bottom-1.5 left-2">
          <span className="mono text-[9px] text-ink-3/80">occupancy 5 cm/px · {site.map.source}</span>
        </div>
      )}
    </div>
  )
}
