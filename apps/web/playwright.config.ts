import { defineConfig, devices } from '@playwright/test'

const webPort = Number(process.env.CAIRNDEX_PLAYWRIGHT_PORT ?? 5173)
const webUrl = `http://127.0.0.1:${webPort}`

// E2E tests boot their own Vite dev server. They do not require the backend to
// be running: the health probe simply renders the "unreachable" state, which
// is itself a state worth asserting. Tests that need a live backend will start
// it explicitly in a later milestone.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: webUrl,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
    url: webUrl,
    reuseExistingServer: !process.env.CI && process.env.CAIRNDEX_PLAYWRIGHT_PORT === undefined,
    timeout: 120_000,
  },
})
