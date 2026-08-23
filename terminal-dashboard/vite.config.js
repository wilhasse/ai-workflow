import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api/codex': {
        target: 'http://127.0.0.1:5006',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/codex/, ''),
      },
    },
  },
})
