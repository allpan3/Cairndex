import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

// Update and partial acceptance use a real worker, disposable media and ordinary HTTP
for (const loseResponse of [false, true])
  test(`Update partial acceptance ${loseResponse ? 'recovers a lost response' : 'retains the remaining review'} @fullstack`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const scratch = await mkdtemp(join(tmpdir(), 'cairndex-update-recovery-'))
    const backend = await startBackend(join(scratch, 'server'), { CAIRNDEX_WORKER_ENABLED: 'true' })
    try {
      const root = join(scratch, 'library')
      const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
        root_path: root,
        display_name: 'Synthetic recovery',
        create_if_missing: true,
      })
      // A generated solid-color PNG exercises discovery and real image probing
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAK0lEQVR4nGP8v5SBKoCJOsYwjBpEBBgNbMJgNIwIg9EwIgxGw4gwGHxhBADj1AHUKI6DoQAAAABJRU5ErkJggg==',
        'base64',
      )
      for (const name of ['Amber', 'Blue']) {
        await mkdir(join(root, name))
        await writeFile(join(root, name, `${name}.png`), png)
      }
      const base = `${backend.baseUrl}/api/v1/libraries/${library.id}`
      await proxyApi(page, backend.baseUrl)
      await page.goto('/')
      await page.getByRole('button', { name: /Update$/ }).click()
      const dialog = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: 'Suggest grouping', exact: true }),
      })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.grp-row--bundle')).toHaveCount(2)
      const checkboxes = dialog.locator('.grp-row--bundle input[type=checkbox]')
      await checkboxes.nth(1).uncheck()
      const plans = (await (await fetch(`${base}/grouping/plans`)).json()) as { id: string }[]
      const planUrl = `${base}/grouping/plans/${plans[0]!.id}`
      let lost = false
      if (loseResponse) {
        await page.route('**/grouping/plans/*/apply', async (route) => {
          if (lost) return route.fallback()
          lost = true
          const request = route.request()
          const saved = await fetch(`${planUrl}/apply`, {
            method: 'POST',
            headers: request.headers(),
            body: request.postData(),
          })
          expect(saved.status).toBe(200)
          await route.abort('failed')
        })
      }
      await dialog.getByRole('button', { name: /^Accept / }).click()
      if (loseResponse) {
        await expect(page.getByRole('button', { name: 'Review unsaved edit 1' })).toBeVisible()
        const review = page.getByRole('dialog', { name: 'Review metadata edit' })
        await expect(review).toBeVisible()
        await review.getByRole('button', { name: 'Retry save' }).click()
        await expect(review).toBeHidden()
      }
      await expect
        .poll(async () => {
          const plan = (await (await fetch(planUrl)).json()) as { proposals: { kind: string }[] }
          return plan.proposals.filter((p) => p.kind === 'bundle').length
        })
        .toBe(1)
      await expect(dialog.locator('.grp-row--bundle')).toHaveCount(1)
      await dialog.locator('.grp-row--bundle input[type=checkbox]').check()
      await dialog.getByRole('button', { name: /^Accept / }).click()
      await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Done', exact: true }).click()
      await page.reload()
      await expect(page.locator('.card')).toHaveCount(2)
      const counts = (await (await fetch(`${base}/bundles/counts`)).json()) as {
        all: number
        unbundled: number
      }
      expect(counts.all).toBe(2)
      expect(counts.unbundled).toBe(0)
    } finally {
      await page.close()
      await stopBackend(backend.child)
      await rm(scratch, { recursive: true, force: true })
    }
  })
