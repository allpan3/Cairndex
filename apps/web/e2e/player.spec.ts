import { expect, test, type Page } from '@playwright/test'

// Hermetic mock for the player: a bundle with one playable video + one
// subtitle track, plus an unplayable second video to assert the fallback.

function summary(id: string, title: string) {
  return {
    id,
    title,
    rating: 0,
    file_count: 1,
    total_size: 0,
    has_missing: false,
    has_cover: false,
    media_kind: 'video',
    width: null,
    height: null,
    duration: null,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
  }
}

async function mockApi(page: Page) {
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [{ id: 'lib1', name: 'Test Library', root_path: '/srv/lib', status: 'available' }],
    }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({ json: { all: 1, recent: 1, uncategorized: 1, untagged: 1, missing: 0 } }),
  )
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [summary('b0', 'Movie 0')], total: 1, offset: 0, limit: 100 } }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/tag-groups?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/tags/counts', (r) => r.fulfill({ json: { counts: {} } }))

  await page.route('**/bundles/b0/files', (r) =>
    r.fulfill({
      json: [
        {
          id: 'f0',
          display_title: 'movie.mp4',
          role: 'primary_video',
          media_kind: 'video',
          size_bytes: 0,
          tech_metadata: {},
        },
      ],
    }),
  )
  await page.route('**/bundles/b0/collections', (r) =>
    r.fulfill({ json: { bundle_id: 'b0', collection_ids: [] } }),
  )
  await page.route('**/bundles/b0/tags', (r) =>
    r.fulfill({ json: { bundle_id: 'b0', tag_ids: [] } }),
  )
  await page.route('**/bundles/b0', (r) =>
    r.fulfill({
      json: {
        id: 'b0',
        title: 'Movie 0',
        note: null,
        rating: 0,
        cover_file_id: null,
        primary_file_id: null,
        created_at: '2026-06-25T00:00:00Z',
        imported_at: '2026-06-25T00:00:00Z',
        updated_at: '2026-06-25T00:00:00Z',
      },
    }),
  )
  await page.route('**/bundles/b0/playback', (r) =>
    r.fulfill({
      json: {
        bundle_id: 'b0',
        videos: [
          {
            file_id: 'f0',
            display_title: 'movie.mp4',
            playable: true,
            reason: '',
            mime_type: 'video/mp4',
            stream_url: '/api/v1/files/f0/stream',
            width: 1920,
            height: 1080,
            duration: 1,
            subtitles: [
              {
                id: 's0',
                language: 'en',
                label: 'EN',
                format: 'srt',
                is_default: true,
                is_forced: false,
                kind: 'external',
                src: '/api/v1/subtitles/s0/vtt',
              },
            ],
          },
          {
            file_id: 'f1',
            display_title: 'movie.mkv',
            playable: false,
            reason: "MKV container isn't playable in browsers",
            mime_type: 'video/x-matroska',
            stream_url: '/api/v1/files/f1/stream',
            width: null,
            height: null,
            duration: null,
            subtitles: [],
          },
        ],
      },
    }),
  )
}

test('plays a video with a subtitle track and shows a fallback', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.locator('.card').first().click()

  await page.locator('.inspector__play').click({ force: true })

  // Playable video renders a <video> with the streamed source + a <track>.
  const video = page.locator('.player__video')
  await expect(video).toHaveAttribute('src', '/api/v1/files/f0/stream')
  await expect(video.locator('track')).toHaveAttribute('src', '/api/v1/subtitles/s0/vtt')

  // Switching to the MKV shows the fallback reason, not a black box.
  await page.locator('.player__item', { hasText: 'movie.mkv' }).click()
  await expect(page.locator('.player__fallback')).toContainText("isn't playable")
})
