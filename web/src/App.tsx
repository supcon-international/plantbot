import { BrowserRouter, Route, Routes } from 'react-router'
import { BASE } from './lib/base'
import { Shell } from './components/layout/Shell'
import { Overview } from './pages/Overview'
import { Live } from './pages/Live'
import { Missions } from './pages/Missions'
import { Robots } from './pages/Robots'
import { RobotDetail } from './pages/RobotDetail'
import { MapPage } from './pages/MapPage'
import { Events } from './pages/Events'
import { Login } from './pages/Login'
import { Integrations } from './pages/Integrations'
import { Sites } from './pages/Sites'
import { SiteBuilder } from './pages/SiteBuilder'
import { Docs } from './pages/Docs'

export function App() {
  return (
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
          <Route path="login" element={<Login />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="docs" element={<Docs />} />
          <Route path="sites" element={<Sites />} />
          <Route path="sites/:siteId" element={<SiteBuilder />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
