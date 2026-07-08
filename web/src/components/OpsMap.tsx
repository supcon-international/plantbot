import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, api } from '../lib/store'
import type { Waypoint } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'

export type MapSel =
  | { kind: 'robot'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'waypoint'; id: string }
  | null

const VB = { x: -16, z: -9, w: 32, h: 18 }

/** Occupancy grid base layer, theme-mapped: occupied → white laser lines,
 *  free → faintly lifted floor, unknown → transparent. */
function GridBase({ image }: { image: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const img = new Image()
    img.src = image
    img.onload = () => {
      const c = ref.current
      if (!c) return
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height)
      const px = d.data
      for (let i = 0; i < px.length; i += 4) {
        const v = px[i]
        if (v < 80) {
          // occupied — laser-struck surface
          px[i] = 223
          px[i + 1] = 228
          px[i + 2] = 233
          px[i + 3] = 235
        } else if (v > 235) {
          // free — swept floor
          px[i] = 21
          px[i + 1] = 24
          px[i + 2] = 29
          px[i + 3] = 255
        } else if (v >= 180 && v <= 225) {
          // unknown — leave the panel background visible
          px[i + 3] = 0
        } else {
          // speckle mid-values
          px[i] = 90
          px[i + 1] = 97
          px[i + 2] = 105
          px[i + 3] = 160
        }
      }
      ctx.putImageData(d, 0, 0)
    }
  }, [image])
  return (
    <canvas
      ref={ref}
      className="absolute inset-0 h-full w-full"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}

function WaypointGlyph({
  wp,
  selected,
  onClick,
}: {
  wp: Waypoint
  selected: boolean
  onClick?: () => void
}) {
  const s = 0.38
  const tone = selected ? '#f2f4f6' : wp.kind === 'dock' ? 'var(--color-ok)' : '#8f98a2'
  return (
    <g
      transform={`translate(${wp.x} ${wp.z})`}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <rect x={-s} y={-s} width={s * 2} height={s * 2} transform="rotate(45)" fill="none" stroke={tone} strokeWidth={selected ? 0.09 : 0.055} />
      <circle r={0.055} fill={tone} />
      {wp.kind === 'inspect' && <circle r={0.2} fill="none" stroke={tone} strokeWidth={0.04} opacity={0.7} />}
      <text
        y={-0.62}
        textAnchor="middle"
        fill={selected ? '#f2f4f6' : '#6e7681'}
        fontSize={0.52}
        fontFamily="var(--font-mono)"
        letterSpacing="0.04"
      >
        {wp.id.replace('WP-', 'W')}
      </text>
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
  /** override: clicking a waypoint calls this instead of the teleop menu */
  onWaypointClick?: (wp: Waypoint) => void
  /** waypoint id sequence to preview as a route */
  routePreview?: string[]
}) {
  const site = useApp((s) => s.site)
  const robots = useApp((s) => s.robots)
  const telemetry = useApp((s) => s.telemetry)
  const waypoints = useApp((s) => s.waypoints)
  const zones = useApp((s) => s.zones)
  const events = useApp((s) => s.events)
  const [gotoMenu, setGotoMenu] = useState<Waypoint | null>(null)

  const pins = useMemo(
    () => (showEvents ? events.filter((e) => !e.acked && Date.now() - e.ts < 45 * 60_000).slice(0, 10) : []),
    [events, showEvents],
  )

  if (!site) return <div className={`skeleton ${heightClass} ${className}`} />

  const zoneTone = (kind: string) =>
    kind === 'restricted'
      ? 'var(--color-crit)'
      : kind === 'charging'
        ? 'var(--color-ok)'
        : '#aab3bd'

  return (
    <div className={`relative overflow-hidden bg-surface ${heightClass} ${className}`}>
      {/* base occupancy grid, theme-mapped */}
      <div className="absolute inset-0" style={{ aspectRatio: '16/9' }}>
        <GridBase image={site.map.image} />
      </div>

      {/* vector layer */}
      <svg
        viewBox={`${VB.x} ${VB.z} ${VB.w} ${VB.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full"
        onClick={() => {
          onSelect?.(null)
          setGotoMenu(null)
        }}
      >
        {/* zones */}
        {zones.map((z) => {
          const pts = z.polygon.map((p) => p.join(',')).join(' ')
          const tone = zoneTone(z.kind)
          const cx = z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length
          const topZ = Math.min(...z.polygon.map((p) => p[1]))
          return (
            <g key={z.id}>
              <polygon points={pts} fill={tone} opacity={0.05} />
              <polygon points={pts} fill="none" stroke={tone} strokeWidth={0.05} strokeDasharray="0.5 0.3" opacity={0.55} />
              {labels && (
                <text x={cx} y={topZ + 0.75} textAnchor="middle" fill={tone} opacity={0.75} fontSize={0.5} fontFamily="var(--font-mono)" letterSpacing="0.08">
                  {z.name.toUpperCase()}
                </text>
              )}
            </g>
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
            strokeWidth={0.07}
            strokeDasharray="0.4 0.28"
            opacity={0.75}
          />
        )}

        {/* waypoints */}
        {waypoints.map((wp) => {
          const orderIdx = routePreview?.indexOf(wp.id) ?? -1
          return (
            <g key={wp.id}>
              <WaypointGlyph
                wp={wp}
                selected={(selection?.kind === 'waypoint' && selection.id === wp.id) || orderIdx >= 0}
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
              {orderIdx >= 0 && (
                <g transform={`translate(${wp.x + 0.55} ${wp.z - 0.5})`}>
                  <circle r={0.34} fill="#f2f4f6" />
                  <text y={0.13} textAnchor="middle" fill="#0c0d0f" fontSize={0.42} fontWeight={600} fontFamily="var(--font-mono)">
                    {orderIdx + 1}
                  </text>
                </g>
              )}
            </g>
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
            <circle r={0.34} fill="none" stroke={SEVERITY_COLOR[e.severity]} strokeWidth={0.06} opacity={0.9}>
              {e.severity === 'critical' && (
                <animate attributeName="r" values="0.26;0.44;0.26" dur="1.6s" repeatCount="indefinite" />
              )}
            </circle>
            <circle r={0.09} fill={SEVERITY_COLOR[e.severity]} />
          </g>
        ))}

        {/* robots: planned path + pose */}
        {robots.map((r) => {
          const tel = telemetry[r.id]
          if (!tel) return null
          const sel = selection?.kind === 'robot' && selection.id === r.id
          const deg = (-tel.heading * 180) / Math.PI
          return (
            <g key={r.id}>
              {tel.path.length > 0 && (
                <polyline
                  points={[`${tel.x},${tel.z}`, ...tel.path.map((p) => `${p.x},${p.z}`)].join(' ')}
                  fill="none"
                  stroke={sel ? '#f2f4f6' : r.color}
                  strokeWidth={sel ? 0.08 : 0.05}
                  strokeDasharray="0.32 0.22"
                  className="path-march"
                  opacity={sel ? 0.95 : 0.6}
                />
              )}
              {tel.targetWp &&
                (() => {
                  const wp = waypoints.find((w) => w.id === tel.targetWp)
                  return wp ? (
                    <circle cx={wp.x} cy={wp.z} r={0.5} fill="none" stroke={sel ? '#f2f4f6' : r.color} strokeWidth={0.04} opacity={0.65}>
                      <animate attributeName="r" values="0.4;0.62;0.4" dur="2.4s" repeatCount="indefinite" />
                    </circle>
                  ) : null
                })()}
              <g
                transform={`translate(${tel.x} ${tel.z})`}
                onClick={(e) => {
                  e.stopPropagation()
                  interactive && onSelect?.({ kind: 'robot', id: r.id })
                }}
                style={{ cursor: interactive ? 'pointer' : 'default' }}
              >
                {r.family === 'ugv' ? (
                  <rect x={-0.34} y={-0.34} width={0.68} height={0.68} fill="none" stroke={sel ? '#f2f4f6' : r.color} strokeWidth={sel ? 0.1 : 0.07} transform={`rotate(${deg})`} />
                ) : (
                  <circle r={0.36} fill="none" stroke={sel ? '#f2f4f6' : r.color} strokeWidth={sel ? 0.1 : 0.07} />
                )}
                <g transform={`rotate(${deg})`}>
                  <path d="M 0.62 0 L 0.18 -0.2 L 0.18 0.2 Z" fill={sel ? '#f2f4f6' : r.color} />
                </g>
                <circle r={0.07} fill={sel ? '#f2f4f6' : r.color} />
                {labels && (
                  <text y={-0.78} textAnchor="middle" fill={sel ? '#f2f4f6' : '#9aa2ab'} fontSize={0.56} fontFamily="var(--font-mono)" letterSpacing="0.06" fontWeight={500}>
                    {r.callsign}
                  </text>
                )}
              </g>
            </g>
          )
        })}
      </svg>

      {/* waypoint teleop menu */}
      {gotoMenu && interactive && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <div className="panel flex items-center gap-2 px-3 py-2">
            <span className="mono text-[11px] text-ink">{gotoMenu.id}</span>
            <span className="text-[11px] text-ink-3">{gotoMenu.name}</span>
            <span className="mx-1 h-4 w-px bg-line-2" />
            <span className="microlabel">send</span>
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
        <div className="pointer-events-none absolute bottom-1.5 right-2">
          <span className="mono text-[9px] text-ink-3/80">
            occupancy 5 cm/px · {site.map.source}
          </span>
        </div>
      )}
    </div>
  )
}
