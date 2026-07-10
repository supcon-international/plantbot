import { useEffect, useMemo } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import {
  Bot,
  Cctv,
  LayoutGrid,
  LogIn,
  LogOut,
  Map as MapIcon,
  Moon,
  Plug,
  Route,
  Settings2,
  ShieldAlert,
  Sun,
  X,
} from 'lucide-react'
import { useApp, useAuth, useCan, useRole, useSite } from '../../lib/store'
import { useDataSaver } from '../../lib/media'
import { useTheme } from '../../lib/theme'
import { useT, useLang, type Lang } from '../../lib/i18n'
import { SevDot } from '../ui'

const NAV = [
  { to: '/', key: 'nav.ops', icon: LayoutGrid },
  { to: '/live', key: 'nav.live', icon: Cctv },
  { to: '/missions', key: 'nav.tasks', icon: Route },
  { to: '/robots', key: 'nav.fleet', icon: Bot },
  { to: '/map', key: 'nav.map', icon: MapIcon },
  { to: '/events', key: 'nav.events', icon: ShieldAlert },
]
const NAV_ADMIN = [...NAV, { to: '/integrations', key: 'nav.integrations', icon: Plug }]

function Brand({ compact = false }: { compact?: boolean }) {
  const t = useT()
  return (
    <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
      <span className="brand-mark" aria-hidden>
        <span className="brand-mark-core" />
      </span>
      <span className={compact ? '' : 'hidden xl:block'}>
        <span className="block text-[13px] font-semibold tracking-[0.18em] text-ink">PLANTBOT</span>
        {!compact && <span className="mono mt-0.5 block text-[9px] tracking-[0.16em] text-ink-3">{t('shell.brand')}</span>}
      </span>
    </div>
  )
}

function NavItem({ to, label, icon: Icon, badge }: { to: string; label: string; icon: any; badge: number }) {
  return (
    <NavLink to={to} end={to === '/'} title={label} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}>
      {({ isActive }) => (
        <>
          <span className="nav-item-icon">
            <Icon size={18} strokeWidth={isActive ? 1.9 : 1.55} />
            {badge > 0 && (
              <span className="nav-badge">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </span>
          <span className="nav-item-label">{label}</span>
          <span className="nav-item-signal" />
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
  ]
  return (
    <div className="segmented-control">
      {langs.map((l) => (
        <button key={l.id} onClick={() => setLang(l.id)} className={lang === l.id ? 'is-selected' : ''}>
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
    <label className="site-switch">
      <span className="utility-label">SITE</span>
      <select value={siteId} onChange={(e) => setSite(e.target.value)} aria-label="site">
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
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
      <button onClick={() => nav('/login')} className="utility-button">
        <LogIn size={13} />
        <span>{t('shell.signIn')}</span>
      </button>
    )
  return (
    <span className="flex items-center gap-2">
      <span className="mono hidden text-[11px] text-ink-2 xl:inline">{me.user.username}</span>
      <span className="role-chip">{t(`shell.role.${role}`)}</span>
      <button onClick={() => logout()} title={t('shell.signOut')} className="icon-button">
        <LogOut size={13} />
      </button>
    </span>
  )
}

function ThemeToggle() {
  const theme = useTheme((s) => s.theme)
  const toggle = useTheme((s) => s.toggle)
  const t = useT()
  return (
    <button onClick={toggle} title={t('shell.theme')} aria-label={t('shell.theme')} className="icon-button">
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  )
}

function EcoToggle() {
  const on = useDataSaver((s) => s.on)
  const toggle = useDataSaver((s) => s.toggle)
  const t = useT()
  return (
    <button onClick={toggle} title={t('shell.ecoTitle')} aria-pressed={on} className={`utility-button ${on ? 'is-on' : ''}`}>
      <span className="eco-leaf" />
      {t('shell.eco')}
    </button>
  )
}

function ConnectionStatus({ compact = false }: { compact?: boolean }) {
  const connected = useApp((s) => s.connected)
  const t = useT()
  return (
    <span className={`connection-chip ${connected ? 'is-online' : 'is-offline'} ${compact ? 'is-compact' : ''}`} title={connected ? t('shell.link') : t('shell.down')}>
      <span className={connected ? 'live-dot' : ''} />
      {!compact && <span>{connected ? t('shell.link') : t('shell.down')}</span>}
    </span>
  )
}

function MobileUtilityMenu() {
  const t = useT()
  return (
    <details className="mobile-utility-menu">
      <summary className="icon-button" aria-label={t('shell.controls')}>
        <Settings2 size={15} />
      </summary>
      <div className="mobile-utility-popover">
        <SiteSwitch />
        <div className="flex items-center justify-between gap-3">
          <EcoToggle />
          <ThemeToggle />
          <LangSwitch />
        </div>
        <AuthChip />
      </div>
    </details>
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
    <div className="toast-position fixed z-50 w-[min(420px,calc(100vw-24px))]">
      <div className="toast-card rise flex items-center gap-3 px-4 py-3">
        <SevDot sev={toast.severity} pulse />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{toast.label}</div>
          <div className="microlabel mt-0.5">{toast.sourceName} · {toast.zone}</div>
        </div>
        <NavLink to={`/events?ev=${toast.id}`} onClick={dismiss} className="text-link shrink-0">{t('shell.view')}</NavLink>
        <button onClick={dismiss} className="icon-button is-quiet" aria-label="dismiss"><X size={14} /></button>
      </div>
    </div>
  )
}

function RouteStage({ routeKey }: { routeKey: string }) {
  // key-remount replays the pure-CSS sweep/enter animations on every route
  // change; prefers-reduced-motion is handled by the global CSS gate
  return (
    <div key={routeKey} className="relative h-full">
      <span className="route-signal" aria-hidden />
      <div className="route-content h-full"><Outlet /></div>
    </div>
  )
}

export function Shell() {
  const location = useLocation()
  const lang = useLang((s) => s.lang)
  const t = useT()
  const isAdmin = useCan('admin')
  const nav = isAdmin ? NAV_ADMIN : NAV
  const robots = useApp((s) => s.robots)
  const site = useApp((s) => s.site)
  const critCount = useApp((s) => s.events.filter((e) => !e.acked && (e.severity === 'critical' || e.severity === 'high')).length)

  const page = useMemo(() => {
    const path = location.pathname
    if (path.startsWith('/robots/')) {
      const robot = robots.find((r) => path.endsWith(`/${r.id}`))
      return { title: robot?.callsign ?? t('nav.fleet') }
    }
    if (path === '/live') return { title: t('live.videoWall') }
    if (path === '/missions') return { title: t('mi.missionControl') }
    if (path === '/robots') return { title: t('fl.fleet') }
    if (path === '/map') return { title: site?.name ?? t('nav.map') }
    if (path === '/events') return { title: t('ev.center') }
    if (path === '/integrations') return { title: t('integ.title') }
    if (path === '/login') return { title: t('login.title') }
    return { title: t('shell.page.overview') }
  }, [location.pathname, robots, site?.name, t])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="side-brand"><Brand /></div>
        <div className="side-rail-label">{t('shell.workspace')}</div>
        <nav className="side-nav">
          {nav.map((n) => <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={n.to === '/events' ? critCount : 0} />)}
        </nav>
      </aside>

      <header className="top-bar">
        <div className="md:hidden"><Brand compact /></div>
        <div className="page-context">
          <span className="page-context-accent" aria-hidden />
          <h1>{page.title}</h1>
        </div>
        <div className="top-utilities">
          <SiteSwitch />
          <ConnectionStatus />
          <AuthChip />
          <EcoToggle />
          <ThemeToggle />
          <LangSwitch />
        </div>
        <div className="ml-auto flex items-center gap-2 md:hidden">
          <ConnectionStatus compact />
          <MobileUtilityMenu />
        </div>
      </header>

      <nav className="mobile-nav">
        {nav.map((n) => <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={n.to === '/events' ? critCount : 0} />)}
      </nav>

      <Toast />

      <main className="app-main">
        <RouteStage routeKey={`${location.pathname}${location.search}`} />
      </main>
    </div>
  )
}
