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
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
