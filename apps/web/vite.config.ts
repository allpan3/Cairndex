import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The backend serves everything under /api/v1. In development the Vite dev
// server proxies /api to the FastAPI app so the frontend can use same-origin
// relative URLs and never needs CORS configuration (see docs/development.md).
const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    // Honor an externally assigned port (preview/CI tooling); default 5173
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Vitest runs unit/component tests under src; Playwright owns e2e/.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: true,
  },
})
