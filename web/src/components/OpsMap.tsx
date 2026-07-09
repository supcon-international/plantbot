import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { useApp, api } from '../lib/store'
import { useT } from '../lib/i18n'
import type { Building, Telemetry, Waypoint } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

export type MapSel =
  | { kind: 'robot'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'waypoint'; id: string }
  | null

const FULL = { x: -16, z: -9, w: 32, h: 18 }
const MIN_W = FULL.w / 7 // max zoom-in
const MAX_W = FULL.w * 1.05

/** Occupancy PNG → laser-scan texture: only occupied cells survive, as faint white. */
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
          // laser-struck surface — quiet white overlay
          px[i] = 228; px[i + 1] = 228; px[i + 2] = 220; px[i + 3] = 120
        } else {
          px[i + 3] = 0
        }
      }
      ctx.putImageData(d, 0, 0)
      setUrl(c.toDataURL('image/png'))
    }
  }, [image])
  return url
}

// ---------- clay massing (screen-space cavalier extrusion) ----------

const EX = 0.26 // x offset per unit height (extrude up-right)
const EY = -0.5 // y offset per unit height
const SHX = 0.4 // shadow cast per unit height (down-right — light from NW)
const SHZ = 0.26

const CLAY = {
  light: { top: '#e9e9e4', west: '#c7c7c0', south: '#a5a59e' },
  mid: { top: '#bdbdb6', west: '#9e9e96', south: '#82827a' },
  edge: 'rgba(10,10,10,0.55)',
}

function ClayBox({ b }: { b: Extract<Building, { kind: 'box' }> }) {
  const { x0, z0, x1, z1, h } = b
  const c = CLAY[b.tone ?? 'light']
  const dx = h * EX
  const dy = h * EY
  return (
    <g>
      <polygon
        points={`${x0 + h * SHX},${z1 + h * SHZ} ${x1 + h * SHX},${z1 + h * SHZ} ${x1 + h * SHX},${z0 + h * SHZ} ${x0 + h * SHX},${z0 + h * SHZ}`}
        fill="#000"
        opacity={0.3}
        filter="url(#claySoft)"
      />
      {/* south face */}
      <polygon points={`${x0},${z1} ${x1},${z1} ${x1 + dx},${z1 + dy} ${x0 + dx},${z1 + dy}`} fill={c.south} />
      {/* west face */}
      <polygon points={`${x0},${z0} ${x0},${z1} ${x0 + dx},${z1 + dy} ${x0 + dx},${z0 + dy}`} fill={c.west} />
      {/* top */}
      <polygon
        points={`${x0 + dx},${z0 + dy} ${x1 + dx},${z0 + dy} ${x1 + dx},${z1 + dy} ${x0 + dx},${z1 + dy}`}
        fill={c.top}
        stroke={CLAY.edge}
        strokeWidth={0.03}
      />
      {/* ground contact line */}
      <polygon points={`${x0},${z0} ${x1},${z0} ${x1},${z1} ${x0},${z1}`} fill="none" stroke={CLAY.edge} strokeWidth={0.03} opacity={0.5} />
      {/* label rides the south band of the roof — clear of rooftop structures */}
      {b.name && (
        <RoofLabel x={(x0 + x1) / 2 + dx} y={z1 + dy - Math.min(0.55, (z1 - z0) * 0.2)} w={x1 - x0} name={b.name} />
      )}
    </g>
  )
}

/** engraved roof label — sized to fit the top face */
function RoofLabel({ x, y, w, name }: { x: number; y: number; w: number; name: string }) {
  const fs = Math.min(0.38, (w * 0.82) / (name.length * 0.78))
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fill="rgba(72,72,66,0.9)"
      fontSize={fs}
      fontFamily="var(--font-mono)"
      letterSpacing={fs * 0.18}
      style={{ userSelect: 'none' }}
    >
      {name}
    </text>
  )
}

function ClayCyl({ b }: { b: Extract<Building, { kind: 'cyl' }> }) {
  const { cx, cz, r, h } = b
  const c = CLAY[b.tone ?? 'light']
  const dx = h * EX
  const dy = h * EY
  // tangent points perpendicular to the extrusion direction
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * r
  const nz = (dx / len) * r
  const gid = `cyl-${b.id}`
  return (
    <g>
      <ellipse cx={cx + h * SHX} cy={cz + h * SHZ} rx={r * 1.05} ry={r * 0.85} fill="#000" opacity={0.3} filter="url(#claySoft)" />
      <defs>
        <linearGradient id={gid} x1={cx - nx} y1={cz - nz} x2={cx + nx} y2={cz + nz} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={c.west} />
          <stop offset="100%" stopColor={c.south} />
        </linearGradient>
      </defs>
      <path
        d={`M ${cx - nx} ${cz - nz} L ${cx + dx - nx} ${cz + dy - nz} A ${r} ${r} 0 0 0 ${cx + dx + nx} ${cz + dy + nz} L ${cx + nx} ${cz + nz} A ${r} ${r} 0 0 1 ${cx - nx} ${cz - nz} Z`}
        fill={`url(#${gid})`}
      />
      <circle cx={cx + dx} cy={cz + dy} r={r} fill={c.top} stroke={CLAY.edge} strokeWidth={0.03} />
      {/* tank lid detail */}
      <circle cx={cx + dx} cy={cz + dy} r={r * 0.55} fill="none" stroke={CLAY.edge} strokeWidth={0.025} opacity={0.5} />
      {b.name && <RoofLabel x={cx + dx} y={cz + dy} w={r * 2} name={b.name} />}
    </g>
  )
}

function ClayBuildings({ buildings }: { buildings: Building[] }) {
  // painter's order: north first so southern volumes overlap correctly;
  // `order` lifts nested structures (roof gear) above their parent volume
  const sorted = useMemo(
    () =>
      [...buildings].sort((a, b) => {
        const ao = a.order ?? 0
        const bo = b.order ?? 0
        if (ao !== bo) return ao - bo
        const az = a.kind === 'box' ? a.z1 : a.cz + a.r
        const bz = b.kind === 'box' ? b.z1 : b.cz + b.r
        return az - bz
      }),
    [buildings],
  )
  return (
    <g>
      {sorted.map((b) => (b.kind === 'box' ? <ClayBox key={b.id} b={b} /> : <ClayCyl key={b.id} b={b} />))}
    </g>
  )
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
  const tone = hot ? 'var(--color-accent)' : wp.kind === 'dock' ? 'var(--color-accent)' : '#a8a8a2'
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
          {wp.kind === 'dock' && (
            <>
              {/* charge dock — lightning bolt on a pad */}
              <circle r={0.32} fill="#0a0a0a" fillOpacity={0.8} stroke={tone} strokeWidth={hot ? 0.07 : 0.05} />
              <path d="M 0.05 -0.2 L -0.13 0.03 L -0.02 0.03 L -0.05 0.2 L 0.13 -0.03 L 0.02 -0.03 Z" fill={tone} />
            </>
          )}
          {wp.kind === 'inspect' && (
            <>
              {/* inspection point — surveyor's reticle */}
              <circle r={0.3} fill="#0a0a0a" fillOpacity={0.72} />
              <circle r={0.21} fill="none" stroke={tone} strokeWidth={hot ? 0.06 : 0.045} />
              {[0, 90, 180, 270].map((a) => (
                <line key={a} x1={0.21} y1={0} x2={0.33} y2={0} stroke={tone} strokeWidth={hot ? 0.06 : 0.045} transform={`rotate(${a})`} />
              ))}
              <circle r={0.055} fill={tone} />
            </>
          )}
          {wp.kind === 'nav' && (
            <>
              {/* route node — quiet open ring */}
              <circle r={0.15} fill="#0a0a0a" fillOpacity={0.72} stroke={tone} strokeWidth={hot ? 0.07 : 0.05} />
              {hot && <circle r={0.05} fill={tone} />}
            </>
          )}
        </g>
        <text y={-0.62} textAnchor="middle" fill={hot ? 'var(--color-accent)' : '#78786f'} fontSize={0.4} fontFamily="var(--font-mono)" letterSpacing="0.04" style={{ userSelect: 'none' }}>
          {wp.id.replace('WP-', 'W')}
        </text>
        {/* name on hover */}
        <text y={0.98} textAnchor="middle" className="wp-name" fill="#b6b6b0" fontSize={0.34} fontFamily="var(--font-mono)" style={{ opacity: 0, transition: 'opacity 120ms ease', userSelect: 'none', pointerEvents: 'none' }}>
          {wp.name}
        </text>
        {order != null && (
          <g transform="translate(0.55 -0.55)">
            <circle r={0.26} fill="var(--color-accent)" />
            <text y={0.11} textAnchor="middle" fill="#0a0a0a" fontSize={0.32} fontWeight={700} fontFamily="var(--font-mono)" style={{ userSelect: 'none' }}>
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
  const tone = selected ? 'var(--color-accent)' : color
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
        {/* nav puck — family silhouette + oriented arrow */}
        {family === 'ugv' ? (
          <rect x={-0.27} y={-0.27} width={0.54} height={0.54} rx={0.1} transform={`rotate(${deg})`} fill="#0a0a0a" stroke={tone} strokeWidth={selected ? 0.08 : 0.06} />
        ) : (
          <circle r={0.29} fill="#0a0a0a" stroke={tone} strokeWidth={selected ? 0.08 : 0.06} />
        )}
        <g transform={`rotate(${deg})`}>
          <path d="M 0.2 0 L -0.13 -0.15 L -0.06 0 L -0.13 0.15 Z" fill={tone} />
        </g>
        {/* callsign chip */}
        <g transform="translate(0 -0.72)">
          <rect x={-callsign.length * 0.115 - 0.12} y={-0.26} width={callsign.length * 0.23 + 0.24} height={0.5} rx={0.06} fill="#0a0a0a" fillOpacity={0.85} stroke={selected ? 'var(--color-accent)' : 'var(--color-line-2)'} strokeWidth={0.03} strokeOpacity={selected ? 0.6 : 1} />
          <text y={0.12} textAnchor="middle" fill={selected ? 'var(--color-accent)' : '#b6b6b0'} fontSize={0.36} fontFamily="var(--font-mono)" letterSpacing="0.05" style={{ userSelect: 'none' }}>
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
  wheelZoom = true,
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
  /** disable wheel-zoom for embedded maps so the page keeps scrolling */
  wheelZoom?: boolean
}) {
  const site = useApp((s) => s.site)
  const robots = useApp((s) => s.robots)
  const telemetry = useApp((s) => s.telemetry)
  const waypoints = useApp((s) => s.waypoints)
  const zones = useApp((s) => s.zones)
  const buildings = useApp((s) => s.buildings)
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
    if (!el || !interactive || !wheelZoom) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.18 : 1 / 1.18)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // `site` gates the svg's existence — re-run once it mounts
  }, [zoomAt, interactive, wheelZoom, site])

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
    kind === 'restricted' ? 'var(--color-crit)' : kind === 'charging' ? 'var(--color-accent)' : '#b0b0a8'

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
            <stop offset="0%" stopColor="#ebebe8" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#ebebe8" stopOpacity="0" />
          </radialGradient>
          <filter id="claySoft" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="0.22" />
          </filter>
          <radialGradient id="groundGrad" cx="0.5" cy="0.42" r="0.75">
            <stop offset="0%" stopColor="#161616" />
            <stop offset="100%" stopColor="#0f0f0f" />
          </radialGradient>
        </defs>

        {/* ---- ground plate ---- */}
        <rect x={FULL.x} y={FULL.z} width={FULL.w} height={FULL.h} fill="url(#groundGrad)" />
        {/* aprons / lanes */}
        <g fill="#e9e9e2" opacity={0.055}>
          <rect x={-13.6} y={-6.1} width={27.2} height={2.4} />
          <rect x={-13.6} y={3.6} width={27.2} height={2.3} />
          <rect x={5.9} y={-3.8} width={2.4} height={7.5} />
          <rect x={-14.9} y={-5.9} width={2.6} height={9.6} />
        </g>
        {/* survey grid */}
        <g stroke="#e9e9e2" strokeWidth={0.02} opacity={0.1}>
          {Array.from({ length: 7 }, (_, i) => FULL.x + (i + 1) * 4).map((gx) => (
            <line key={`gx${gx}`} x1={gx} y1={FULL.z} x2={gx} y2={FULL.z + FULL.h} />
          ))}
          {Array.from({ length: 4 }, (_, i) => FULL.z + (i + 1) * 4).map((gz) => (
            <line key={`gz${gz}`} x1={FULL.x} y1={gz} x2={FULL.x + FULL.w} y2={gz} />
          ))}
        </g>
        {/* site boundary */}
        <rect x={FULL.x + 0.35} y={FULL.z + 0.35} width={FULL.w - 0.7} height={FULL.h - 0.7} fill="none" stroke="#3a3a36" strokeWidth={0.05} />
        <rect x={FULL.x + 0.55} y={FULL.z + 0.55} width={FULL.w - 1.1} height={FULL.h - 1.1} fill="none" stroke="#e9e9e2" strokeWidth={0.02} opacity={0.1} strokeDasharray="0.12 0.5" />

        {/* laser-scan texture (from the live occupancy grid) */}
        {occUrl && (
          <image
            href={occUrl}
            x={FULL.x}
            y={FULL.z}
            width={FULL.w}
            height={FULL.h}
            preserveAspectRatio="none"
            opacity={0.5}
            style={{ imageRendering: 'pixelated' }}
          />
        )}

        {/* zones */}
        {zones.map((z) => {
          const pts = z.polygon.map((p) => p.join(',')).join(' ')
          const tone = zoneTone(z.kind)
          const cx = z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length
          const topZ = Math.min(...z.polygon.map((p) => p[1]))
          // anchor hint from site data; null → a roof label carries the name
          const lp = z.label === null ? null : (z.label ?? { x: cx, z: topZ + 0.62 })
          return (
            <g key={z.id}>
              <polygon points={pts} fill={tone} opacity={0.05} />
              <polygon points={pts} fill="none" stroke={tone} strokeWidth={0.05 * k} strokeDasharray={`${0.5 * k} ${0.3 * k}`} opacity={0.55} />
              {labels &&
                lp &&
                (() => {
                  const label = z.name.toUpperCase()
                  const cw = 0.315 // mono glyph pitch at fs 0.38 + tracking
                  const left = lp.anchor === 'start' ? 0 : lp.anchor === 'end' ? -label.length * cw : (-label.length * cw) / 2
                  return (
                    <g transform={`translate(${lp.x} ${lp.z}) scale(${k})`}>
                      {/* zone-kind pictogram: no-entry / ATEX diamond / charge bolt */}
                      <g transform={`translate(${left - 0.32} -0.13)`} opacity={0.85}>
                        {z.kind === 'restricted' && (
                          <>
                            <circle r={0.16} fill="none" stroke={tone} strokeWidth={0.045} />
                            <line x1={-0.11} y1={0.11} x2={0.11} y2={-0.11} stroke={tone} strokeWidth={0.045} />
                          </>
                        )}
                        {z.kind === 'inspection' && (
                          <rect x={-0.13} y={-0.13} width={0.26} height={0.26} transform="rotate(45)" fill="none" stroke={tone} strokeWidth={0.045} />
                        )}
                        {z.kind === 'charging' && (
                          <path d="M 0.04 -0.16 L -0.1 0.02 L -0.01 0.02 L -0.04 0.16 L 0.1 -0.02 L 0.01 -0.02 Z" fill={tone} />
                        )}
                      </g>
                      <text textAnchor={lp.anchor ?? 'middle'} fill={tone} opacity={0.85} fontSize={0.38} fontFamily="var(--font-mono)" letterSpacing="0.08" style={{ userSelect: 'none' }}>
                        {label}
                      </text>
                    </g>
                  )
                })()}
            </g>
          )
        })}

        {/* clay massing */}
        <ClayBuildings buildings={buildings} />

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
            stroke="var(--color-accent)"
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
              {e.severity === 'critical' || e.severity === 'high' ? (
                <>
                  {/* alarm — warning triangle */}
                  <path d="M 0 -0.3 L 0.3 0.22 L -0.3 0.22 Z" fill="#0a0a0a" fillOpacity={0.85} stroke={SEVERITY_COLOR[e.severity]} strokeWidth={0.055} strokeLinejoin="round">
                    {e.severity === 'critical' && (
                      <animate attributeName="stroke-opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
                    )}
                  </path>
                  <rect x={-0.032} y={-0.13} width={0.064} height={0.2} fill={SEVERITY_COLOR[e.severity]} />
                  <circle cy={0.13} r={0.045} fill={SEVERITY_COLOR[e.severity]} />
                </>
              ) : (
                <>
                  <circle r={0.2} fill="none" stroke={SEVERITY_COLOR[e.severity]} strokeWidth={0.05} opacity={0.9} />
                  <circle r={0.07} fill={SEVERITY_COLOR[e.severity]} />
                </>
              )}
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
                    stroke={sel ? 'var(--color-accent)' : r.color}
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
                        <circle r={0.3} fill="none" stroke={sel ? 'var(--color-accent)' : r.color} strokeWidth={0.05} opacity={0.8}>
                          <animate attributeName="r" values="0.22;0.4;0.22" dur="2.2s" repeatCount="indefinite" />
                        </circle>
                        <circle r={0.06} fill={sel ? 'var(--color-accent)' : r.color} />
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

      {/* legend + provenance — full-page map only, embeds stay clean */}
      {labels && wheelZoom && (
        <div className="pointer-events-none absolute bottom-1.5 left-2 space-y-1">
          <div className="hidden items-center gap-3 sm:flex">
            {(
              [
                [
                  'map.lg.inspect',
                  <svg key="i" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.21} fill="none" stroke="#a8a8a2" strokeWidth={0.05} />
                    {[0, 90, 180, 270].map((a) => (
                      <line key={a} x1={0.21} y1={0} x2={0.33} y2={0} stroke="#a8a8a2" strokeWidth={0.05} transform={`rotate(${a})`} />
                    ))}
                    <circle r={0.06} fill="#a8a8a2" />
                  </svg>,
                ],
                [
                  'map.lg.nav',
                  <svg key="n" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.16} fill="none" stroke="#a8a8a2" strokeWidth={0.06} />
                  </svg>,
                ],
                [
                  'map.lg.dock',
                  <svg key="d" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.32} fill="none" stroke="var(--color-accent)" strokeWidth={0.05} />
                    <path d="M 0.06 -0.2 L -0.13 0.03 L -0.02 0.03 L -0.05 0.2 L 0.14 -0.03 L 0.03 -0.03 Z" fill="var(--color-accent)" />
                  </svg>,
                ],
                [
                  'map.lg.alarm',
                  <svg key="a" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <path d="M 0 -0.3 L 0.3 0.22 L -0.3 0.22 Z" fill="none" stroke="var(--color-warn)" strokeWidth={0.055} strokeLinejoin="round" />
                  </svg>,
                ],
              ] as const
            ).map(([key, icon]) => (
              <span key={key} className="flex items-center gap-1.5">
                {icon}
                <span className="mono text-[9px] text-ink-3">{t(key)}</span>
              </span>
            ))}
          </div>
          <div>
            <span className="mono text-[9px] text-ink-3/80">occupancy 5 cm/px · {site.map.source}</span>
          </div>
        </div>
      )}
    </div>
  )
}
