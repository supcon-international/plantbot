import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // sub-path deploys (e.g. m3rcyzzz.club/robots): WEB_BASE=/robots/ pnpm build
  base: process.env.WEB_BASE || '/',
  plugins: [react(), tailwindcss()],
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
    rollupOptions: {
      output: {
        manualChunks: {
          // heavy 3D stack loads on demand behind React.lazy
          three: ['three', '@mkkellogg/gaussian-splats-3d', 'urdf-loader'],
        },
      },
    },
  },
})
