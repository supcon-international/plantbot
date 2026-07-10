import { NavLink, Outlet, useNavigate } from 'react-router'
import { LayoutGrid, Cctv, Bot, Map as MapIcon, ShieldAlert, X, Route, Plug, LogIn, LogOut, Sun, Moon } from 'lucide-react'
import { useApp, useAuth, useCan, useRole, useSite } from '../../lib/store'
import { useDataSaver } from '../../lib/media'
import { useTheme } from '../../lib/theme'
import { useT, useLang, type Lang } from '../../lib/i18n'
import { utcClock } from '../../lib/format'
import { SevDot } from '../ui'
import { useEffect } from 'react'

const NAV = [
  { to: '/', key: 'nav.ops', icon: LayoutGrid },
  { to: '/live', key: 'nav.live', icon: Cctv },
  { to: '/missions', key: 'nav.tasks', icon: Route },
  { to: '/robots', key: 'nav.fleet', icon: Bot },
  { to: '/map', key: 'nav.map', icon: MapIcon },
  { to: '/events', key: 'nav.events', icon: ShieldAlert },
]
const NAV_ADMIN = [...NAV, { to: '/integrations', key: 'nav.integrations', icon: Plug }]

function NavItem({ to, label, icon: Icon, badge }: { to: string; label: string; icon: any; badge: number }) {
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
                className="mono absolute -right-2 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[10px] font-medium text-white"
                style={{ background: 'var(--color-crit)' }}
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </span>
          <span className="mono max-w-[64px] truncate text-[10px] tracking-[0.12em]">{label}</span>
        </>
      )}
    </NavLink>
  )
}

function LangSwitch() {
  const lang = useLang((s) => s.lang)
  const setLang = useLang((s) => s.setLang)
  const langs: { id: Lang; label: string }[] = [
    { id: 'en', label: 'EN' },
    { id: 'zh', label: '中' },
    { id: 'es', label: 'ES' },
  ]
  return (
    <div className="flex overflow-hidden border border-line">
      {langs.map((l) => (
        <button
          key={l.id}
          onClick={() => setLang(l.id)}
          className={`mono px-1.5 py-0.5 text-[11px] transition-colors ${
            lang === l.id ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}

function SiteSwitch() {
  const sites = useApp((s) => s.sites)
  const siteId = useSite((s) => s.siteId)
  const setSite = useSite((s) => s.setSite)
  if (sites.length < 2) return null
  return (
    <select
      value={siteId}
      onChange={(e) => setSite(e.target.value)}
      aria-label="site"
      className="mono max-w-[170px] border border-line bg-surface px-1.5 py-0.5 text-[11px] tracking-[0.04em] text-ink-2 outline-none hover:text-ink"
    >
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )
}

function AuthChip() {
  const me = useAuth((s) => s.me)
  const logout = useAuth((s) => s.logout)
  const role = useRole()
  const t = useT()
  const nav = useNavigate()
  if (!me?.user)
    return (
      <button
        onClick={() => nav('/login')}
        className="mono flex items-center gap-1.5 border border-line px-1.5 py-0.5 text-[11px] tracking-[0.08em] text-ink-3 transition-colors hover:text-ink"
      >
        <LogIn size={11} />
        <span className="hidden sm:inline">{t('shell.signIn')}</span>
      </button>
    )
  return (
    <span className="flex items-center gap-1.5">
      <span className="mono hidden text-[11px] text-ink-2 md:inline">{me.user.username}</span>
      <span className="mono border border-line-2 bg-surface-2 px-1 py-0.5 text-[10px] tracking-[0.1em] text-ink-3">
        {t(`shell.role.${role}`)}
      </span>
      <button onClick={() => logout()} title={t('shell.signOut')} className="text-ink-3 transition-colors hover:text-ink">
        <LogOut size={12} />
      </button>
    </span>
  )
}

function ThemeToggle() {
  const theme = useTheme((s) => s.theme)
  const toggle = useTheme((s) => s.toggle)
  const t = useT()
  return (
    <button
      onClick={toggle}
      title={t('shell.theme')}
      aria-label={t('shell.theme')}
      className="flex h-[22px] w-[22px] items-center justify-center border border-line text-ink-3 transition-colors hover:text-ink"
    >
      {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
    </button>
  )
}

function EcoToggle() {
  const on = useDataSaver((s) => s.on)
  const toggle = useDataSaver((s) => s.toggle)
  const t = useT()
  return (
    <button
      onClick={toggle}
      title={t('shell.ecoTitle')}
      aria-pressed={on}
      className={`mono border px-1.5 py-0.5 text-[11px] tracking-[0.08em] transition-colors ${
        on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-ink-3 hover:text-ink-2'
      }`}
    >
      {t('shell.eco')}
    </button>
  )
}

function Toast() {
  const toast = useApp((s) => s.toast)
  const dismiss = useApp((s) => s.dismissToast)
  const t = useT()
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismiss, 7000)
    return () => clearTimeout(timer)
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
          <div className="truncate text-[14px] text-ink">{toast.label}</div>
          <div className="microlabel mt-0.5">
            {toast.sourceName} · {toast.zone}
          </div>
        </div>
        <NavLink to="/events" onClick={dismiss} className="microlabel shrink-0 text-ink! hover:underline">
          {t('shell.view')}
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
  const lang = useLang((s) => s.lang)
  const t = useT()
  const isAdmin = useCan('admin')
  const nav = isAdmin ? NAV_ADMIN : NAV
  const critCount = useApp(
    (s) => s.events.filter((e) => !e.acked && (e.severity === 'critical' || e.severity === 'high')).length,
  )

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  return (
    <div className="relative z-10 h-full">
      {/* top bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-11 items-center gap-3 border-b border-line bg-bg/90 px-3 backdrop-blur md:h-12 md:px-4">
        <div className="flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
            <path d="M6 6h6v2H8v4H6V6zm20 0v6h-2V8h-4V6h6zM6 26v-6h2v4h4v2H6zm20 0h-6v-2h4v-4h2v6z" fill="var(--color-accent)" />
            <circle cx="16" cy="16" r="3.5" fill="var(--color-accent)" />
          </svg>
          <span className="text-[14px] font-semibold tracking-[0.02em] text-ink">Plantbot</span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <SiteSwitch />
          <AuthChip />
          <EcoToggle />
          <ThemeToggle />
          <LangSwitch />
          {!connected && (
            <span className="flex items-center gap-1.5">
              <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--color-crit)' }} />
              <span className="microlabel" style={{ color: 'var(--color-crit)' }}>
                {t('shell.down')}
              </span>
            </span>
          )}
        </div>
      </header>

      {/* desktop rail */}
      <nav className="fixed bottom-0 left-0 top-12 z-40 hidden w-14 flex-col border-r border-line bg-surface md:flex">
        {nav.map((n) => (
          <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={n.to === '/events' ? critCount : 0} />
        ))}
      </nav>

      {/* mobile bottom tab bar */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 flex h-[58px] border-t border-line bg-surface/95 backdrop-blur md:hidden">
        {nav.map((n) => (
          <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={n.to === '/events' ? critCount : 0} />
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
