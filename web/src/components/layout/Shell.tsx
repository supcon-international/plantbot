import { useEffect, useMemo } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import {
  Bot,
  Building2,
  Cctv,
  LayoutGrid,
  LogIn,
  LogOut,
  Map as MapIcon,
  Moon,
  Plug,
  Plus,
  Route,
  Settings2,
  ShieldAlert,
  Sun,
} from 'lucide-react'
import { useNavigate as useNav2 } from 'react-router'
import { useApp, useAuth, useCan, useRole, useSite } from '../../lib/store'
import { Login } from '../../pages/Login'
import { useTheme } from '../../lib/theme'
import { useT, useLang, type Lang } from '../../lib/i18n'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Toaster } from '@/components/ui/sonner'

const NAV = [
  { to: '/', key: 'nav.ops', icon: LayoutGrid },
  { to: '/live', key: 'nav.live', icon: Cctv },
  { to: '/missions', key: 'nav.tasks', icon: Route },
  { to: '/robots', key: 'nav.fleet', icon: Bot },
  { to: '/map', key: 'nav.map', icon: MapIcon },
  { to: '/events', key: 'nav.events', icon: ShieldAlert },
]
const NAV_ADMIN = [
  ...NAV,
  { to: '/integrations', key: 'nav.integrations', icon: Plug },
  { to: '/sites', key: 'nav.sites', icon: Building2 },
]

/** Tier0 mark (docs.tier0.app favicon) — inlined so subpath deploys need no asset lookup */
function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden>
      <rect width="128" height="128" rx="24" fill="#161616" />
      <path
        transform="translate(-293.45 15.6) scale(0.78)"
        d="M411.795 109.369V14.7228L425.816 0.701172H490.666L504.688 14.7228V109.369L490.666 123.39H425.816L411.795 109.369ZM427.569 14.7228V109.369H488.914V14.7228H427.569Z"
        fill="#B2ED1D"
      />
    </svg>
  )
}

function Brand({ compact = false }: { compact?: boolean }) {
  const t = useT()
  return (
    <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
      <BrandMark size={compact ? 22 : 26} />
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
    <ToggleGroup type="single" value={lang} onValueChange={(v) => v && setLang(v as Lang)} aria-label="language">
      {langs.map((l) => (
        <ToggleGroupItem key={l.id} value={l.id} className="mono text-[9px] tracking-normal normal-case">
          {l.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
      <Select value={siteId} onValueChange={setSite}>
        <SelectTrigger size="bare" aria-label="site">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {sites.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
      <Button variant="utility" onClick={() => nav('/login')}>
        <LogIn size={13} />
        <span>{t('shell.signIn')}</span>
      </Button>
    )
  return (
    <span className="flex items-center gap-2">
      <span className="mono hidden text-[11px] text-ink-2 xl:inline">{me.user.username}</span>
      <span className="role-chip">{t(`shell.role.${role}`)}</span>
      <Button variant="utility" size="icon" onClick={() => logout()} title={t('shell.signOut')}>
        <LogOut size={13} />
      </Button>
    </span>
  )
}

function ThemeToggle() {
  const theme = useTheme((s) => s.theme)
  const toggle = useTheme((s) => s.toggle)
  const t = useT()
  return (
    <Button variant="utility" size="icon" onClick={toggle} title={t('shell.theme')} aria-label={t('shell.theme')}>
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </Button>
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
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="utility" size="icon" aria-label={t('shell.controls')}>
          <Settings2 size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="mobile-utility-popover-signal flex w-[min(300px,calc(100vw-24px))] flex-col gap-2.5 p-2.5"
      >
        <SiteSwitch />
        <div className="flex items-center justify-between gap-3">
          <ThemeToggle />
          <LangSwitch />
        </div>
        <AuthChip />
      </PopoverContent>
    </Popover>
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

/** production empty state — a fresh (non-demo) deployment has no sites yet */
function NoSitesHero() {
  const t = useT()
  const isAdmin = useCan('admin')
  const nav = useNav2()
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-4 border border-line bg-surface p-8 text-center">
        <Building2 size={28} strokeWidth={1.2} className="mx-auto text-ink-3" />
        <div className="text-[16px] font-medium text-ink">{t('sb.emptyTitle')}</div>
        <p className="text-[13px] leading-relaxed text-ink-3">{t('sb.emptyDesc')}</p>
        {isAdmin ? (
          <Button variant="signal" onClick={() => nav('/sites')} className="mono text-[11.5px] normal-case tracking-[0.12em]">
            <Plus size={13} /> {t('sb.newSite')}
          </Button>
        ) : (
          <p className="mono text-[11px] text-ink-3">{t('sb.emptyNeedAdmin')}</p>
        )}
      </div>
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
  const sites = useApp((s) => s.sites)
  const sitesLoaded = useApp((s) => s.sitesLoaded)
  const authLoaded = useAuth((s) => s.loaded)
  const publicView = useAuth((s) => s.publicView)
  const authedUser = useAuth((s) => s.me?.user ?? null)
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
    if (path === '/sites') return { title: t('nav.sitesTitle') }
    if (path.startsWith('/sites/')) return { title: t('sb.title') }
    return { title: t('shell.page.overview') }
  }, [location.pathname, robots, site?.name, t])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // PB_PUBLIC_VIEW=0 deployments: nothing renders before sign-in
  if (authLoaded && !publicView && !authedUser) {
    return (
      <div className="app-shell">
        <main className="app-main col-span-full row-span-full">
          <Login gate />
        </main>
      </div>
    )
  }

  const emptyPlatform =
    sitesLoaded && sites.length === 0 && location.pathname !== '/sites' && location.pathname !== '/login'

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

      <Toaster />

      <main className="app-main">
        {emptyPlatform ? <NoSitesHero /> : <RouteStage routeKey={`${location.pathname}${location.search}`} />}
      </main>
    </div>
  )
}
