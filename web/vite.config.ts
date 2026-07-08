import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/stream': {
        target: 'http://127.0.0.1:1984',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/stream/, ''),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
})
