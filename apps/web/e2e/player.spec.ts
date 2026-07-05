import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hermetic mock for the M2 media viewer. The app still runs as a Vite-only
// frontend in Playwright, so API calls and media element behavior are patched.

/** Build a bundle summary row for the mocked browser grid. */
function summary(id: string, title: string) {
  return {
    id,
    title,
    rating: 0,
    file_count: 3,
    total_size: 0,
    has_missing: false,
    has_cover: true,
    cover_key: null,
    media_kind: 'video',
    width: 1920,
    height: 1080,
    duration: 120,
    extension: 'mp4',
    date_added: '2026-06-25T00:00:00Z',
    grouping_state: 'confirmed',
  }
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

/** Build a tiny browser-decodable MP4 fixture from generated color/audio. */
function mediaBytes(): Buffer | null {
  const out = join(tmpdir(), 'cairndex-m2-viewer-fixture-v2.mp4')
  if (!existsSync(out)) {
    try {
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x180:d=3',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-shortest',
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-y',
        out,
      ])
    } catch {
      return null
    }
  }
  return readFileSync(out)
}

const generatedMp4 = mediaBytes()

/** Patch browser media APIs so controls can be tested without a real backend. */
async function mockMedia(page: Page) {
  await page.addInitScript(() => {
    const paused = {
      configurable: true,
      get() {
        return this.dataset.paused !== 'false'
      },
    }
    const duration = {
      configurable: true,
      get() {
        return Number(this.dataset.duration ?? 120)
      },
    }
    const currentTime = {
      configurable: true,
      get() {
        return Number(this.dataset.currentTime ?? 0)
      },
      set(value: number) {
        this.dataset.currentTime = String(value)
        this.dispatchEvent(new Event('timeupdate'))
      },
    }
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', paused)
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', duration)
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', currentTime)
    Object.defineProperty(HTMLVideoElement.prototype, 'paused', paused)
    Object.defineProperty(HTMLVideoElement.prototype, 'duration', duration)
    Object.defineProperty(HTMLVideoElement.prototype, 'currentTime', currentTime)
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get() {
        return 320
      },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get() {
        return 180
      },
    })
    HTMLMediaElement.prototype.load = function () {
      this.dispatchEvent(new Event('loadedmetadata'))
    }
    HTMLMediaElement.prototype.play = function () {
      this.dataset.paused = 'false'
      this.dispatchEvent(new Event('play'))
      this.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = function () {
      this.dataset.paused = 'true'
      this.dispatchEvent(new Event('pause'))
    }
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get() {
        return document.body.dataset.fullscreen === 'true'
          ? document.querySelector('.media-viewer')
          : null
      },
    })
    HTMLElement.prototype.requestFullscreen = function () {
      document.body.dataset.fullscreen = 'true'
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    }
    document.exitFullscreen = () => {
      document.body.dataset.fullscreen = 'false'
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    }
  })
}

/** Mock enough of the Cairndex API for one bundle with playable and fallback media. */
async function mockApi(page: Page) {
  const mp4 = generatedMp4 ?? Buffer.from([])
  await page.route('**/api/v1/libraries', (r) =>
    r.fulfill({
      json: [
        {
          id: 'lib1',
          library_uuid: 'lib-uuid',
          name: 'Test Library',
          root_path: '/srv/lib',
          status: 'available',
          schema_version: 1,
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          last_opened_at: null,
        },
      ],
    }),
  )
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/bundles/counts', (r) =>
    r.fulfill({
      json: { all: 1, recent: 1, uncategorized: 1, untagged: 1, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [summary('b0', 'Movie 0')], total: 1, offset: 0, limit: 100 } }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/tags?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/tag-groups?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/tags/counts', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/bundles/b0/thumbnail**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route('**/bundles/b0/files/*/thumbnail', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route('**/files/f0/stream', (r) =>
    r.fulfill({ status: 200, contentType: 'video/mp4', body: mp4 }),
  )
  await page.route('**/files/img1/content', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route('**/subtitles/s0/vtt', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello',
    }),
  )

  await page.route('**/bundles/b0/files', (r) =>
    r.fulfill({
      json: [
        {
          id: 'f0',
          bundle_id: 'b0',
          relative_path: 'movie.mp4',
          original_filename: 'movie.mp4',
          display_title: 'movie.mp4',
          role: 'primary_video',
          media_kind: 'video',
          mime_type: 'video/mp4',
          sequence: 0,
          size_bytes: 0,
          availability: 'available',
          tech_metadata: { width: 1920, height: 1080, duration: 120 },
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
        {
          id: 'img1',
          bundle_id: 'b0',
          relative_path: 'poster.png',
          original_filename: 'poster.png',
          display_title: 'poster.png',
          role: 'image',
          media_kind: 'image',
          mime_type: 'image/png',
          sequence: 1,
          size_bytes: 0,
          availability: 'available',
          tech_metadata: { width: 640, height: 360 },
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
        {
          id: 'f1',
          bundle_id: 'b0',
          relative_path: 'movie.mkv',
          original_filename: 'movie.mkv',
          display_title: 'movie.mkv',
          role: 'alternate_version',
          media_kind: 'video',
          mime_type: 'video/x-matroska',
          sequence: 2,
          size_bytes: 0,
          availability: 'available',
          tech_metadata: {},
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
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
        primary_file_id: 'f0',
        extra_metadata: null,
        grouping_state: 'confirmed',
        grouping_source: 'manual',
        grouping_rule_version: null,
        confirmed_at: null,
        version: 1,
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
            stream_url: '/api/v1/libraries/lib1/files/f0/stream',
            width: 1920,
            height: 1080,
            duration: 120,
            subtitles: [
              {
                id: 's0',
                language: 'en',
                label: 'EN',
                format: 'srt',
                is_default: true,
                is_forced: false,
                kind: 'external',
                src: '/api/v1/libraries/lib1/subtitles/s0/vtt',
              },
            ],
          },
          {
            file_id: 'f1',
            display_title: 'movie.mkv',
            playable: false,
            reason: "MKV container isn't playable in browsers",
            mime_type: 'video/x-matroska',
            stream_url: '/api/v1/libraries/lib1/files/f1/stream',
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

test('opens the unified viewer and drives custom video controls', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  await expect(page.locator('.media-viewer')).toBeVisible()
  await expect(page.locator('.mv-title')).toContainText('Movie 0')
  await expect(page.locator('.mv-center-play')).toHaveCount(0)
  await expect(page.locator('.mv-filmstrip')).toHaveCount(0)

  const video = page.getByTestId('media-video')
  await expect(video).toHaveAttribute('src', /files\/f0\/stream/)
  await expect(page.locator('[data-testid="media-video"] track')).toHaveAttribute(
    'src',
    /subtitles\/s0\/vtt/,
  )
  await expect.poll(() => video.evaluate((el) => el.textTracks[0]?.mode)).toBe('showing')
  await expect(page.locator('.mv-time')).toContainText('/ 2:00')
  await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)

  await page.keyboard.press('ArrowRight')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(5)

  await page.keyboard.press('F')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page.locator('.media-viewer')).toBeVisible()

  const cc = page.getByRole('button', { name: /hide subtitles/i })
  await expect(cc).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('C')
  await expect(page.getByRole('button', { name: /show subtitles/i })).toHaveAttribute(
    'aria-pressed',
    'false',
  )

  const download = page.waitForEvent('download')
  await page.keyboard.press('S')
  expect((await download).suggestedFilename()).toMatch(/movie_mp4\.png|movie\.mp4\.png/)

  await page.waitForTimeout(2800)
  await expect(page.locator('.mv-controls')).toHaveCSS('opacity', '0')
  await page.mouse.move(420, 420)
  await expect(page.locator('.mv-controls')).toHaveCSS('opacity', '1')
})

test('navigates files without the inline filmstrip and shows the fallback card', async ({
  page,
}) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  await expect(page.locator('.mv-filmstrip')).toHaveCount(0)
  await page.getByRole('button', { name: /next file/i }).click()
  await expect(page.locator('.mv-image')).toHaveAttribute('src', /files\/img1\/content/)

  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.media-fallback')).toContainText("isn't playable")
})

test('plays a real generated MP4 without media-element mocks', async ({ page }) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real MP4 playback smoke')
  await page.addInitScript(() => {
    localStorage.setItem(
      'cairndex.prefs',
      JSON.stringify({
        layout: 'grid',
        zoom: 200,
        sort: 'manual',
        order: 'asc',
        sortScope: 'global',
        collectionSorts: {},
        player: { volume: 0.5, muted: true, rate: 1, subtitlesOn: true },
      }),
    )
  })
  await mockApi(page)
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  const video = page.getByTestId('media-video')
  await expect(video).toHaveAttribute('src', /files\/f0\/stream/)
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).duration))
    .toBeGreaterThan(0)
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1.1)
  await expect(page.locator('.mv-time')).not.toHaveText(/^0:00 /)
})
