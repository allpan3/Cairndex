import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopBridge, desktopMenu } from './desktopBridge'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

const create = (baseUrl: string, root: string, name: string) =>
  apiPost<{ id: string }>(baseUrl, '/api/v1/libraries/create', {
    root_path: root,
    display_name: name,
    create_if_missing: true,
  })

// The registry's own record, read past the page
async function writeMode(baseUrl: string, libraryId: string) {
  const rows = (await (await fetch(`${baseUrl}/api/v1/libraries`)).json()) as {
    id: string
    write_mode_enabled: boolean
  }[]
  return rows.find((row) => row.id === libraryId)?.write_mode_enabled
}

// Shown whole: inside the window, and on top at every corner, so nothing clips or covers it
async function expectInWindow(page: Page, tip: Locator) {
  await expect(tip).toBeVisible()
  const box = (await tip.boundingBox())!
  const { width, height } = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width)
  expect(box.y + box.height).toBeLessThanOrEqual(height)
  // Inside the rounded corners
  const corners: [number, number][] = [
    [box.x + 4, box.y + 4],
    [box.x + box.width - 4, box.y + 4],
    [box.x + 4, box.y + box.height - 4],
    [box.x + box.width - 4, box.y + box.height - 4],
  ]
  for (const point of corners) {
    const onTop = await tip.evaluate(
      (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
      point,
    )
    expect(onTop).toBe(true)
  }
}

test('write mode asks before turning on, and settings open over an intact list @fullstack', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-library-settings-e2e-'))
  const backend = await startBackend(join(scratch, 'private'))
  try {
    // Beta first: the registry lists the newest first, so the app opens Alpha
    const beta = await create(backend.baseUrl, join(scratch, 'Beta'), 'Synthetic Beta')
    const alpha = await create(backend.baseUrl, join(scratch, 'Alpha'), 'Synthetic Alpha')
    // Protected from outside this browser, which therefore finds Beta locked
    const guarded = await fetch(`${backend.baseUrl}/api/v1/libraries/${beta.id}/auth/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'Synthetic guard', current_passphrase: null }),
    })
    expect(guarded.ok).toBe(true)
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toHaveValue(alpha.id)
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    const list = page.getByRole('dialog', { name: 'Libraries', exact: true })

    // Turning on asks first, with focus on the safe choice
    const alphaMode = list.getByRole('button', {
      name: 'Write mode for Synthetic Alpha',
      exact: true,
    })
    await expect(alphaMode).toHaveAttribute('aria-pressed', 'false')
    await alphaMode.click()
    const askAlpha = list.getByRole('form', {
      name: 'Turn on write mode for Synthetic Alpha',
      exact: true,
    })
    await expect(askAlpha.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await askAlpha.getByRole('button', { name: 'Turn on', exact: true }).click()
    await expect(alphaMode).toHaveText('Write mode: on')
    await expect(alphaMode).toBeFocused()
    expect(await writeMode(backend.baseUrl, alpha.id)).toBe(true)

    // The server asks for a protected library's passphrase; a wrong one keeps the step
    const betaMode = list.getByRole('button', {
      name: 'Write mode for Synthetic Beta',
      exact: true,
    })
    await betaMode.click()
    const askBeta = list.getByRole('form', {
      name: 'Turn on write mode for Synthetic Beta',
      exact: true,
    })
    await askBeta.getByRole('button', { name: 'Turn on', exact: true }).click()
    const passphrase = askBeta.getByLabel('Passphrase for Synthetic Beta', { exact: true })
    await passphrase.fill('Not the guard')
    await askBeta.getByRole('button', { name: 'Turn on', exact: true }).click()
    await expect(askBeta.getByRole('alert')).toHaveText('That passphrase was not accepted.')
    expect(await writeMode(backend.baseUrl, beta.id)).toBe(false)
    await passphrase.fill('Synthetic guard')
    await askBeta.getByRole('button', { name: 'Turn on', exact: true }).click()
    await expect(betaMode).toHaveText('Write mode: on')
    expect(await writeMode(backend.baseUrl, beta.id)).toBe(true)

    // Still locked in this browser, so turning off takes the passphrase too
    await betaMode.click()
    const offBeta = list.getByRole('form', {
      name: 'Turn off write mode for Synthetic Beta',
      exact: true,
    })
    await offBeta
      .getByLabel('Passphrase for Synthetic Beta', { exact: true })
      .fill('Synthetic guard')
    await offBeta.getByRole('button', { name: 'Turn off', exact: true }).click()
    await expect(betaMode).toHaveText('Write mode: off')
    expect(await writeMode(backend.baseUrl, beta.id)).toBe(false)

    // For review: write mode on for one library and off for the other. Their
    // roots are absolute temporary paths, so those are masked.
    await page.mouse.move(0, 0)
    await page.screenshot({
      path: test.info().outputPath('synthetic-libraries-write-mode.png'),
      mask: [list.locator('.lib-row__path')],
    })

    // In a short window the settings stay inside it and scroll their own body,
    // under a title and Back that stay put
    await page.setViewportSize({ width: 1000, height: 420 })
    const opener = list.getByRole('button', { name: 'Settings for Synthetic Alpha', exact: true })
    await opener.click()
    const settings = page.getByRole('dialog', { name: 'Synthetic Alpha settings', exact: true })
    await expect(
      settings.getByText('Passphrase protection is off.', { exact: false }),
    ).toBeVisible()
    await expect(list).toBeHidden()
    const bounds = await settings.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420)
    const body = settings.locator('.library-settings__body')
    expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    const prepare = settings.getByRole('button', {
      name: 'Prepare separate recovery',
      exact: true,
    })
    await prepare.scrollIntoViewIfNeeded()
    await expect(prepare).toBeInViewport()
    await expect(prepare).toBeDisabled()
    await expect(
      settings.getByRole('button', { name: 'Back to libraries', exact: true }),
    ).toBeInViewport()

    // The explanations are not clipped by that body. Tab from Back reaches the
    // first. The pointer waits on the backdrop, so only focus opens them.
    await page.mouse.move(0, 0)
    const tooltip = page.getByRole('tooltip')
    await page.keyboard.press('Tab')
    await expect(
      settings.getByRole('button', { name: 'About access on this server', exact: true }),
    ).toBeFocused()
    await expectInWindow(page, tooltip)

    // Scrolled out of the body, the text goes with its button and comes back with it
    await body.evaluate((node) => node.scrollTo(0, node.scrollHeight))
    await expect(tooltip).toHaveCount(0)
    await body.evaluate((node) => node.scrollTo(0, 0))
    await expectInWindow(page, tooltip)

    // The longest explanation, whole in the short window, and captured for review
    await settings.getByRole('button', { name: 'About recovery', exact: true }).focus()
    await expect(tooltip).toContainText('Original stores stay intact.')
    await expectInWindow(page, tooltip)
    await page.screenshot({ path: test.info().outputPath('synthetic-settings-tooltip.png') })

    // Escape puts the text away and leaves the settings open
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(settings).toBeVisible()

    // Escape returns to the list as it was, with focus on the button that left it
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(list).toBeVisible()
    await expect(opener).toBeFocused()
    await expect(alphaMode).toHaveText('Write mode: on')

    // Opening another library closes the list, and its settings do not reopen with it
    await page.setViewportSize({ width: 1280, height: 720 })
    await list.getByRole('button', { name: 'Open Synthetic Beta', exact: true }).click()
    await expect(list).toHaveCount(0)
    await page.getByLabel('Owner passphrase', { exact: true }).fill('Synthetic guard')
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toHaveValue(beta.id)
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await expect(list).toBeVisible()
    await expect(page.getByRole('dialog', { name: / settings$/ })).toHaveCount(0)
    const betaOpener = list.getByRole('button', {
      name: 'Settings for Synthetic Beta',
      exact: true,
    })
    await betaOpener.click()
    const betaSettings = page.getByRole('dialog', { name: 'Synthetic Beta settings', exact: true })
    await expect(
      betaSettings.getByText('Passphrase protection is on.', { exact: false }),
    ).toBeVisible()
    // In a narrow window the text moves in from the edge instead of being cut off
    await page.setViewportSize({ width: 360, height: 640 })
    await betaSettings.getByRole('button', { name: 'About private backups', exact: true }).focus()
    await expectInWindow(page, tooltip)
    await page.setViewportSize({ width: 1280, height: 720 })
    await betaSettings.getByRole('button', { name: 'Back to libraries', exact: true }).click()
    await expect(betaOpener).toBeFocused()

    // Turning off is one click
    await alphaMode.click()
    await expect(alphaMode).toHaveText('Write mode: off')
    expect(await writeMode(backend.baseUrl, alpha.id)).toBe(false)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('write mode belongs to each server, and settings stay on the server they opened on @fullstack', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-library-servers-e2e-'))
  const backends: Awaited<ReturnType<typeof startBackend>>[] = []
  try {
    backends.push(
      await startBackend(join(scratch, 'server-a'), { CAIRNDEX_CORS_EXTRA_ORIGINS: baseURL! }),
    )
    backends.push(
      await startBackend(join(scratch, 'server-b'), {
        CAIRNDEX_CORS_EXTRA_ORIGINS: baseURL!,
        CAIRNDEX_WRITE_MODE: 'disabled',
      }),
    )
    const [a, b] = backends.map((backend) => backend.baseUrl)
    const alpha = await create(a, join(scratch, 'Alpha'), 'Synthetic Alpha')
    await create(b, join(scratch, 'Gamma'), 'Synthetic Gamma')
    await desktopBridge(page, [a, b])
    await page.goto('/')

    // Through the normal visible control, as connections.spec does
    async function choose(url: string) {
      await desktopMenu(page, 'servers')
      const servers = page.getByRole('dialog', { name: 'Servers' })
      await servers
        .getByRole('button', { name: new RegExp(new URL(url).host.replaceAll('.', '\\.')) })
        .click()
      await expect(servers).not.toBeVisible()
    }
    const list = page.getByRole('dialog', { name: 'Libraries', exact: true })
    const settings = page.getByRole('dialog', { name: / settings$/ })
    const alphaMode = list.getByRole('button', {
      name: 'Write mode for Synthetic Alpha',
      exact: true,
    })

    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await alphaMode.click()
    await list.getByRole('button', { name: 'Turn on', exact: true }).click()
    await expect(alphaMode).toHaveText('Write mode: on')
    await list.getByRole('button', { name: 'Settings for Synthetic Alpha', exact: true }).click()
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: 'About access on this server', exact: true }).focus()
    await expect(page.getByRole('tooltip')).toBeVisible()

    // Another server: its own libraries and rule, and nothing carried over
    await choose(b)
    await expect(settings).toHaveCount(0)
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    const gammaMode = list.getByRole('button', {
      name: 'Write mode for Synthetic Gamma',
      exact: true,
    })
    await expect(gammaMode).toHaveAccessibleDescription('This server does not allow write mode.')
    await expect(gammaMode).toBeDisabled()
    await expect(alphaMode).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)

    // Back on the first server, its switch is still on and the settings stayed closed
    await choose(a)
    await page.getByRole('button', { name: 'Manage libraries', exact: true }).click()
    await expect(alphaMode).toHaveText('Write mode: on')
    await expect(settings).toHaveCount(0)
    await alphaMode.click()
    await expect(alphaMode).toHaveText('Write mode: off')
    expect(await writeMode(a, alpha.id)).toBe(false)
    expect(pageErrors).toEqual([])
  } finally {
    await page.close()
    for (const backend of backends) await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
