import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// vite's dev server intercepts *.html for its SPA pipeline, so a static
// public/*.html (the standalone Redoc page) 404s in dev even though the build
// copies it into dist/ and nginx serves it in prod. Serve it directly in dev
// so the /docs → Redoc link works everywhere.
const servePublicHtml = (): Plugin => ({
  name: 'serve-public-html',
  configureServer(server) {
    server.middlewares.use('/api-docs.html', (_req, res, next) => {
      try {
        res.setHeader('content-type', 'text/html')
        res.end(readFileSync(fileURLToPath(new URL('./public/api-docs.html', import.meta.url))))
      } catch {
        next()
      }
    })
  },
})

export default defineConfig({
  // sub-path deploys (e.g. m3rcyzzz.club/robots): WEB_BASE=/robots/ pnpm build
  base: process.env.WEB_BASE || '/',
  plugins: [react(), tailwindcss(), servePublicHtml()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      // Only the go2rtc playback WebSocket (MSE/WebRTC signalling) — scoped so
      // `host: true` doesn't expose the go2rtc management API (/stream/api/streams,
      // /stream/api/config) to the LAN. Prod proxies /stream via nginx instead.
      '/stream/api/ws': {
        target: 'http://127.0.0.1:1984',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/stream/, ''),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    // Vite 8 / Rolldown: manualChunks is gone — advancedChunks replaces it.
    // Keep the heavy 3D stack (three + urdf) in its own chunk so it stays
    // behind the React.lazy boundary.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [{ name: 'three', test: /node_modules\/(three|urdf-loader)\// }],
        },
      },
    },
  },
})
