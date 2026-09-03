// Console-domain widgets on top of the shadcn/ui substrate (@/components/ui/*).
// Panel/PanelHead wrap Card, Modal wraps Dialog, the status chips wrap Badge —
// same exported API as before, so pages keep their vocabulary while behavior,
// focus management and a11y come from Radix.

import type { CSSProperties, ReactNode } from 'react'
import type { MissionStatus, RobotMode, Severity } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'
import { useT } from '../lib/i18n'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

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
    <Card onClick={onClick} style={style} className={`panel ${className}`}>
      {children}
    </Card>
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
    <CardHeader className={className}>
      <CardTitle>{label}</CardTitle>
      {right}
    </CardHeader>
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
    <Badge
      variant="outline"
      style={{
        color: SEVERITY_COLOR[sev],
        borderColor: `color-mix(in srgb, ${SEVERITY_COLOR[sev]} 30%, transparent)`,
        background: `color-mix(in srgb, ${SEVERITY_COLOR[sev]} 7%, transparent)`,
      }}
    >
      <SevDot sev={sev} />
      {t(`sev.${sev}`)}
    </Badge>
  )
}

const MODE_TONE: Record<RobotMode, string> = {
  idle: 'var(--color-ink-3)',
  navigating: 'var(--color-ink)',
  executing: 'var(--color-ink)',
  teleop: 'var(--color-warn)',
  charging: 'var(--color-ink)',
  offline: 'var(--color-crit)',
}
const MODE_ACTIVE: ReadonlySet<RobotMode> = new Set(['navigating', 'executing', 'charging'])

export function ModeChip({ mode }: { mode?: RobotMode }) {
  const t = useT()
  const tone = mode ? MODE_TONE[mode] : 'var(--color-ink-3)'
  return (
    <Badge className="mode-chip" data-mode={mode ?? 'offline'} style={{ color: tone }}>
      {mode && MODE_ACTIVE.has(mode) && <span className="live-dot" style={{ width: 5, height: 5 }} />}
      {t(mode ? `mode.${mode}` : 'mode.offline')}
    </Badge>
  )
}

export const MISSION_STATUS_TONE: Record<MissionStatus, string> = {
  active: 'var(--color-accent)',
  queued: 'var(--color-ink-2)',
  done: 'var(--color-ink-2)',
  failed: 'var(--color-crit)',
  aborted: 'var(--color-low)',
}

export function MissionStatusTag({ status }: { status: MissionStatus }) {
  const t = useT()
  const tone = MISSION_STATUS_TONE[status]
  return (
    <Badge className="mission-status-chip" data-status={status} style={{ color: tone }}>
      {status === 'active' && <span className="live-dot" style={{ width: 5, height: 5 }} />}
      {t(`ms.${status}`)}
    </Badge>
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
        {unit && <span className="ml-1 text-[12px] text-ink-3">{unit}</span>}
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
  const t = useT()
  if (points.length < 2)
    return <div style={{ width: '100%', maxWidth: w, height: h }} className="skeleton opacity-40" />
  const lo = min ?? Math.min(...points)
  const hi = max ?? Math.max(...points)
  const span = hi - lo || 1
  // a flat series is information, not a chart: say "steady" instead of drawing
  // a decorative straight line (variation under 2% of the scale counts as flat)
  const range = Math.max(...points) - Math.min(...points)
  if (range <= span * 0.02)
    return (
      <div className="flex items-center gap-2" style={{ width: '100%', maxWidth: w, height: h }}>
        <div className="h-px flex-1" style={{ background: 'var(--color-line-2)' }} />
        <span className="microlabel">{t('c.steady')}</span>
      </div>
    )
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
  // greyscale by default; colour only when the level itself is the news
  const tone = value > 40 ? 'var(--color-ink-2)' : value > 20 ? 'var(--color-warn)' : 'var(--color-crit)'
  return (
    <div className="flex items-center gap-2">
      <div className="battery-track relative h-[9px] overflow-hidden" style={{ width: w, border: '1px solid var(--color-line-2)' }}>
        <div
          className="battery-fill absolute inset-y-0 left-0 transition-[width] duration-700"
          style={{ width: `${value}%`, color: tone }}
        />
      </div>
      <span className="battery-value mono text-[12px]" style={{ color: value > 20 ? 'var(--color-ink-2)' : tone }}>
        {Math.round(value)}%
      </span>
    </div>
  )
}

/** empty state as a plain sentence (with an optional action), never a shouting placeholder */
export function EmptyNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-2 px-6 py-5 text-center">
      <span className="max-w-[40ch] text-[13px] leading-snug text-ink-3">{children}</span>
      {action}
    </div>
  )
}

/** Dialog with the console modal geometry (bottom sheet on mobile, centred on
 *  md+). Same call signature as the old hand-rolled Modal; `title` feeds the
 *  accessible name (visually hidden — pages draw their own heading rows). */
export function Modal({
  children,
  onClose,
  wide = false,
  title = 'Dialog',
}: {
  children: ReactNode
  onClose: () => void
  wide?: boolean
  title?: string
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={wide ? 'md:max-w-2xl' : 'md:max-w-xl'}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}
