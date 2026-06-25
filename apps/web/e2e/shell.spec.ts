import { expect, test } from '@playwright/test'

test('renders the Cairndex app shell', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Cairndex' })).toBeVisible()
  await expect(page.getByText('Local-first media asset manager')).toBeVisible()

  // The backend status resolves to one of the known states (online if a server
  // is up, unreachable otherwise) — either is a successfully rendered shell.
  await expect(page.getByRole('status')).toBeVisible()
})
