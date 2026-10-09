import type { Page } from '@playwright/test'

// Hermetic UI fixtures expose a synthetic read basis; real backend tests verify clock enforcement
export const METADATA_REPLY = {
  headers: { 'X-Cairndex-Basis': `${'a'.repeat(32)}:0:${'b'.repeat(32)}:0` },
}

// Healthy UI fixtures implement the revision poll as well as content read headers.
export async function mockMetadataRevision(page: Page): Promise<void> {
  await page.route('**/api/v1/libraries/*/metadata', (route) =>
    route.fulfill({
      ...METADATA_REPLY,
      json: { basis: METADATA_REPLY.headers['X-Cairndex-Basis'] },
    }),
  )
}
