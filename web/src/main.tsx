import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans-condensed/400.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles/app.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startRealtime } from './lib/store'

startRealtime()

// No StrictMode: its double-mount races @react-three/fiber's resize
// observer on hard loads (canvas stuck at the 300px default buffer).
createRoot(document.getElementById('root')!).render(<App />)
