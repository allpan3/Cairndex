import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend, stopBackend } from './realBackend'

// The production entry and desktop adapter run unchanged; only native IPC is simulated in Chromium
async function desktopBridge(page: Page, urls: string[]) {
  await page.addInitScript(
    ({ urls }) => {
      const settings = 'synthetic-native-settings'
      if (!localStorage.getItem(settings))
        localStorage.setItem(
          settings,
          JSON.stringify({
            connections: {
              connections: urls.slice(0, 2).map((url) => ({
                id: `remote:${url}`,
                kind: 'remote',
                label: new URL(url).host,
                serverUrl: url,
              })),
              activeConnectionId: `remote:${urls[0]}`,
            },
          }),
        )
      let callback = 0
      Object.assign(window, {
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          transformCallback: () => ++callback,
          unregisterCallback: () => undefined,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            const values = JSON.parse(localStorage.getItem(settings)!) as Record<string, unknown>
            if (command === 'plugin:store|load') return 1
            if (command === 'plugin:store|get')
              return [values[String(args.key)], String(args.key) in values]
            if (command === 'plugin:store|set') {
              values[String(args.key)] = args.value
              localStorage.setItem(settings, JSON.stringify(values))
            }
            if (command === 'plugin:store|delete') {
              delete values[String(args.key)]
              localStorage.setItem(settings, JSON.stringify(values))
            }
            if (command === 'normalize_server_url_command')
              return String(args.value).replace(/\/+$/, '')
            if (command === 'configure_media_proxy') return 'http://127.0.0.1:9/synthetic-relay'
            if (command === 'start_local_server')
              return { base_url: urls[2], token: 'synthetic-local-token' }
            if (command === 'plugin:event|listen') return ++callback
            if (command === 'is_window_fullscreen') return false
            return null
          },
        },
      })
    },
    { urls },
  )
}

// Real independent HTTP servers prove duplicate portable identity and private drafts across one active desktop session
test('local and two remote connections preserve drafts, restart intent and cancelled targets @fullstack', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-switch-e2e-'))
  const roots = ['A', 'B', 'Local'].map((name) => join(scratch, name))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_fixture import create_fixture; create_fixture(Path(sys.argv[1]))',
      roots[0],
    ],
    { cwd: serverDir },
  )
  await cp(roots[0], roots[1], { recursive: true })
  await cp(roots[0], roots[2], { recursive: true })
  const backends: Awaited<ReturnType<typeof startBackend>>[] = []
  try {
    for (let i = 0; i < 3; i++)
      backends.push(
        await startBackend(join(scratch, `server-${i}`), {
          CAIRNDEX_CORS_EXTRA_ORIGINS: baseURL!,
          ...(i === 2 ? { CAIRNDEX_LOCAL_TOKEN: 'synthetic-local-token' } : {}),
        }),
      )
    const libraries: { id: string; library_uuid: string }[] = []
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${backends[i].baseUrl}/api/v1/libraries/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(i === 2 ? { Authorization: 'Bearer synthetic-local-token' } : {}),
        },
        body: JSON.stringify({ root_path: roots[i] }),
      })
      expect(response.ok).toBe(true)
      libraries.push(await response.json())
    }
    expect(new Set(libraries.map((library) => library.library_uuid)).size).toBe(1)
    const urls = backends.map((backend) => backend.baseUrl)
    await desktopBridge(page, urls)
    await page.goto('/')
    const title = page.getByLabel('Bundle title', { exact: true })
    await expect(title).toHaveValue('Synthetic bundle')
    await title.fill('Unsent on the first server')

    // Choose servers through the normal visible controls, including the managed-local choice
    async function choose(index: number) {
      await page.getByRole('button', { name: 'Servers…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Servers' })
      await dialog
        .getByRole('button', {
          name:
            index === 2
              ? /This Computer/
              : new RegExp(new URL(urls[index]).host.replaceAll('.', '\\.')),
        })
        .click()
      await expect(dialog).not.toBeVisible()
    }
    await choose(1)
    await expect(title).toHaveValue('Synthetic bundle')
    await title.fill('Saved on the second server')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Saved here', { exact: true })).toBeVisible()
    await choose(2)
    await expect(title).toHaveValue('Synthetic bundle')
    await choose(0)
    await expect(title).toHaveValue('Unsent on the first server')
    await page.reload()
    await expect(title).toHaveValue('Unsent on the first server')
    await expect(page.locator('.connection-bar')).toContainText(new URL(urls[0]).host)

    // An aborted preparation cannot commit when its delayed health response finally arrives
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`${urls[1]}/api/v1/health`, async (route) => {
      await held
      await route
        .fulfill({
          json: { status: 'ok', app_name: 'Cairndex', api_features: ['pairing', 'progress'] },
        })
        .catch(() => undefined)
    })
    await page.getByRole('button', { name: 'Servers…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Servers' })
    await dialog
      .getByRole('button', { name: new RegExp(new URL(urls[1]).host.replaceAll('.', '\\.')) })
      .click()
    await dialog.getByRole('button', { name: 'Cancel connection' }).click()
    await expect(dialog.getByRole('alert')).toContainText('cancelled')
    release()
    await page.keyboard.press('Escape')
    await expect(title).toHaveValue('Unsent on the first server')
    await page.unroute(`${urls[1]}/api/v1/health`)

    // Adding an incompatible server keeps the current destination and draft
    await page.route('http://127.0.0.1:9/api/v1/health', (route) =>
      route.fulfill({ json: { status: 'ok' } }),
    )
    await page.getByRole('button', { name: 'Servers…' }).click()
    await dialog.getByLabel('Add a server').fill('http://127.0.0.1:9')
    await dialog.getByRole('button', { name: 'Add and connect' }).click()
    await expect(dialog.getByRole('alert')).toContainText('not a compatible')
    await page.keyboard.press('Escape')
    await expect(title).toHaveValue('Unsent on the first server')

    // A cold outage retains the intended server, with the saved alternative still reachable
    await stopBackend(backends[0].child)
    await page.reload()
    await expect(page.getByLabel('Server URL')).toHaveValue(urls[0])
    await choose(1)
    await expect(title).toHaveValue('Saved on the second server')
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(title).toHaveValue('Saved on the second server')

    expect(pageErrors).toEqual([])
  } finally {
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})

// A client-side alias can reach the owner when its advertised address cannot.
test('ownership redirect recovers through a saved address without changing library identity @fullstack', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-owner-address-e2e-'))
  const backends: Awaited<ReturnType<typeof startBackend>>[] = []
  const advertised = 'http://unavailable.example:8000'
  const takeoverRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/ownership/takeover')) takeoverRequests.push(request.url())
  })
  async function create(server: string, name: string) {
    const response = await fetch(`${server}/api/v1/libraries/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root_path: join(scratch, name),
        display_name: name,
        create_if_missing: true,
      }),
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string; library_uuid: string }
  }
  try {
    for (let i = 0; i < 3; i++) {
      backends.push(
        await startBackend(join(scratch, `state-${i}`), {
          CAIRNDEX_CORS_EXTRA_ORIGINS: baseURL!,
          CAIRNDEX_ADVERTISED_URL: i === 1 ? advertised : '',
          CAIRNDEX_MACHINE_NAME: `Synthetic server ${i}`,
        }),
      )
    }
    const [observer, holder, unrelated] = backends.map((item) => item.baseUrl)
    await create(holder, 'Other holder library')
    const library = await create(holder, 'Shared test library')
    expect((await fetch(`${holder}/api/v1/libraries/${library.id}/collections`)).status).toBe(200)
    await create(unrelated, 'Unrelated library')
    const registration = await fetch(`${observer}/api/v1/libraries/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_path: join(scratch, 'Shared test library') }),
    })
    expect(registration.ok).toBe(true)
    await desktopBridge(page, [observer, holder, observer])
    await page.route(`${advertised}/api/v1/health`, (route) => route.abort('connectionfailed'))
    await page.goto('/')
    await expect(page.getByText('This library is open on Synthetic server 1')).toBeVisible()
    await page.getByRole('button', { name: 'Connect to Synthetic server 1' }).click()
    await expect(page.locator('.lockscreen').getByRole('alert')).toContainText('did not respond')
    await expect(page.locator('.connection-bar')).toContainText(new URL(observer).host)

    // A compatible server with a different library must not replace the destination.
    const address = page.getByRole('textbox', { name: 'Server address' })
    await address.fill(unrelated)
    await address.press('Enter')
    await expect(page.locator('.lockscreen').getByRole('alert')).toContainText('does not list')
    await expect(page.locator('.connection-bar')).toContainText(new URL(observer).host)

    await page.getByRole('combobox', { name: 'Saved server address' }).selectOption(holder)
    await page.screenshot({ path: test.info().outputPath('ownership-address-recovery.png') })
    await address.press('Enter')
    await expect(page.locator('.connection-bar')).toContainText(new URL(holder).host)
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toHaveValue(
      library.id,
    )
    await expect(page.getByText('This library is open on Synthetic server 1')).not.toBeVisible()
    expect(takeoverRequests).toEqual([])
    await page.reload()
    await expect(page.locator('.connection-bar')).toContainText(new URL(holder).host)
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toHaveValue(
      library.id,
    )
  } finally {
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})
