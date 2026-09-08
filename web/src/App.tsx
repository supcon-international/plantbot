import { Suspense, lazy, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import { BASE } from './lib/base'
import { ConfirmProvider } from './components/ConfirmDialog'
import { Shell } from './components/layout/Shell'
import { Overview } from './pages/Overview'
import { Live } from './pages/Live'
import { Missions } from './pages/Missions'
import { Robots } from './pages/Robots'
import { RobotDetail } from './pages/RobotDetail'
import { MapPage } from './pages/MapPage'
import { Events } from './pages/Events'
import { Login } from './pages/Login'
import { useT } from './lib/i18n'
import { Button } from './components/ui/button'

// Admin / reference pages split out of the first-paint bundle — each lands in
// its own chunk, loaded on navigation. (The heavy 3D stack is already lazy via
// OpsMap / RobotViewer / RobotThumb.)
const Integrations = lazy(() => import('./pages/Integrations').then((m) => ({ default: m.Integrations })))
const Sites = lazy(() => import('./pages/Sites').then((m) => ({ default: m.Sites })))
const SiteBuilder = lazy(() => import('./pages/SiteBuilder').then((m) => ({ default: m.SiteBuilder })))
const Docs = lazy(() => import('./pages/Docs').then((m) => ({ default: m.Docs })))
const Assets = lazy(() => import('./pages/Assets'))

// Carbon-flavoured placeholder while a lazy chunk loads — shimmer blocks inside
// the Shell content area rather than a blank flash.
function PageFallback() {
  const t = useT()
  return (
    <div role="status" aria-label={t('c.loading')} className="mx-auto max-w-[1300px] space-y-3 p-3 md:p-4">
      <div className="skeleton h-8 w-56 opacity-40" />
      <div className="skeleton h-[60vh] w-full opacity-25" />
    </div>
  )
}

function NotFound() {
  const t = useT()
  return (
    <div className="mx-auto max-w-[1300px] space-y-4 p-4 md:p-6">
      <h2 className="text-xl font-medium">{t('c.notFound')}</h2>
      <p className="text-sm text-ink-2">{t('c.notFoundHint')}</p>
      <Button variant="default" asChild><Link to="/">{t('c.backOverview')}</Link></Button>
    </div>
  )
}

const lazyRoute = (el: ReactNode) => <Suspense fallback={<PageFallback />}>{el}</Suspense>

export function App() {
  return (
    <ConfirmProvider>
      <BrowserRouter basename={BASE || '/'}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="live" element={<Live />} />
            <Route path="missions" element={<Missions />} />
            <Route path="robots" element={<Robots />} />
            <Route path="robots/:id" element={<RobotDetail />} />
            <Route path="map" element={<MapPage />} />
            <Route path="events" element={<Events />} />
            <Route path="assets" element={lazyRoute(<Assets />)} />
            <Route path="login" element={<Login />} />
            <Route path="integrations" element={lazyRoute(<Integrations />)} />
            <Route path="docs" element={lazyRoute(<Docs />)} />
            <Route path="sites" element={lazyRoute(<Sites />)} />
            <Route path="sites/:siteId" element={lazyRoute(<SiteBuilder />)} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfirmProvider>
  )
}
