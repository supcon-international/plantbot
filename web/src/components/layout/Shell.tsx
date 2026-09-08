import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { Book as BookOpen, Bot, Building as Building2, Video as Cctv, Dashboard as LayoutGrid, InventoryManagement as Warehouse, Login as LogIn, Logout as LogOut, Map as MapIcon, Moon, Plug, Add as Plus, Roadmap as Route, SettingsAdjust as Settings2, WarningAlt as ShieldAlert, Sun, OverflowMenuHorizontal as MoreHorizontal } from '@carbon/icons-react'
import { useApp, useAuth, useCan, useSite } from '../../lib/store'
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
  { to: '/assets', key: 'nav.assets', icon: Warehouse },
]
const NAV_ADMIN = [
  ...NAV,
  { to: '/integrations', key: 'nav.integrations', icon: Plug },
  { to: '/sites', key: 'nav.sites', icon: Building2 },
  { to: '/docs', key: 'nav.docs', icon: BookOpen },
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
        <span className="block text-sm font-medium tracking-normal text-ink">PLANTBOT</span>
        {!compact && <span className="mt-0.5 block text-xs text-ink-3">{t('shell.brand')}</span>}
      </span>
    </div>
  )
}

function NavItem({ to, label, icon: Icon, badge, mobile = false }: { to: string; label: string; icon: any; badge: number; mobile?: boolean }) {
  return (
    <NavLink to={to} end={to === '/'} title={label} aria-label={label} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}>
      {({ isActive }) => (
        <>
          <span className="nav-item-icon">
            <Icon size={18} />
            {badge > 0 && (
              <span className="nav-badge">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </span>
          <span className="nav-item-label" style={mobile ? { display: 'block' } : undefined}>
            {label}
          </span>
          <span className="nav-item-signal" />
        </>
      )}
    </NavLink>
  )
}

function LangSwitch() {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const setLang = useLang((s) => s.setLang)
  const langs: { id: Lang; label: string }[] = [
    { id: 'en', label: 'EN' },
    { id: 'zh', label: '中' },
  ]
  return (
    <ToggleGroup type="single" value={lang} onValueChange={(v) => v && setLang(v as Lang)} aria-label={t('shell.language')}>
      {langs.map((l) => (
        <ToggleGroupItem key={l.id} value={l.id} aria-label={l.id === 'en' ? 'English' : '中文'} className="text-xs tracking-normal normal-case">
          {l.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function SiteSwitch() {
  const t = useT()
  const sites = useApp((s) => s.sites)
  const siteId = useSite((s) => s.siteId)
  const setSite = useSite((s) => s.setSite)
  if (sites.length < 2) return null
  return (
    <label className="site-switch">
      <span className="utility-label">{t('shell.site')}</span>
      <Select value={siteId} onValueChange={setSite}>
        <SelectTrigger size="bare" aria-label={t('shell.site')}>
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
      <span className="max-w-28 truncate text-xs text-ink-2" title={me.user.username}>{me.user.username}</span>
      <Button variant="utility" size="icon" onClick={() => logout()} title={t('shell.signOut')} aria-label={t('shell.signOut')}>
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
  return (
    <div key={routeKey} className="relative h-full">
      <div className="route-content h-full"><Outlet /></div>
    </div>
  )
}

/** Keep frequent operations visible; every other module has a named, keyboard-accessible entry. */
function MobileNav({ nav, critCount }: { nav: typeof NAV_ADMIN; critCount: number }) {
  const t = useT()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const primary = nav.slice(0, 4)
  const more = nav.slice(4)
  const moreActive = more.some((n) => location.pathname === n.to || location.pathname.startsWith(`${n.to}/`))
  useEffect(() => setOpen(false), [location.pathname])
  return (
    <nav className="mobile-nav" aria-label={t('shell.navigation')}>
      {primary.map((n) => <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={0} mobile />)}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" className={`nav-item mobile-more-trigger ${moreActive ? 'is-active' : ''}`} aria-label={t('shell.more')}>
            <span className="nav-item-icon"><MoreHorizontal size={20} />{critCount > 0 && <span className="nav-badge">{critCount > 9 ? '9+' : critCount}</span>}</span>
            <span className="nav-item-label">{t('shell.more')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={12} className="w-[min(320px,calc(100vw-24px))] p-2">
          <nav className="mobile-more-nav grid gap-1" aria-label={t('shell.more')}>
            {more.map(({ to, key, icon: Icon }) => (
              <NavLink key={to} to={to} onClick={() => setOpen(false)} className={({ isActive }) => `flex min-h-11 items-center gap-3 rounded px-3 text-sm ${isActive ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2'}`}>
                <Icon size={18} /><span>{t(key)}</span>
                {to === '/events' && critCount > 0 && <span className="ml-auto text-crit">{critCount}</span>}
              </NavLink>
            ))}
          </nav>
        </PopoverContent>
      </Popover>
    </nav>
  )
}

/** iframe embedding: ?embed=1 drops the full app chrome (brand / utilities /
 *  side rail) so a host webapp can frame Plantbot without a competing header —
 *  but keeps a compact module-nav strip so users can still move between
 *  modules. Sticky per tab-session; ?embed=0 exits.
 *
 *  ?embednav=top|bottom|hidden controls where that strip sits, so a host that
 *  already owns the top edge can push it to the bottom (or hide it and drive
 *  navigation itself via the URL). Default: a slim top strip. */
type EmbedNavPos = 'top' | 'bottom' | 'hidden'
function useEmbedState(): { embedded: boolean; navPos: EmbedNavPos } {
  return useMemo(() => {
    const q = new URLSearchParams(window.location.search)
    const read = (key: string, storeKey: string): string | null => {
      const v = q.get(key)
      try {
        if (v !== null) {
          if (v === '0' || v === 'off') sessionStorage.removeItem(storeKey)
          else sessionStorage.setItem(storeKey, v)
        }
        return sessionStorage.getItem(storeKey)
      } catch {
        return v // sandboxed iframe without storage — honor the URL alone
      }
    }
    const embedFlag = read('embed', 'pb-embed')
    const navRaw = read('embednav', 'pb-embednav')
    const navPos: EmbedNavPos = navRaw === 'bottom' ? 'bottom' : navRaw === 'hidden' ? 'hidden' : 'top'
    return { embedded: embedFlag === '1', navPos }
  }, [])
}

/** compact module switcher for embed mode — icons + labels, no brand/utilities;
 *  reads as this widget's own tabs, not a second app header */
function EmbedNav({ nav, critCount, pos }: { nav: typeof NAV_ADMIN; critCount: number; pos: 'top' | 'bottom' }) {
  const t = useT()
  return (
    <nav aria-label={t('shell.navigation')} className={`embed-nav ${pos === 'bottom' ? 'is-bottom' : 'is-top'}`}>
      {nav.map((n) => (
        <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={n.to === '/events' ? critCount : 0} />
      ))}
    </nav>
  )
}

/** production empty state — a fresh (non-demo) deployment has no sites yet */
function NoSitesHero() {
  const t = useT()
  const isAdmin = useCan('admin')
  const nav = useNavigate()
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-4 border border-line bg-surface p-8 text-center">
        <Building2 size={28} className="mx-auto text-ink-3" />
        <div className="text-[16px] font-medium text-ink">{t('sb.emptyTitle')}</div>
        <p className="text-[13px] leading-relaxed text-ink-3">{t('sb.emptyDesc')}</p>
        {isAdmin ? (
          <Button variant="signal" onClick={() => nav('/sites')}>
            <Plus size={13} /> {t('sb.newSite')}
          </Button>
        ) : (
          <p className="text-[12px] text-ink-3">{t('sb.emptyNeedAdmin')}</p>
        )}
      </div>
    </div>
  )
}

export function Shell() {
  const location = useLocation()
  const { embedded, navPos } = useEmbedState()
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
  const connected = useApp((s) => s.connected)
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
    if (path === '/assets') return { title: t('assets.title') }
    if (path === '/integrations') return { title: t('integ.title') }
    if (path === '/docs') return { title: t('docs.title') }
    if (path === '/login') return { title: t('login.title') }
    if (path === '/sites') return { title: t('nav.sitesTitle') }
    if (path.startsWith('/sites/')) return { title: t('sb.title') }
    return { title: t('shell.page.overview') }
  }, [location.pathname, robots, site?.name, t])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  useEffect(() => {
    document.title = `${page.title} · Plantbot`
  }, [page.title])

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

  // Standalone /login (non-embed): strip the side rail, page-context bar and
  // grid paper — a slim brand-only top bar (theme + language) over a centred
  // card. The opaque bg-bg layer hides the fixed body::before grid; a
  // successful sign-in routes to '/', which re-renders the full shell.
  if (location.pathname === '/login' && !embedded) {
    return (
      <div className="relative z-[1] flex h-full flex-col bg-bg">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4">
          <div className="flex items-center gap-3">
            <BrandMark size={24} />
            <span className="leading-tight">
              <span className="block text-sm font-medium tracking-normal text-ink">PLANTBOT</span>
              <span className="block text-xs text-ink-3">{t('shell.brand')}</span>
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <LangSwitch />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    )
  }

  const emptyPlatform =
    sitesLoaded && sites.length === 0 && location.pathname !== '/sites' && location.pathname !== '/login'

  // embedded (iframe) shape: a compact module-nav strip + content, no app
  // chrome. The host owns brand / auth / utilities; we keep just enough to
  // navigate between modules. Strip position is host-configurable (embednav).
  if (embedded) {
    return (
      <div className={`app-shell embed-shell embed-nav-${navPos}`}>
        <Toaster />
        {navPos !== 'hidden' && <EmbedNav nav={nav} critCount={critCount} pos={navPos} />}
        <main id="main-content" tabIndex={-1} className="app-main embed-main">
          {emptyPlatform ? <NoSitesHero /> : <RouteStage routeKey={`${location.pathname}${location.search}`} />}
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('shell.skip')}</a>
      <aside className="side-rail">
        <div className="side-brand"><Brand /></div>
        <div className="side-rail-label">{t('shell.workspace')}</div>
        <nav className="side-nav" aria-label={t('shell.navigation')}>
          {nav.map((n) => <NavItem key={n.to} to={n.to} label={t(n.key)} icon={n.icon} badge={n.to === '/events' ? critCount : 0} />)}
        </nav>
      </aside>

      <header className="top-bar">
        <div role="img" className="shrink-0 md:hidden" aria-label="Plantbot"><BrandMark size={26} /></div>
        <div className="page-context">
          <span className="page-context-accent" aria-hidden />
          <h1>{page.title}</h1>
        </div>
        <div className="top-utilities">
          <span className="connection-status flex items-center gap-1.5 text-xs text-ink-3" role="status">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-accent' : 'bg-warn'}`} />
            {t(connected ? 'shell.connected' : 'shell.reconnecting')}
          </span>
          <SiteSwitch />
          <AuthChip />
          <ThemeToggle />
          <LangSwitch />
        </div>
        <div className="ml-auto flex items-center gap-2 md:hidden">
          <MobileUtilityMenu />
        </div>
      </header>

      <MobileNav nav={nav} critCount={critCount} />

      <Toaster />

      <main id="main-content" tabIndex={-1} className="app-main">
        {emptyPlatform ? <NoSitesHero /> : <RouteStage routeKey={`${location.pathname}${location.search}`} />}
      </main>
    </div>
  )
}
