import type { CSSProperties, ReactNode } from 'react'
import type { MissionStatus, RobotMode, Severity } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'
import { useT } from '../lib/i18n'

export function Panel({
  children,
  className = '',
  style,
  onClick,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  onClick?: () => void
}) {
  return (
    <div onClick={onClick} style={style} className={`panel ${className}`}>
      {children}
    </div>
  )
}

export function PanelHead({
  label,
  right,
  className = '',
}: {
  label: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5 ${className}`}>
      <span className="microlabel">{label}</span>
      {right}
    </div>
  )
}

export function SevDot({ sev, pulse = false }: { sev: Severity; pulse?: boolean }) {
  return (
    <span
      className={pulse && sev === 'critical' ? 'live-dot crit' : ''}
      style={{
        width: 6,
        height: 6,
        borderRadius: 99,
        background: SEVERITY_COLOR[sev],
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  )
}

export function SevTag({ sev }: { sev: Severity }) {
  const t = useT()
  return (
    <span
      className="mono inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
      style={{
        color: SEVERITY_COLOR[sev],
        border: `1px solid color-mix(in srgb, ${SEVERITY_COLOR[sev]} 30%, transparent)`,
        background: `color-mix(in srgb, ${SEVERITY_COLOR[sev]} 7%, transparent)`,
      }}
    >
      <SevDot sev={sev} />
      {t(`sev.${sev}`)}
    </span>
  )
}

const MODE_TONE: Record<RobotMode, string> = {
  idle: 'var(--color-ink-3)',
  navigating: 'var(--color-ink)',
  executing: 'var(--color-ink)',
  teleop: 'var(--color-warn)',
  charging: 'var(--color-ok)',
}

export function ModeChip({ mode }: { mode?: RobotMode }) {
  const t = useT()
  const tone = mode ? MODE_TONE[mode] : 'var(--color-ink-3)'
  return (
    <span
      className="mono px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
      style={{ color: tone, border: '1px solid var(--color-line-2)', background: 'var(--color-surface-2)' }}
    >
      {t(mode ? `mode.${mode}` : 'mode.offline')}
    </span>
  )
}

export const MISSION_STATUS_TONE: Record<MissionStatus, string> = {
  active: 'var(--color-ink)',
  queued: 'var(--color-ink-2)',
  done: 'var(--color-ok)',
  failed: 'var(--color-crit)',
  aborted: 'var(--color-low)',
}

export function MissionStatusTag({ status }: { status: MissionStatus }) {
  const t = useT()
  const tone = MISSION_STATUS_TONE[status]
  return (
    <span
      className="mono inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
      style={{ color: tone, border: '1px solid var(--color-line-2)', background: 'var(--color-surface-2)' }}
    >
      {status === 'active' && <span className="live-dot" style={{ width: 5, height: 5 }} />}
      {t(`ms.${status}`)}
    </span>
  )
}

export function Stat({
  label,
  value,
  unit,
  tone,
  size = 'md',
}: {
  label: string
  value: ReactNode
  unit?: string
  tone?: string
  size?: 'md' | 'lg' | 'xl'
}) {
  const fs = size === 'xl' ? 'text-[30px]' : size === 'lg' ? 'text-[22px]' : 'text-[15px]'
  return (
    <div className="min-w-0">
      <div className="microlabel mb-1">{label}</div>
      <div className={`mono ${fs} leading-none`} style={{ color: tone ?? 'var(--color-ink)' }}>
        {value}
        {unit && <span className="ml-1 text-[11px] text-ink-3">{unit}</span>}
      </div>
    </div>
  )
}

export function Spark({
  points,
  color = 'var(--color-ink-2)',
  min,
  max,
  w = 120,
  h = 28,
  fill = true,
}: {
  points: number[]
  color?: string
  min?: number
  max?: number
  w?: number
  h?: number
  fill?: boolean
}) {
  if (points.length < 2)
    return <div style={{ width: '100%', maxWidth: w, height: h }} className="skeleton opacity-40" />
  const lo = min ?? Math.min(...points)
  const hi = max ?? Math.max(...points)
  const span = hi - lo || 1
  const step = w / (points.length - 1)
  const ys = points.map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - ((p - lo) / span) * (h - 6)).toFixed(1)}`)
  const path = `M${ys.join(' L')}`
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block"
      style={{ width: '100%', maxWidth: w, height: h }}
    >
      {fill && <path d={`${path} L${w},${h} L0,${h} Z`} fill={color} opacity={0.07} />}
      <path d={path} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      <circle cx={w} cy={h - 2 - ((points[points.length - 1] - lo) / span) * (h - 6)} r={1.8} fill={color} />
    </svg>
  )
}

export function BatteryBar({ value, w = 64 }: { value: number; w?: number }) {
  const tone = value > 40 ? 'var(--color-ink-2)' : value > 20 ? 'var(--color-warn)' : 'var(--color-crit)'
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-[9px] overflow-hidden" style={{ width: w, border: '1px solid var(--color-line-2)' }}>
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-700"
          style={{ width: `${value}%`, background: tone, opacity: 0.9 }}
        />
      </div>
      <span className="mono text-[11px]" style={{ color: value > 20 ? 'var(--color-ink-2)' : tone }}>
        {Math.round(value)}%
      </span>
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-24 items-center justify-center">
      <span className="microlabel">{children}</span>
    </div>
  )
}

export function Modal({
  children,
  onClose,
  wide = false,
}: {
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className={`panel max-h-[92vh] w-full overflow-y-auto ${wide ? 'md:max-w-2xl' : 'md:max-w-xl'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
