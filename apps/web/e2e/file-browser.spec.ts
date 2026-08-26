import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the read-only File Browser: switch surfaces, list the active
// library's files, see openable/unsupported/unlinked/unbundled badges, and
// navigate into a directory. No backend required (ADR-0008: File Browser is
// library-scoped).

function entry(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    relative_path: name,
    kind: 'file',
    size_bytes: 1024,
    modified_at: '2026-06-25T00:00:00Z',
    extension: name.split('.').pop(),
    mime_type: null,
    media_kind: null,
    supported: false,
    linked: false,
    bundle_id: null,
    unbundled: false,
    ...over,
  }
}

async function mockApi(page: Page) {
  const previewRequests: string[] = []
  let missingBundles = 0
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'NAS Media', root_path: '/mnt/media', status: 'available' }],
    }),
  )
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/ownership', (r) => r.fulfill({ json: { state: 'own', mountable: true } }))
  // Collection-View endpoints the shell loads on mount.
  await page.route('**/bundles/counts**', (r) =>
    r.fulfill({
      json: {
        all: 0,
        recent: 0,
        uncategorized: 0,
        untagged: 0,
        missing: missingBundles,
        unbundled: 0,
      },
    }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts**', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({
      json: {
        // One bundle, whose file on disk sits in the mocked `Show` folder — the
        // fixture "Locate in File Browser" navigates to.
        items: [
          {
            id: 'b1',
            title: 'Bundle One',
            rating: null,
            file_count: 1,
            total_size: 1024,
            has_missing: false,
            has_cover: false,
            cover_key: null,
            media_kind: 'video',
            width: null,
            height: null,
            duration: null,
            extension: 'mp4',
            date_added: '2026-06-25T00:00:00Z',
            grouping_state: 'confirmed',
            primary_relative_path: 'Show/clip.mp4',
          },
        ],
        total: 1,
        offset: 0,
        limit: 100,
      },
    }),
  )

  await page.route('**/file-browser/entries**', (r) => {
    const url = new URL(r.request().url())
    const path = url.searchParams.get('path') ?? ''
    if (path === 'Show') {
      missingBundles = 1
      r.fulfill({
        json: {
          path: 'Show',
          missing_files_updated: 2,
          entries: [
            entry('clip.mp4', {
              relative_path: 'Show/clip.mp4',
              kind: 'file',
              media_kind: 'video',
              supported: true,
            }),
            entry('art.jpg', {
              relative_path: 'Show/art.jpg',
              media_kind: 'image',
              supported: true,
            }),
          ],
        },
      })
    } else {
      r.fulfill({
        json: {
          path: '',
          missing_files_updated: 0,
          entries: [
            entry('Show', { relative_path: 'Show', kind: 'directory', size_bytes: null }),
            entry('poster.jpg', {
              media_kind: 'image',
              supported: true,
              linked: true,
              bundle_id: 'b1',
              unbundled: true,
            }),
            entry('scan.tiff', {
              media_kind: 'image',
              supported: true,
              mime_type: 'image/tiff',
            }),
            entry('song.mp3', {
              media_kind: 'audio',
              supported: true,
              mime_type: 'audio/mpeg',
            }),
            entry('notes.txt', { supported: false }),
          ],
        },
      })
    }
  })
  // Minimal 16-bit PCM WAV (a beat of silence) so the audio element, which
  // fetches real bytes, gets something Chromium can decode.
  const wav = Buffer.alloc(44 + 3200)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + 3200, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16) // PCM fmt chunk size
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(1, 22) // mono
  wav.writeUInt32LE(8000, 24) // sample rate
  wav.writeUInt32LE(16000, 28) // byte rate
  wav.writeUInt16LE(2, 32) // block align
  wav.writeUInt16LE(16, 34) // bits per sample
  wav.write('data', 36)
  wav.writeUInt32LE(3200, 40)
  await page.route('**/file?path=song.mp3', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: wav }),
  )
  await page.route('**/file/preview?*', (r) => {
    previewRequests.push(r.request().url())
    return r.fulfill({
      status: 200,
      contentType: 'image/webp',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    })
  })
  return previewRequests
}

// Deliberately narrower than the default. The Back/Forward control shares the
// toolbar's leading slot with this breadcrumb, and at this width a deep trail
// overflows — which used to leave the root crumb painted nowhere but still
// hit-testing to the toolbar, so it could not be clicked. CI's wider fonts hit
// it first; the default viewport never did.
test.use({ viewport: { width: 1180, height: 800 } })

test('browses a library read-only with badges and breadcrumbs', async ({ page }) => {
  const previewRequests = await mockApi(page)
  await page.goto('/')

  // Switch to the File Browser surface.
  await page.getByRole('tab', { name: 'Files' }).click()
  const missingView = page.getByRole('button', { name: /Missing Files/ })
  await expect(missingView.locator('.nav-item__count')).toHaveText('0')

  // The shared library selector (in the sidebar) + entries with badges.
  await expect(page.locator('.sidebar__library-select')).toHaveValue('lib1')
  await expect(page.locator('.file-row__name', { hasText: 'Show' })).toBeVisible()
  // The "openable" badge was removed; only attention badges remain.
  await expect(
    page.locator('.file-row', { hasText: 'poster.jpg' }).getByText('openable'),
  ).toHaveCount(0)
  await expect(page.locator('.file-row', { hasText: 'poster.jpg' })).toContainText('unbundled')
  await expect(page.locator('.file-row__name', { hasText: 'scan.tiff' })).toBeVisible()
  await expect(page.locator('.file-row', { hasText: 'notes.txt' })).toContainText('unsupported')
  await expect(page.locator('.file-row', { hasText: 'notes.txt' })).toContainText('unlinked')

  // No destructive controls in this milestone.
  await expect(page.getByRole('button', { name: /delete|rename|move/i })).toHaveCount(0)

  // Navigate into a directory (double-click); breadcrumb updates and the
  // nested file shows. Single-click only selects (drives the inspector).
  await page.locator('.file-row__name', { hasText: 'Show' }).dblclick()
  await expect(page.locator('.file-browser__crumbs')).toContainText('Show')
  await expect(page.locator('.file-row__name', { hasText: 'clip.mp4' })).toBeVisible()
  await expect(page.locator('.file-row', { hasText: 'clip.mp4' })).toContainText('unlinked')
  await expect(page.locator('.file-row', { hasText: 'art.jpg' })).toContainText('unlinked')
  await expect(missingView.locator('.nav-item__count')).toHaveText('1')

  // Selecting the file shows its details in the inspector (not the bundle one).
  await page.locator('.file-row__name', { hasText: 'clip.mp4' }).click()
  await expect(page.locator('.inspector')).toContainText('Openable')

  await page.getByRole('button', { name: 'NAS Media' }).click()
  await page.locator('.file-row__name', { hasText: 'scan.tiff' }).dblclick()
  // The File Browser opens the same viewer the Bundle Browser uses, so this is
  // the shared image stage rather than a bare <img> lightbox.
  await expect(page.locator('.mv-image')).toBeVisible()
  await expect.poll(() => previewRequests.some((url) => url.includes('path=scan.tiff'))).toBe(true)

  // Audio is openable too, on the native element sourced from its path.
  await page.keyboard.press('Escape')
  await page.locator('.file-row__name', { hasText: 'song.mp3' }).dblclick()
  const audio = page.getByTestId('media-audio')
  await expect(audio).toBeVisible()
  await expect(audio).toHaveAttribute('src', /file\?path=song\.mp3/)
})

test('a bundle locates its own folder in the File Browser', async ({ page }) => {
  // The inverse of the File Browser's "Locate in Bundle Browser", asked for by
  // the owner (2026-08-26). It navigates inside Cairndex rather than handing the
  // path to the OS, so unlike Open/Reveal it is offered on the web too.
  await mockApi(page)
  await page.goto('/')

  const card = page.locator('[data-bundle-id]').first()
  await expect(card).toBeVisible()
  await card.click({ button: 'right' })
  await page.locator('.context-menu__item', { hasText: 'Locate in File Browser' }).click()

  // Landed on the Files surface, inside the folder holding the bundle's file.
  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.file-browser__crumbs')).toContainText('Show')
  // And on the file itself, not merely the folder around it: `locatedPath` feeds
  // the same selected-row highlight a click produces.
  await expect(page.locator('.file-row--selected')).toContainText('clip.mp4')
})
