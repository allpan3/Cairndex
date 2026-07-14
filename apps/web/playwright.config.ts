import { defineConfig, devices } from '@playwright/test'

const webPort = Number(process.env.CAIRNDEX_PLAYWRIGHT_PORT ?? 5173)
const webUrl = `http://127.0.0.1:${webPort}`

// E2E tests boot their own Vite dev server. Browser-only tests intercept API
// traffic, while @fullstack tests start an isolated backend explicitly.
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
