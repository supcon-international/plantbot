import { NavLink, Outlet, useLocation } from 'react-router'
import { LayoutGrid, Cctv, Bot, Map as MapIcon, ShieldAlert, X, Route } from 'lucide-react'
import { useApp } from '../../lib/store'
import { utcClock, ago } from '../../lib/format'
import { SevDot } from '../ui'
import { useEffect } from 'react'

const NAV = [
  { to: '/', label: 'OPS', title: 'Operations overview', icon: LayoutGrid },
  { to: '/live', label: 'LIVE', title: 'Video wall', icon: Cctv },
  { to: '/missions', label: 'TASKS', title: 'Mission control', icon: Route },
  { to: '/robots', label: 'FLEET', title: 'Robots', icon: Bot },
  { to: '/map', label: 'MAP', title: 'Site map', icon: MapIcon },
  { to: '/events', label: 'EVENTS', title: 'Detections', icon: ShieldAlert },
]

function NavItem({ to, label, icon: Icon, badge }: any) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={label}
      className={({ isActive }) =>
        `group relative flex flex-col items-center justify-center gap-1 transition-colors duration-150 ` +
        `md:h-14 md:w-full md:flex-none h-full flex-1 ` +
        (isActive ? 'text-ink' : 'text-ink-3 hover:text-ink-2')
      }
    >
      {({ isActive }) => (
        <>
          <span
            className="absolute transition-all duration-150 md:left-0 md:top-1/2 md:h-7 md:w-[2px] md:-translate-y-1/2 max-md:top-0 max-md:left-1/2 max-md:h-[2px] max-md:w-7 max-md:-translate-x-1/2"
            style={{ background: isActive ? 'var(--color-accent)' : 'transparent' }}
          />
          <span className="relative">
            <Icon size={18} strokeWidth={1.5} />
            {badge > 0 && (
              <span
                className="mono absolute -right-2 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-medium text-white"
                style={{ background: 'var(--color-crit)' }}
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </span>
          <span className="mono text-[9px] tracking-[0.12em]">{label}</span>
        </>
      )}
    </NavLink>
  )
}

function Toast() {
  const toast = useApp((s) => s.toast)
  const dismiss = useApp((s) => s.dismissToast)
  const location = useLocation()
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismiss, 7000)
    return () => clearTimeout(t)
  }, [toast, dismiss])
  if (!toast) return null
  return (
    <div className="fixed left-1/2 top-12 z-50 w-[min(480px,calc(100vw-24px))] -translate-x-1/2 md:top-14">
      <div
        className="panel rise flex items-center gap-3 px-3 py-2.5"
        style={{ borderColor: `color-mix(in srgb, ${toast.severity === 'critical' ? 'var(--color-crit)' : 'var(--color-warn)'} 45%, var(--color-line))` }}
      >
        <SevDot sev={toast.severity} pulse />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-ink">{toast.label}</div>
          <div className="microlabel mt-0.5">
            {toast.sourceName} · {toast.zone}
          </div>
        </div>
        <NavLink to="/events" onClick={dismiss} className="microlabel shrink-0 text-accent! hover:underline">
          View
        </NavLink>
        <button onClick={dismiss} className="text-ink-3 hover:text-ink" aria-label="dismiss">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

export function Shell() {
  const connected = useApp((s) => s.connected)
  const site = useApp((s) => s.site)
  const clock = useApp((s) => s.clock)
  const critCount = useApp(
    (s) => s.events.filter((e) => !e.acked && (e.severity === 'critical' || e.severity === 'high')).length,
  )

  return (
    <div className="relative z-10 h-full">
      {/* top bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-11 items-center gap-3 border-b border-line bg-bg/90 px-3 backdrop-blur md:h-12 md:px-4">
        <div className="flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
            <path d="M6 6h6v2H8v4H6V6zm20 0v6h-2V8h-4V6h6zM6 26v-6h2v4h4v2H6zm20 0h-6v-2h4v-4h2v6z" fill="var(--color-accent)" />
            <circle cx="16" cy="16" r="3.5" fill="var(--color-accent)" />
          </svg>
          <span className="text-[13px] font-semibold tracking-[0.02em] text-ink">AEGIS</span>
          <span className="microlabel hidden sm:block">Robotics Operations</span>
        </div>
        <div className="mx-2 hidden h-4 w-px bg-line md:block" />
        <div className="microlabel hidden truncate md:block" style={{ color: 'var(--color-ink-2)' }}>
          {site?.name ?? '—'}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="mono hidden text-[11px] text-ink-2 sm:block">{utcClock(clock)}</span>
          <span className="flex items-center gap-1.5">
            <span
              className={connected ? 'live-dot' : ''}
              style={{
                width: 6,
                height: 6,
                borderRadius: 99,
                background: connected ? 'var(--color-ok)' : 'var(--color-crit)',
              }}
            />
            <span className="microlabel" style={{ color: connected ? 'var(--color-ok)' : 'var(--color-crit)' }}>
              {connected ? 'LINK' : 'DOWN'}
            </span>
          </span>
          <span className="mono hidden border border-line-2 bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2 md:block">
            OP·ZHZ
          </span>
        </div>
      </header>

      {/* desktop rail */}
      <nav className="fixed bottom-0 left-0 top-12 z-40 hidden w-14 flex-col border-r border-line bg-surface md:flex">
        {NAV.map((n) => (
          <NavItem key={n.to} {...n} badge={n.to === '/events' ? critCount : 0} />
        ))}
        <div className="mt-auto mb-3 flex justify-center">
          <span className="microlabel rotate-180 [writing-mode:vertical-lr]">v0.1 · yard-07</span>
        </div>
      </nav>

      {/* mobile bottom tab bar */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 flex h-[58px] border-t border-line bg-surface/95 backdrop-blur md:hidden">
        {NAV.map((n) => (
          <NavItem key={n.to} {...n} badge={n.to === '/events' ? critCount : 0} />
        ))}
      </nav>

      <Toast />

      {/* content */}
      <main className="h-full overflow-y-auto pt-11 pb-[58px] md:pt-12 md:pb-0 md:pl-14">
        <Outlet />
      </main>
    </div>
  )
}
