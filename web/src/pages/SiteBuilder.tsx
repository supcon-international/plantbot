// Site Builder — the delivery-engineer tool. One screen, map-centric:
// upload the occupancy underlay, click waypoints onto it, draw zones, add
// RTSP cameras, calibrate vendor frames. Every save applies to the live
// World immediately (PUT /geometry); nothing here requires a redeploy.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { ArrowLeft, Check, Copy, Crosshair, MapIcon, MousePointer2, Move3D, Plus, Trash2, Upload, Video } from 'lucide-react'
import { api } from '../lib/store'
import { useT } from '../lib/i18n'
import { useConfirm } from '../components/ConfirmDialog'
import { Panel } from '../components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { SiteCamera, SiteInfo, Waypoint, Zone } from '../lib/types'

type Tool = 'select' | 'waypoint' | 'zone' | 'camera' | 'map' | 'calib'
type Sel = { kind: 'wp' | 'zone'; id: string } | null

const WP_KINDS: Waypoint['kind'][] = ['nav', 'inspect', 'dock']
const ZONE_KINDS: Zone['kind'][] = ['restricted', 'inspection', 'charging']
const ZONE_FILL: Record<Zone['kind'], string> = {
  restricted: 'var(--color-crit)',
  inspection: 'var(--color-ink-3)',
  charging: 'var(--signal)',
}

const nextId = (list: { id: string }[], prefix: string) => {
  let n = 1
  for (const it of list) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(it.id)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  return `${prefix}-${String(n).padStart(2, '0')}`
}

// ---------- 2D similarity solve (vendor → world), Umeyama ----------

export interface CalibPair {
  world: { x: number; z: number } | null
  vendor: { x: number; y: number }
}

export function solveSimilarity(pairs: { a: [number, number]; b: [number, number] }[]) {
  const n = pairs.length
  if (n < 2) return null
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / n
  const max = mean(pairs.map((p) => p.a[0]))
  const may = mean(pairs.map((p) => p.a[1]))
  const mbx = mean(pairs.map((p) => p.b[0]))
  const mby = mean(pairs.map((p) => p.b[1]))
  let sxx = 0
  let sxy = 0
  let saa = 0
  for (const p of pairs) {
    const ax = p.a[0] - max
    const ay = p.a[1] - may
    const bx = p.b[0] - mbx
    const by = p.b[1] - mby
    sxx += ax * bx + ay * by
    sxy += ax * by - ay * bx
    saa += ax * ax + ay * ay
  }
  if (saa === 0) return null
  const theta = Math.atan2(sxy, sxx)
  const s = Math.hypot(sxx, sxy) / saa
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const tx = mbx - s * (cos * max - sin * may)
  const ty = mby - s * (sin * max + cos * may)
  let se = 0
  for (const p of pairs) {
    const px = s * (cos * p.a[0] - sin * p.a[1]) + tx
    const py = s * (sin * p.a[0] + cos * p.a[1]) + ty
    se += (px - p.b[0]) ** 2 + (py - p.b[1]) ** 2
  }
  return { s, thetaRad: theta, t: [tx, ty] as [number, number], rms: Math.sqrt(se / n) }
}

// ---------- editor canvas (SVG, world coords: x→east, z→south) ----------

function EditorCanvas(props: {
  site: SiteInfo
  waypoints: Waypoint[]
  zones: Zone[]
  zoneDraft: [number, number][]
  dockWp: string
  tool: Tool
  sel: Sel
  calibMarks: { x: number; z: number }[]
  measure: [number, number][] | null
  onPlace: (p: { x: number; z: number }) => void
  onSelect: (sel: Sel) => void
  onMoveWp: (id: string, p: { x: number; z: number }) => void
}) {
  const { site, waypoints, zones, zoneDraft, dockWp, tool, sel } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState(() => center(site.bounds))
  // the container has no intrinsic size at first paint — measure after mount
  // (and on window resize; ResizeObserver is unreliable in embedded previews)
  const [aspect, setAspect] = useState(0.62)
  const [wpx, setWpx] = useState(900) // measured screen width (px) for the screen⇄world scale
  const [hover, setHover] = useState<Sel>(null)
  const drag = useRef<{ mode: 'pan' | 'wp'; id?: string; sx: number; sz: number } | null>(null)
  useEffect(() => setView(center(site.bounds)), [site.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const measure = () => {
      const r = svgRef.current?.getBoundingClientRect()
      if (r && r.width > 4 && r.height > 4) {
        setAspect(r.height / r.width)
        setWpx(r.width)
      }
    }
    measure()
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [])

  function center(b: SiteInfo['bounds']) {
    return { cx: (b.x[0] + b.x[1]) / 2, cz: (b.z[0] + b.z[1]) / 2, halfW: (b.x[1] - b.x[0]) / 2 + 3 }
  }

  const vb = { x: view.cx - view.halfW, w: view.halfW * 2, y: view.cz - view.halfW * aspect, h: view.halfW * 2 * aspect }

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return {
      x: +(vb.x + ((e.clientX - r.left) / r.width) * vb.w).toFixed(2),
      z: +(vb.y + ((e.clientY - r.top) / r.height) * vb.h).toFixed(2),
    }
  }

  const u = view.halfW / 46 // screen-constant marker unit
  // uniform screen⇄world scale: the viewBox aspect is matched to the container,
  // so one world metre renders as pxPerM screen pixels on both axes. Label sizes
  // and offsets are authored in screen px, then converted to world units below.
  const pxPerM = wpx / vb.w

  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e)
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12
    setView((v) => {
      const halfW = Math.min(500, Math.max(2, v.halfW * k))
      // zoom about the cursor
      const f = halfW / v.halfW
      return { halfW, cx: p.x - (p.x - v.cx) * f, cz: p.z - (p.z - v.cz) * f }
    })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const p = toWorld(e)
    if (tool === 'waypoint' || tool === 'zone' || tool === 'calib' || (tool === 'map' && props.measure)) {
      props.onPlace(p)
      return
    }
    drag.current = { mode: 'pan', sx: p.x, sz: p.z }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = toWorld(e)
    if (d.mode === 'pan') {
      // shift the center by the pointer's world-space delta (anchor point stays under the cursor)
      setView((v) => ({ ...v, cx: v.cx - (p.x - d.sx), cz: v.cz - (p.z - d.sz) }))
    } else if (d.mode === 'wp' && d.id) {
      props.onMoveWp(d.id, p)
    }
  }
  const onPointerUp = () => (drag.current = null)

  const startWpDrag = (e: React.PointerEvent, id: string) => {
    if (tool !== 'select') return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    props.onSelect({ kind: 'wp', id })
    const p = toWorld(e)
    drag.current = { mode: 'wp', id, sx: p.x, sz: p.z }
  }

  const b = site.bounds
  // waypoint label font tracks zoom but is clamped to 9–12 px (nominal 11 px at
  // the site's default framing); zone label fonts are derived per-zone below.
  const baseHalfW = (b.x[1] - b.x[0]) / 2 + 3
  const wpFontPx = Math.max(9, Math.min(12, 11 * (baseHalfW / view.halfW)))
  const labels = layoutLabels({ zones, waypoints, sel, hover, vb, pxPerM, wpFontPx })
  return (
    <svg
      ref={svgRef}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="none"
      className="h-full w-full touch-none select-none"
      style={{ background: 'var(--color-bg)', cursor: tool === 'select' ? 'grab' : 'crosshair' }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* occupancy underlay */}
      {site.map && (
        <image
          href={site.map.image}
          x={site.map.origin[0]}
          y={site.map.origin[1]}
          width={site.map.width * site.map.resolution}
          height={site.map.height * site.map.resolution}
          opacity={0.85}
          style={{ imageRendering: 'pixelated' }}
          preserveAspectRatio="none"
        />
      )}
      {/* 5 m grid */}
      {gridLines(b, u)}
      {/* bounds */}
      <rect x={b.x[0]} y={b.z[0]} width={b.x[1] - b.x[0]} height={b.z[1] - b.z[0]} fill="none" stroke="var(--color-line-2)" strokeWidth={u * 0.3} strokeDasharray={`${u * 1.4} ${u}`} />

      {/* zones */}
      {zones.map((zn) => {
        const pts = zn.polygon.map((p) => p.join(',')).join(' ')
        const hot = sel?.kind === 'zone' && sel.id === zn.id
        const c = ZONE_FILL[zn.kind]
        return (
          <g
            key={zn.id}
            onPointerDown={(e) => {
              if (tool !== 'select') return
              e.stopPropagation()
              props.onSelect({ kind: 'zone', id: zn.id })
            }}
            onPointerEnter={() => setHover({ kind: 'zone', id: zn.id })}
            onPointerLeave={() => setHover((h) => (h?.kind === 'zone' && h.id === zn.id ? null : h))}
          >
            <polygon points={pts} fill={c} fillOpacity={hot ? 0.22 : 0.1} stroke={c} strokeOpacity={0.8} strokeWidth={u * (hot ? 0.5 : 0.3)} />
          </g>
        )
      })}

      {/* zone draft */}
      {zoneDraft.length > 0 && (
        <g>
          <polyline points={zoneDraft.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--signal)" strokeWidth={u * 0.5} strokeDasharray={`${u} ${u * 0.6}`} />
          {zoneDraft.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={u * 0.9} fill="var(--signal)" />
          ))}
        </g>
      )}

      {/* waypoints */}
      {waypoints.map((w) => {
        const hot = sel?.kind === 'wp' && sel.id === w.id
        const isDock = w.id === dockWp
        const color = isDock ? 'var(--signal)' : w.kind === 'inspect' ? 'var(--color-ink)' : 'var(--color-ink-2)'
        return (
          <g
            key={w.id}
            transform={`translate(${w.x} ${w.z})`}
            onPointerDown={(e) => startWpDrag(e, w.id)}
            onPointerEnter={() => setHover({ kind: 'wp', id: w.id })}
            onPointerLeave={() => setHover((h) => (h?.kind === 'wp' && h.id === w.id ? null : h))}
            style={{ cursor: tool === 'select' ? 'pointer' : undefined }}
          >
            {hot && <circle r={u * 3.2} fill="none" stroke="var(--signal)" strokeWidth={u * 0.35} opacity={0.9} />}
            {w.kind === 'inspect' ? (
              <rect x={-u * 1.3} y={-u * 1.3} width={u * 2.6} height={u * 2.6} fill={color} transform="rotate(45)" />
            ) : (
              <circle r={u * 1.3} fill={isDock ? 'var(--signal)' : 'none'} stroke={color} strokeWidth={u * 0.55} />
            )}
          </g>
        )
      })}

      {/* labels layer — screen-px sized, collision-avoided, drawn above markers */}
      <g style={{ fontFamily: 'var(--font-mono)', pointerEvents: 'none' }}>
        {labels.map((l) => (
          <text key={l.key} x={l.x} y={l.y} fontSize={l.fontSize} fill={l.color} opacity={l.opacity} textAnchor={l.anchor} style={{ letterSpacing: '0.06em' }}>
            {l.text}
          </text>
        ))}
      </g>

      {/* calibration marks */}
      {props.calibMarks.map((m, i) => (
        <g key={i} transform={`translate(${m.x} ${m.z})`}>
          <line x1={-u * 2} x2={u * 2} stroke="var(--signal)" strokeWidth={u * 0.4} />
          <line y1={-u * 2} y2={u * 2} stroke="var(--signal)" strokeWidth={u * 0.4} />
          <text x={u * 2.4} y={-u} fontSize={u * 2.4} fill="var(--signal)" style={{ fontFamily: 'var(--font-mono)' }}>
            {i + 1}
          </text>
        </g>
      ))}

      {/* measure line (map scale helper) */}
      {props.measure && props.measure.length > 0 && (
        <g>
          <polyline points={props.measure.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--color-warn)" strokeWidth={u * 0.5} />
          {props.measure.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={u} fill="var(--color-warn)" />
          ))}
        </g>
      )}
    </svg>
  )
}

function gridLines(b: SiteInfo['bounds'], u: number) {
  const lines = []
  for (let x = Math.ceil(b.x[0] / 5) * 5; x <= b.x[1]; x += 5)
    lines.push(<line key={`x${x}`} x1={x} y1={b.z[0]} x2={x} y2={b.z[1]} stroke="var(--color-line)" strokeWidth={u * 0.14} />)
  for (let z = Math.ceil(b.z[0] / 5) * 5; z <= b.z[1]; z += 5)
    lines.push(<line key={`z${z}`} x1={b.x[0]} y1={z} x2={b.x[1]} y2={z} stroke="var(--color-line)" strokeWidth={u * 0.14} />)
  return <g opacity={0.6}>{lines}</g>
}

// ---------- label layout (screen-space placement + collision, world-space out) ----------

type LabelDesc = {
  key: string
  text: string
  x: number // world coords for the SVG <text>
  y: number
  fontSize: number // world units (screen px ÷ pxPerM)
  anchor: 'start' | 'end'
  color: string
  opacity: number
  onTop: boolean
}

// Zone + waypoint labels are sized/placed in *screen pixels* (fonts, insets and
// offsets are authored in px), then converted back to world units for the SVG,
// which draws in a world-space viewBox. A single pass keeps a list of occupied
// screen rects and resolves overlaps. Priority: selected/hovered (always drawn,
// on top, reserved first) > zones > waypoints.
function layoutLabels(p: {
  zones: Zone[]
  waypoints: Waypoint[]
  sel: Sel
  hover: Sel
  vb: { x: number; y: number; w: number; h: number }
  pxPerM: number
  wpFontPx: number
}): LabelDesc[] {
  const { zones, waypoints, sel, hover, vb, pxPerM, wpFontPx } = p
  const CHAR = 0.6 // monospace advance ≈ 0.6em (slight over-estimate ⇒ conservative)
  const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const sX = (wx: number) => (wx - vb.x) * pxPerM // world → screen px
  const sY = (wz: number) => (wz - vb.y) * pxPerM
  const wX = (sx: number) => vb.x + sx / pxPerM // screen px → world
  const wZ = (sy: number) => vb.y + sy / pxPerM

  type Rect = { x0: number; y0: number; x1: number; y1: number }
  const placed: Rect[] = []
  const hits = (r: Rect) => placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)
  const isHot = (kind: 'zone' | 'wp', id: string) =>
    (sel?.kind === kind && sel.id === id) || (hover?.kind === kind && hover.id === id)

  // zone label: top-left inside the bounding box (inset 6px), font scaled to the
  // box width and truncated with an ellipsis if it would overflow; thin/linear
  // zones (a fence) instead sit just above the strip, left-aligned.
  const planZone = (zn: Zone) => {
    const xs = zn.polygon.map((pt) => pt[0])
    const zs = zn.polygon.map((pt) => pt[1])
    const left = sX(Math.min(...xs))
    const right = sX(Math.max(...xs))
    const top = sY(Math.min(...zs))
    const bottom = sY(Math.max(...zs))
    const wPx = right - left
    const hPx = bottom - top
    const full = zn.name.toUpperCase()
    const len = Math.max(1, full.length)
    const thin = Math.min(wPx, hPx) < 24
    const availW = thin ? Math.max(wPx, hPx) : wPx
    const fpx = clamp(9, (availW / len) * 0.9, 13)
    const cw = fpx * CHAR
    let text = full
    let tx: number
    let ty: number // baseline
    if (thin) {
      tx = left
      ty = top - 4
    } else {
      tx = left + 6
      ty = top + 6 + fpx * 0.82
      const maxChars = Math.floor((wPx - 12) / cw)
      if (maxChars < len && maxChars >= 2) text = full.slice(0, maxChars - 1) + '…'
    }
    const rect: Rect = { x0: tx, y0: ty - fpx, x1: tx + text.length * cw, y1: ty }
    const emit = (onTop: boolean): LabelDesc => ({
      key: 'z-' + zn.id,
      text,
      x: wX(tx),
      y: wZ(ty),
      fontSize: fpx / pxPerM,
      anchor: 'start',
      color: ZONE_FILL[zn.kind],
      opacity: onTop ? 1 : 0.9,
      onTop,
    })
    return { rect, emit }
  }

  // waypoint label: id only, bottom-right of the marker (+8,+8 px) with a
  // top-left fallback (−8,−8 px); font fixed by wpFontPx (already zoom-clamped).
  const planWp = (w: Waypoint) => {
    const cx = sX(w.x)
    const cy = sY(w.z)
    const fpx = wpFontPx
    const tw = w.id.length * fpx * CHAR
    type Slot = { tx: number; ty: number; anchor: 'start' | 'end' }
    const p1: Slot = { tx: cx + 8, ty: cy + 8 + fpx * 0.82, anchor: 'start' }
    const p2: Slot = { tx: cx - 8, ty: cy - 8, anchor: 'end' }
    const rectFor = (s: Slot): Rect =>
      s.anchor === 'start'
        ? { x0: s.tx, y0: s.ty - fpx, x1: s.tx + tw, y1: s.ty }
        : { x0: s.tx - tw, y0: s.ty - fpx, x1: s.tx, y1: s.ty }
    const emit = (s: Slot, onTop: boolean): LabelDesc => ({
      key: 'w-' + w.id,
      text: w.id,
      x: wX(s.tx),
      y: wZ(s.ty),
      fontSize: fpx / pxPerM,
      anchor: s.anchor,
      color: 'var(--color-ink-2)',
      opacity: onTop ? 1 : 0.92,
      onTop,
    })
    return { p1, p2, rectFor, emit }
  }

  const base: LabelDesc[] = []
  const top: LabelDesc[] = []

  // 1) selected/hovered — always drawn, on top; reserve their rects first
  for (const zn of zones) {
    if (!isHot('zone', zn.id)) continue
    const { rect, emit } = planZone(zn)
    placed.push(rect)
    top.push(emit(true))
  }
  for (const w of waypoints) {
    if (!isHot('wp', w.id)) continue
    const { p1, rectFor, emit } = planWp(w)
    placed.push(rectFor(p1))
    top.push(emit(p1, true))
  }
  // 2) zones (higher priority than waypoints); skip on collision
  for (const zn of zones) {
    if (isHot('zone', zn.id)) continue
    const { rect, emit } = planZone(zn)
    if (hits(rect)) continue
    placed.push(rect)
    base.push(emit(false))
  }
  // 3) waypoints; try bottom-right, then top-left, else drop (hover reveals)
  for (const w of waypoints) {
    if (isHot('wp', w.id)) continue
    const { p1, p2, rectFor, emit } = planWp(w)
    const r1 = rectFor(p1)
    if (!hits(r1)) {
      placed.push(r1)
      base.push(emit(p1, false))
      continue
    }
    const r2 = rectFor(p2)
    if (!hits(r2)) {
      placed.push(r2)
      base.push(emit(p2, false))
    }
  }

  return [...base, ...top] // on-top labels rendered last ⇒ above the rest
}

// ---------- the page ----------

export function SiteBuilder() {
  const t = useT()
  const confirm = useConfirm()
  const { siteId = '' } = useParams()
  const [site, setSite] = useState<SiteInfo | null>(null)
  const [waypoints, setWaypoints] = useState<Waypoint[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [cameras, setCameras] = useState<SiteCamera[]>([])
  const [dockWp, setDockWp] = useState('')
  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<Sel>(null)
  const [zoneDraft, setZoneDraft] = useState<[number, number][]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)

  // map tab state
  const [mapMeta, setMapMeta] = useState({ resolution: 0.05, originX: 0, originZ: 0, name: '' })
  const [mapDataUrl, setMapDataUrl] = useState('')
  const [measure, setMeasure] = useState<[number, number][] | null>(null)

  // calibration state
  const [pairs, setPairs] = useState<CalibPair[]>([])
  const [flipY, setFlipY] = useState(true)
  const [calibFrom, setCalibFrom] = useState('vendor:laser')
  const [transforms, setTransforms] = useState<{ id: string; from: string; to: string; params: { s: number; thetaRad: number; t: [number, number] }; note?: string }[]>([])
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    const f = await api.fleet(siteId)
    if (!f.site) return
    setSite(f.site)
    setWaypoints(f.waypoints ?? [])
    setZones(f.zones ?? [])
    setCameras(f.cameras ?? [])
    setDockWp(f.dockWp ?? '')
    api.transforms(siteId).then((r) => setTransforms(r.transforms ?? []))
  }, [siteId])
  useEffect(() => {
    load()
  }, [load])

  const mark = () => setDirty(true)

  const place = (p: { x: number; z: number }) => {
    if (tool === 'waypoint') {
      const id = nextId(waypoints, 'WP')
      setWaypoints((ws) => [...ws, { id, name: id, x: p.x, z: p.z, kind: 'inspect' }])
      setSel({ kind: 'wp', id })
      mark()
    } else if (tool === 'zone') {
      setZoneDraft((d) => [...d, [p.x, p.z]])
    } else if (tool === 'calib') {
      setPairs((ps) => {
        const i = ps.findIndex((x) => !x.world)
        if (i >= 0) {
          const cp = [...ps]
          cp[i] = { ...cp[i], world: p }
          return cp
        }
        return [...ps, { world: p, vendor: { x: 0, y: 0 } }]
      })
    } else if (tool === 'map' && measure) {
      setMeasure((m) => (m && m.length < 2 ? ([...m, [p.x, p.z]] as [number, number][]) : [[p.x, p.z]]))
    }
  }

  const moveWp = (id: string, p: { x: number; z: number }) => {
    setWaypoints((ws) => ws.map((w) => (w.id === id ? { ...w, x: p.x, z: p.z } : w)))
    mark()
  }

  const closeZone = () => {
    if (zoneDraft.length < 3) return
    const id = nextId(zones, 'ZN')
    setZones((zs) => [...zs, { id, name: id, kind: 'inspection', polygon: zoneDraft }])
    setZoneDraft([])
    setSel({ kind: 'zone', id })
    setTool('select')
    mark()
  }

  const save = async () => {
    if (!site) return
    setSaving(true)
    const r = await api.saveGeometry(siteId, { waypoints, zones, cameras, dockWp, bounds: site.bounds })
    setSaving(false)
    if (r.ok) {
      setDirty(false)
      setSavedAt(Date.now())
    } else {
      toast.error(r.error ?? 'save failed')
    }
  }

  const uploadMap = async () => {
    if (!mapDataUrl) return
    const r = await api.uploadMap(siteId, {
      image: mapDataUrl,
      resolution: mapMeta.resolution,
      origin: [mapMeta.originX, mapMeta.originZ],
      name: mapMeta.name || 'site builder upload',
    })
    if (r.map && site) {
      setSite({ ...site, map: r.map })
      setMapDataUrl('')
    } else if (r.error) toast.error(r.error)
  }

  const fitBounds = () => {
    if (!site?.map) return
    const m = site.map
    const pad = 1
    setSite({
      ...site,
      bounds: {
        x: [+(m.origin[0] - pad).toFixed(1), +(m.origin[0] + m.width * m.resolution + pad).toFixed(1)],
        z: [+(m.origin[1] - pad).toFixed(1), +(m.origin[1] + m.height * m.resolution + pad).toFixed(1)],
      },
    })
    mark()
  }

  const applyMeasure = async () => {
    if (!site?.map || !measure || measure.length !== 2) return
    const d0 = Math.hypot(measure[1][0] - measure[0][0], measure[1][1] - measure[0][1])
    const entered = await confirm({
      input: true,
      title: t('sb.measureApply'),
      message: t('sb.measurePrompt'),
      defaultValue: d0.toFixed(2),
    })
    if (entered == null) return
    const real = Number(entered)
    if (!real || !isFinite(real) || d0 === 0) return
    const res = +(site.map.resolution * (real / d0)).toFixed(5)
    setMapMeta((m) => ({ ...m, resolution: res }))
    setMeasure(null)
    toast.success(`${t('sb.resolution')}: ${res} m/px — ${t('sb.measureApplied')}`)
  }

  const solved = useMemo(() => {
    const ready = pairs.filter((p) => p.world)
    if (ready.length < 2) return null
    return solveSimilarity(
      ready.map((p) => ({
        a: [p.vendor.x, flipY ? -p.vendor.y : p.vendor.y] as [number, number],
        b: [p.world!.x, p.world!.z] as [number, number],
      })),
    )
  }, [pairs, flipY])

  const saveCalib = async () => {
    if (!solved) return
    const r = await api.saveTransform(siteId, {
      id: `${calibFrom.replace(/[^a-z0-9_-]+/gi, '-')}-world`,
      from: calibFrom,
      to: 'world',
      params: { s: solved.s, thetaRad: solved.thetaRad, t: solved.t },
      note: `calibrated from ${pairs.filter((p) => p.world).length} point pairs · rms ${solved.rms.toFixed(3)} m${flipY ? ' · vendor y-up flipped' : ''}`,
    })
    if (r.transform) {
      api.transforms(siteId).then((x) => setTransforms(x.transforms ?? []))
      toast.success(t('sb.calibSaved'))
    } else {
      toast.error(r.error ?? 'save failed')
    }
  }

  const copy = (text: string, tag: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(tag)
    setTimeout(() => setCopied(''), 1500)
  }

  if (!site)
    return (
      <div className="p-6">
        <div className="microlabel">…</div>
      </div>
    )

  const selWp = sel?.kind === 'wp' ? waypoints.find((w) => w.id === sel.id) : undefined
  const selZone = sel?.kind === 'zone' ? zones.find((z) => z.id === sel.id) : undefined
  const gosuncnEnv = solved && Math.abs(solved.thetaRad) < 0.02 && flipY
    ? `GOSUNCN_PX_PER_M=${(1 / solved.s).toFixed(3)} GOSUNCN_ORIGIN_X=${solved.t[0].toFixed(2)} GOSUNCN_ORIGIN_Z=${solved.t[1].toFixed(2)}`
    : null

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 md:px-4">
        <Link to="/sites" className="text-ink-3 transition-colors hover:text-ink">
          <ArrowLeft size={16} />
        </Link>
        <div>
          <div className="microlabel">{t('sb.title')} · {site.id}</div>
          <div className="mono text-[14px] text-ink">{site.name}</div>
        </div>
        <div className="mono ml-2 hidden items-center gap-3 text-[10.5px] text-ink-3 lg:flex">
          <span>{waypoints.length} {t('sb.waypoints')}</span>
          <span>{zones.length} {t('sb.zones')}</span>
          <span>{cameras.length} {t('sb.cameras')}</span>
          <span style={{ color: site.map ? 'var(--color-ok)' : 'var(--color-warn)' }}>{site.map ? t('sb.mapOk') : t('sb.mapMissing')}</span>
          <span style={{ color: dockWp ? 'var(--color-ok)' : 'var(--color-warn)' }}>{dockWp ? `DOCK ${dockWp}` : t('sb.noDock')}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? <span className="mono text-[10.5px] text-warn">{t('sb.unsaved')}</span> : savedAt ? <span className="mono text-[10.5px] text-ok">{t('sb.saved')}</span> : null}
          <Button variant="signal" disabled={!dirty || saving} onClick={save} className="mono text-[11.5px] normal-case tracking-[0.12em] disabled:opacity-35">
            {saving ? '…' : t('sb.save')}
          </Button>
        </div>
      </div>

      {/* tools */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:px-4">
        <ToggleGroup
          type="single"
          value={tool}
          onValueChange={(v) => {
            if (!v) return
            setTool(v as Tool)
            setZoneDraft([])
            if (v !== 'map') setMeasure(null)
          }}
        >
          {(
            [
              ['select', MousePointer2, t('sb.toolSelect')],
              ['waypoint', Crosshair, t('sb.toolWaypoint')],
              ['zone', Move3D, t('sb.toolZone')],
              ['camera', Video, t('sb.toolCamera')],
              ['map', MapIcon, t('sb.toolMap')],
              ['calib', Copy, t('sb.toolCalib')],
            ] as const
          ).map(([v, Icon, label]) => (
            <ToggleGroupItem key={v} value={v} className="mono gap-1.5 text-[10px] tracking-[0.08em]">
              <Icon size={12} /> {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {tool === 'zone' && zoneDraft.length > 0 && (
          <Button variant="outline" size="sm" onClick={closeZone} disabled={zoneDraft.length < 3} className="mono h-auto px-2 py-1 text-[10.5px] normal-case tracking-[0.1em] disabled:opacity-40">
            <Check size={11} /> {t('sb.closeZone')} ({zoneDraft.length})
          </Button>
        )}
        <span className="mono ml-auto hidden text-[10px] text-ink-3 md:block">{t(`sb.hint.${tool}`)}</span>
      </div>

      {/* main split */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_300px]">
        <div className="relative min-h-[320px]">
          <EditorCanvas
            site={site}
            waypoints={waypoints}
            zones={zones}
            zoneDraft={zoneDraft}
            dockWp={dockWp}
            tool={tool}
            sel={sel}
            calibMarks={pairs.filter((p) => p.world).map((p) => p.world!)}
            measure={measure}
            onPlace={place}
            onSelect={setSel}
            onMoveWp={moveWp}
          />
        </div>

        {/* right panel */}
        <div className="overflow-y-auto border-t border-line md:border-l md:border-t-0">
          {/* SELECT / WAYPOINT — item props + lists */}
          {(tool === 'select' || tool === 'waypoint' || tool === 'zone') && (
            <div className="space-y-3 p-3">
              {selWp && (
                <Panel>
                  <div className="space-y-2.5 p-3">
                    <div className="flex items-center justify-between">
                      <span className="mono text-[12px] text-ink">{selWp.id}</span>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        className="text-ink-3 hover:text-crit"
                        onClick={() => {
                          setWaypoints((ws) => ws.filter((w) => w.id !== selWp.id))
                          if (dockWp === selWp.id) setDockWp('')
                          setSel(null)
                          mark()
                        }}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                    <Input
                      className="bg-surface-2 py-1.5 text-[12.5px]"
                      value={selWp.name}
                      onChange={(e) => {
                        setWaypoints((ws) => ws.map((w) => (w.id === selWp.id ? { ...w, name: e.target.value } : w)))
                        mark()
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Select
                        value={selWp.kind}
                        onValueChange={(v) => {
                          setWaypoints((ws) => ws.map((w) => (w.id === selWp.id ? { ...w, kind: v as Waypoint['kind'] } : w)))
                          if (v === 'dock') setDockWp(selWp.id)
                          mark()
                        }}
                      >
                        <SelectTrigger className="mono h-8 flex-1 bg-surface-2 text-[11px] normal-case tracking-normal">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WP_KINDS.map((k) => (
                            <SelectItem key={k} value={k}>
                              {k}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant={dockWp === selWp.id ? 'signal' : 'outline'}
                        size="sm"
                        className="mono h-8 px-2 text-[10px] normal-case tracking-[0.08em]"
                        onClick={() => {
                          setDockWp(selWp.id)
                          setWaypoints((ws) => ws.map((w) => (w.id === selWp.id ? { ...w, kind: 'dock' } : w.kind === 'dock' ? { ...w, kind: 'nav' } : w)))
                          mark()
                        }}
                      >
                        {t('sb.setDock')}
                      </Button>
                    </div>
                    <div className="mono text-[10.5px] text-ink-3">
                      x {selWp.x.toFixed(2)} · z {selWp.z.toFixed(2)} — {t('sb.dragHint')}
                    </div>
                  </div>
                </Panel>
              )}
              {selZone && (
                <Panel>
                  <div className="space-y-2.5 p-3">
                    <div className="flex items-center justify-between">
                      <span className="mono text-[12px] text-ink">{selZone.id}</span>
                      <Button
                        variant="ghost"
                        size="iconSm"
                        className="text-ink-3 hover:text-crit"
                        onClick={() => {
                          setZones((zs) => zs.filter((z) => z.id !== selZone.id))
                          setSel(null)
                          mark()
                        }}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                    <Input
                      className="bg-surface-2 py-1.5 text-[12.5px]"
                      value={selZone.name}
                      onChange={(e) => {
                        setZones((zs) => zs.map((z) => (z.id === selZone.id ? { ...z, name: e.target.value } : z)))
                        mark()
                      }}
                    />
                    <Select
                      value={selZone.kind}
                      onValueChange={(v) => {
                        setZones((zs) => zs.map((z) => (z.id === selZone.id ? { ...z, kind: v as Zone['kind'] } : z)))
                        mark()
                      }}
                    >
                      <SelectTrigger className="mono h-8 w-full bg-surface-2 text-[11px] normal-case tracking-normal">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ZONE_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {k}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Panel>
              )}
              <div>
                <div className="microlabel mb-1.5">{t('sb.waypoints')}</div>
                <div className="max-h-56 space-y-px overflow-y-auto">
                  {waypoints.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => setSel({ kind: 'wp', id: w.id })}
                      className={`mono flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] ${sel?.kind === 'wp' && sel.id === w.id ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60'}`}
                    >
                      <span className="w-14 shrink-0">{w.id}</span>
                      <span className="truncate">{w.name}</span>
                      <span className="ml-auto shrink-0 text-ink-3">{w.id === dockWp ? 'DOCK' : w.kind}</span>
                    </button>
                  ))}
                  {!waypoints.length && <div className="px-2 py-2 text-[11.5px] text-ink-3">{t('sb.noWaypoints')}</div>}
                </div>
              </div>
            </div>
          )}

          {/* CAMERAS */}
          {tool === 'camera' && (
            <CameraPanel cameras={cameras} onChange={(cs) => (setCameras(cs), mark())} />
          )}

          {/* MAP */}
          {tool === 'map' && (
            <div className="space-y-3 p-3">
              <div className="microlabel">{t('sb.mapUpload')}</div>
              <label className="flex cursor-pointer flex-col items-center gap-1.5 border border-dashed border-line-2 p-4 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink-2">
                <Upload size={16} />
                <span className="mono text-[10.5px]">{mapDataUrl ? t('sb.mapReady') : t('sb.mapDrop')}</span>
                <input
                  type="file"
                  accept="image/png"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    const rd = new FileReader()
                    rd.onload = () => setMapDataUrl(String(rd.result))
                    rd.readAsDataURL(f)
                    setMapMeta((m) => ({ ...m, name: f.name }))
                  }}
                />
              </label>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="mb-1 text-[10px]">{t('sb.resolution')}</Label>
                  <Input type="number" step="0.001" className="mono bg-surface-2 py-1.5 text-[11.5px]" value={mapMeta.resolution} onChange={(e) => setMapMeta((m) => ({ ...m, resolution: Number(e.target.value) }))} />
                </div>
                <div>
                  <Label className="mb-1 text-[10px]">origin x</Label>
                  <Input type="number" step="0.1" className="mono bg-surface-2 py-1.5 text-[11.5px]" value={mapMeta.originX} onChange={(e) => setMapMeta((m) => ({ ...m, originX: Number(e.target.value) }))} />
                </div>
                <div>
                  <Label className="mb-1 text-[10px]">origin z</Label>
                  <Input type="number" step="0.1" className="mono bg-surface-2 py-1.5 text-[11.5px]" value={mapMeta.originZ} onChange={(e) => setMapMeta((m) => ({ ...m, originZ: Number(e.target.value) }))} />
                </div>
              </div>
              <Button variant="signal" disabled={!mapDataUrl} onClick={uploadMap} className="mono w-full text-[11px] normal-case tracking-[0.12em] disabled:opacity-35">
                {t('sb.applyMap')}
              </Button>
              <div className="mono text-[10px] leading-relaxed text-ink-3">{t('sb.mapConvention')}</div>
              <div className="space-y-2 border-t border-line pt-3">
                <div className="microlabel">{t('sb.helpers')}</div>
                <Button variant="outline" size="sm" disabled={!site.map} onClick={fitBounds} className="mono w-full text-[10.5px] normal-case tracking-[0.1em] disabled:opacity-35">
                  {t('sb.fitBounds')}
                </Button>
                <Button
                  variant={measure ? 'signal' : 'outline'}
                  size="sm"
                  disabled={!site.map}
                  onClick={() => (measure && measure.length === 2 ? applyMeasure() : setMeasure(measure ? null : []))}
                  className="mono w-full text-[10.5px] normal-case tracking-[0.1em] disabled:opacity-35"
                >
                  {measure ? (measure.length === 2 ? t('sb.measureApply') : t('sb.measureActive')) : t('sb.measureStart')}
                </Button>
              </div>
            </div>
          )}

          {/* CALIBRATION */}
          {tool === 'calib' && (
            <div className="space-y-3 p-3">
              <div className="microlabel">{t('sb.calibTitle')}</div>
              <div className="text-[11.5px] leading-relaxed text-ink-3">{t('sb.calibHint')}</div>
              <div className="flex items-center gap-2">
                <Input className="mono h-8 flex-1 bg-surface-2 text-[11px]" value={calibFrom} onChange={(e) => setCalibFrom(e.target.value)} />
                <span className="mono text-[10px] text-ink-3">→ world</span>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="calib-flipy" checked={flipY} onCheckedChange={setFlipY} />
                <Label htmlFor="calib-flipy" className="mono cursor-pointer text-[10.5px] text-ink-2">
                  {t('sb.flipY')}
                </Label>
              </div>
              <div className="space-y-1.5">
                {pairs.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="mono w-4 text-[10px] text-signal">{i + 1}</span>
                    <span className="mono w-[86px] shrink-0 text-[10px] text-ink-3">
                      {p.world ? `${p.world.x.toFixed(1)}, ${p.world.z.toFixed(1)}` : t('sb.clickMap')}
                    </span>
                    <Input type="number" placeholder="x" className="mono h-7 bg-surface-2 px-1.5 text-[10.5px]" value={p.vendor.x} onChange={(e) => setPairs((ps) => ps.map((q, j) => (j === i ? { ...q, vendor: { ...q.vendor, x: Number(e.target.value) } } : q)))} />
                    <Input type="number" placeholder="y" className="mono h-7 bg-surface-2 px-1.5 text-[10.5px]" value={p.vendor.y} onChange={(e) => setPairs((ps) => ps.map((q, j) => (j === i ? { ...q, vendor: { ...q.vendor, y: Number(e.target.value) } } : q)))} />
                    <Button variant="ghost" size="iconSm" className="shrink-0 text-ink-3 hover:text-crit" onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setPairs((ps) => [...ps, { world: null, vendor: { x: 0, y: 0 } }])} className="mono w-full text-[10.5px] normal-case tracking-[0.1em]">
                  <Plus size={11} /> {t('sb.addPair')}
                </Button>
              </div>
              {solved && (
                <Panel>
                  <div className="mono space-y-1 p-2.5 text-[10.5px] text-ink-2">
                    <div>s = {solved.s.toFixed(5)} · θ = {((solved.thetaRad * 180) / Math.PI).toFixed(2)}°</div>
                    <div>t = [{solved.t[0].toFixed(2)}, {solved.t[1].toFixed(2)}]</div>
                    <div style={{ color: solved.rms < 0.5 ? 'var(--color-ok)' : 'var(--color-warn)' }}>rms = {solved.rms.toFixed(3)} m</div>
                    {gosuncnEnv && (
                      <button className="flex w-full items-center gap-1 border border-line px-1.5 py-1 text-left text-signal hover:border-line-2" onClick={() => copy(gosuncnEnv, 'env')}>
                        <Copy size={10} /> {copied === 'env' ? t('fl.wiz.copied') : gosuncnEnv}
                      </button>
                    )}
                  </div>
                </Panel>
              )}
              <Button variant="signal" disabled={!solved} onClick={saveCalib} className="mono w-full text-[11px] normal-case tracking-[0.12em] disabled:opacity-35">
                {t('sb.saveCalib')}
              </Button>
              {transforms.length > 0 && (
                <div className="space-y-1 border-t border-line pt-2.5">
                  <div className="microlabel">{t('sb.storedTransforms')}</div>
                  {transforms.map((tr) => (
                    <div key={tr.id} className="mono flex items-center gap-2 text-[10px] text-ink-3">
                      <span className="truncate">{tr.from} → {tr.to} · s {tr.params.s.toFixed(4)}</span>
                      <Button variant="ghost" size="iconSm" className="ml-auto shrink-0 text-ink-3 hover:text-crit" onClick={async () => (await api.deleteTransform(siteId, tr.id), api.transforms(siteId).then((x) => setTransforms(x.transforms ?? [])))}>
                        <Trash2 size={11} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CameraPanel({ cameras, onChange }: { cameras: SiteCamera[]; onChange: (cs: SiteCamera[]) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [rtsp, setRtsp] = useState('')
  const [place, setPlace] = useState('')
  const add = () => {
    if (!name.trim()) return
    const id = nextId(cameras, 'cam')
    onChange([
      ...cameras,
      { id, name: name.trim(), place: place.trim(), stream: id, rtsp: rtsp.trim() || undefined, live: !!rtsp.trim(), source: rtsp.trim() ? 'RTSP camera' : '—' },
    ])
    setName('')
    setRtsp('')
    setPlace('')
  }
  return (
    <div className="space-y-3 p-3">
      <div className="microlabel">{t('sb.cameras')}</div>
      {cameras.map((c) => (
        <div key={c.id} className="space-y-1 border border-line p-2">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-ink">{c.name}</span>
            <Button variant="ghost" size="iconSm" className="text-ink-3 hover:text-crit" onClick={() => onChange(cameras.filter((x) => x.id !== c.id))}>
              <Trash2 size={12} />
            </Button>
          </div>
          <div className="mono truncate text-[10px] text-ink-3">{c.rtsp ?? c.file ?? '—'}</div>
        </div>
      ))}
      <div className="space-y-2 border-t border-line pt-3">
        <Input placeholder={t('sb.cameraName')} className="bg-surface-2 py-1.5 text-[12px]" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="rtsp://user:pass@10.0.0.4:554/stream1" className="mono bg-surface-2 py-1.5 text-[11px]" value={rtsp} onChange={(e) => setRtsp(e.target.value)} />
        <Input placeholder={t('sb.cameraPlace')} className="bg-surface-2 py-1.5 text-[12px]" value={place} onChange={(e) => setPlace(e.target.value)} />
        <Button variant="outline" size="sm" disabled={!name.trim()} onClick={add} className="mono w-full text-[10.5px] normal-case tracking-[0.1em] disabled:opacity-35">
          <Plus size={11} /> {t('sb.addCamera')}
        </Button>
        <div className="mono text-[9.5px] leading-relaxed text-ink-3">{t('sb.rtspHint')}</div>
      </div>
    </div>
  )
}
