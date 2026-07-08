import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    openable: true,
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

// Find a free local TCP port for the throwaway FastAPI server
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

// Start a real backend for the one Playwright test that exercises API jobs
async function startBackend(dataDir: string) {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const child = spawn(
    'uv',
    ['run', 'uvicorn', 'cairndex.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        CAIRNDEX_DATA_DIR: dataDir,
        CAIRNDEX_WORKER_ENABLED: 'true',
      },
      stdio: 'pipe',
    },
  )
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) throw new Error('backend exited before startup')
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`)
      if (response.ok) return { baseUrl, child }
    } catch {
      /* wait for uvicorn */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  child.kill()
  throw new Error('backend did not start')
}

// Stop the throwaway backend without leaving a child process behind
async function stopBackend(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// Proxy page-relative /api/v1 requests to the random backend port
async function proxyApi(page: Page, apiBaseUrl: string) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    const target = `${apiBaseUrl}${source.pathname}${source.search}`
    const response = await fetch(target, {
      method: request.method(),
      headers: request.headers(),
      body: ['GET', 'HEAD'].includes(request.method())
        ? undefined
        : (request.postDataBuffer() ?? undefined),
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key)) headers[key] = value
    })
    route.fulfill({
      status: response.status,
      headers,
      body: Buffer.from(await response.arrayBuffer()),
    })
  })
}

// Post JSON to the throwaway backend and return its JSON response
async function apiPost<T>(apiBaseUrl: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`)
  return (await response.json()) as T
}

// Wait for a backend job to reach a terminal status
async function waitApiJob(apiBaseUrl: string, jobId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${apiBaseUrl}/api/v1/jobs/${jobId}`)
    const job = (await response.json()) as { status: string; error?: string | null }
    if (job.status === 'succeeded') return
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error ?? `job ${jobId} ended as ${job.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`job ${jobId} did not finish`)
}

// Generate a long, low-rate video that stays small enough for e2e
function makeLongVideo(path: string) {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=65:size=160x90:rate=1',
    '-movflags',
    '+faststart',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-y',
    path,
  ])
}

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
    window.addEventListener(
      'error',
      (event) => {
        if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation()
      },
      true,
    )
    HTMLMediaElement.prototype.load = function () {
      this.dataset.duration ||= '120'
      this.dispatchEvent(new Event('loadedmetadata'))
      this.dispatchEvent(new Event('durationchange'))
      this.dispatchEvent(new Event('progress'))
    }
    HTMLMediaElement.prototype.play = function () {
      this.dataset.duration ||= '120'
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

// Options for the player API mock variants
interface MockApiOptions {
  storyboardStatus?: 200 | 404
  chapters?: Array<{ start: number; end: number; title: string }>
  progress?: { position_s: number; duration_s: number | null; completed: boolean } | null
  secondPlayable?: boolean
  nonNativeImage?: boolean
  onPreview?: (url: string) => void
  onProgress?: (fileId: string, body: { position_s: number; duration_s: number | null }) => void
}

/** Mock enough of the Cairndex API for one bundle with playable and fallback media. */
async function mockApi(page: Page, options: MockApiOptions = {}) {
  const mp4 = generatedMp4 ?? Buffer.from([])
  const storyboardStatus = options.storyboardStatus ?? 200
  const imageName = options.nonNativeImage ? 'poster.heic' : 'poster.png'
  const imageMime = options.nonNativeImage ? 'image/heic' : 'image/png'
  const chapters = options.chapters ?? [
    { start: 0, end: 60, title: 'Intro' },
    { start: 60, end: 120, title: 'Middle' },
  ]
  const progressByFile: Record<
    string,
    { position_s: number; duration_s: number | null; completed: boolean } | null
  > = {
    f0: options.progress ?? null,
    f1: null,
  }
  await page.route(/\/api\/v1\/libraries$/, (r) =>
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
  await page.route(/\/api\/v1\/libraries\/lib1\/auth\/status$/, (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/counts$/, (r) =>
    r.fulfill({
      json: { all: 1, recent: 1, uncategorized: 1, untagged: 1, missing: 0, unbundled: 0 },
    }),
  )
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [summary('b0', 'Movie 0')], total: 1, offset: 0, limit: 100 } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/collections\?/, (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/collections\/counts$/, (r) =>
    r.fulfill({ json: { counts: {} } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/smart-collections$/, (r) => r.fulfill({ json: [] }))
  await page.route(/\/api\/v1\/libraries\/lib1\/tags\?/, (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/tag-groups\?/, (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/tags\/counts$/, (r) =>
    r.fulfill({ json: { counts: {} } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/thumbnail/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/files\/[^/]+\/thumbnail$/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/(?:f0|f1)\/stream$/, (r) =>
    r.fulfill({ status: 200, contentType: 'video/mp4', body: mp4 }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/img1\/content$/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/img1\/preview/, (r) => {
    options.onPreview?.(r.request().url())
    return r.fulfill({ status: 200, contentType: 'image/webp', body: png })
  })
  await page.route(/\/api\/v1\/libraries\/lib1\/subtitles\/s0\/vtt$/, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/vtt',
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello',
    }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/f0\/storyboard\.vtt/, (r) =>
    r.fulfill({
      status: storyboardStatus,
      contentType: 'text/vtt',
      body:
        storyboardStatus === 200
          ? 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nstoryboard/sb_001.jpg?v=mock#xywh=0,0,320,180\n\n00:00:02.000 --> 00:02:00.000\nstoryboard/sb_001.jpg?v=mock#xywh=320,0,320,180\n'
          : '',
    }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/f0\/storyboard\/sb_001\.jpg/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/(?:f0|f1)\/progress$/, async (r) => {
    const match = r
      .request()
      .url()
      .match(/\/files\/([^/]+)\/progress$/)
    const fileId = match?.[1] ?? 'f0'
    const body = JSON.parse(r.request().postData() ?? '{}') as {
      position_s: number
      duration_s: number | null
    }
    options.onProgress?.(fileId, body)
    progressByFile[fileId] = {
      position_s: body.position_s,
      duration_s: body.duration_s,
      completed: Boolean(body.duration_s && body.position_s / body.duration_s >= 0.95),
    }
    await r.fulfill({ status: 200, contentType: 'application/json', json: progressByFile[fileId] })
  })

  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/files$/, (r) =>
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
          quick_fingerprint: 'video-fingerprint',
          supported: true,
          tech_metadata: { width: 1920, height: 1080, duration: 120 },
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
        {
          id: 'img1',
          bundle_id: 'b0',
          relative_path: imageName,
          original_filename: imageName,
          display_title: imageName,
          role: 'image',
          media_kind: 'image',
          mime_type: imageMime,
          sequence: 1,
          size_bytes: 0,
          availability: 'available',
          quick_fingerprint: 'image-fingerprint',
          supported: true,
          tech_metadata: { width: 640, height: 360 },
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
        {
          id: 'f1',
          bundle_id: 'b0',
          relative_path: options.secondPlayable ? 'part2.mp4' : 'movie.mkv',
          original_filename: options.secondPlayable ? 'part2.mp4' : 'movie.mkv',
          display_title: options.secondPlayable ? 'part2.mp4' : 'movie.mkv',
          role: options.secondPlayable ? 'video_part' : 'alternate_version',
          media_kind: 'video',
          mime_type: options.secondPlayable ? 'video/mp4' : 'video/x-matroska',
          sequence: 2,
          size_bytes: 0,
          availability: 'available',
          quick_fingerprint: 'second-fingerprint',
          supported: true,
          tech_metadata: options.secondPlayable ? { width: 1280, height: 720, duration: 90 } : {},
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
      ],
    }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/collections$/, (r) =>
    r.fulfill({ json: { bundle_id: 'b0', collection_ids: [] } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/tags$/, (r) =>
    r.fulfill({ json: { bundle_id: 'b0', tag_ids: [] } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0$/, (r) =>
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
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/playback$/, (r) =>
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
            storyboard_url: '/api/v1/libraries/lib1/files/f0/storyboard.vtt?v=mock',
            chapters,
            progress: progressByFile.f0,
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
            display_title: options.secondPlayable ? 'part2.mp4' : 'movie.mkv',
            playable: options.secondPlayable ?? false,
            reason: options.secondPlayable ? '' : "MKV container isn't playable in browsers",
            mime_type: options.secondPlayable ? 'video/mp4' : 'video/x-matroska',
            stream_url: '/api/v1/libraries/lib1/files/f1/stream',
            width: options.secondPlayable ? 1280 : null,
            height: options.secondPlayable ? 720 : null,
            duration: options.secondPlayable ? 90 : null,
            storyboard_url: null,
            chapters: [],
            progress: progressByFile.f1,
            subtitles: [],
          },
        ],
      },
    }),
  )
}

/** Hover the custom seek bar at a fraction of its width. */
async function hoverSeekBar(page: Page, fraction: number) {
  const video = page.getByTestId('media-video')
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).duration || 0))
    .toBeGreaterThan(0)
  const track = page.locator('.mv-seek__track')
  const box = await track.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * fraction, box!.y + box!.height / 2)
}

/** Open the mocked movie and wait for the video player to be ready. */
async function openMovie(page: Page) {
  const card = page.locator('[data-bundle-id="b0"]')
  await expect(card).toBeVisible()
  await card.dblclick()
  await expect(page.locator('.media-viewer')).toBeVisible()
  const video = page.getByTestId('media-video')
  await expect(video).toHaveAttribute('src', /files\/f0\/stream/, { timeout: 10_000 })
  await expect(page.locator('.mv-time')).toContainText('/ 2:00')
  return video
}

test('opens the unified viewer and drives custom video controls', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await expect(page.locator('.mv-title')).toContainText('Movie 0')
  await expect(page.locator('.mv-center-play')).toHaveCount(0)
  await expect(page.locator('.mv-filmstrip')).toHaveCount(0)

  await expect(page.locator('[data-testid="media-video"] track')).toHaveAttribute(
    'src',
    /subtitles\/s0\/vtt/,
  )
  await expect.poll(() => video.evaluate((el) => el.textTracks[0]?.mode)).toBe('showing')
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

test('shows storyboard preview and chapter title on seek hover', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  await openMovie(page)
  const ticks = page.locator('.mv-seek__chapter-tick')
  await expect(ticks).toHaveCount(2)

  await hoverSeekBar(page, 0.55)

  const preview = page.getByTestId('storyboard-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveCSS('background-image', /sb_001\.jpg/)
  await expect(page.locator('.mv-seek__tip')).toContainText('Middle')
})

test('keeps the time-only tooltip when storyboard VTT is absent', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page, { storyboardStatus: 404 })
  await page.goto('/')

  await openMovie(page)
  await hoverSeekBar(page, 0.2)

  await expect(page.locator('.mv-seek__tip')).toBeVisible()
  await expect(page.getByTestId('storyboard-preview')).toHaveCount(0)
})

test('omits chapter titles before the first chapter and in chapter gaps', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page, {
    storyboardStatus: 404,
    chapters: [
      { start: 20, end: 40, title: 'First' },
      { start: 80, end: 120, title: 'Last' },
    ],
  })
  await page.goto('/')

  await openMovie(page)
  await hoverSeekBar(page, 0.1)
  await expect(page.locator('.mv-seek__chapter-title')).toHaveCount(0)

  await hoverSeekBar(page, 0.5)
  await expect(page.locator('.mv-seek__chapter-title')).toHaveCount(0)

  await hoverSeekBar(page, 0.75)
  await expect(page.locator('.mv-seek__tip')).toContainText('Last')
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
  await expect(page.getByTestId('image-stage')).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.media-fallback')).toContainText("isn't playable")
})

test('zooms and pans a non-native image through preview derivatives', async ({ page }) => {
  await mockMedia(page)
  const previewRequests: string[] = []
  await mockApi(page, {
    nonNativeImage: true,
    onPreview: (url) => previewRequests.push(url),
  })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  await page.getByRole('button', { name: /next file/i }).click()
  const stage = page.getByTestId('image-stage')
  await expect(stage).toBeVisible()
  await expect.poll(() => previewRequests.some((url) => url.includes('size=1600'))).toBe(true)

  const image = page.locator('.mv-image')
  const zoom = page.getByTestId('image-zoom')
  await expect(zoom).toContainText('100%')
  const box = await stage.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.wheel(0, -500)
  await expect.poll(() => zoom.textContent()).not.toBe('100%')
  await expect.poll(() => previewRequests.some((url) => url.includes('size=2560'))).toBe(true)

  const before = await image.evaluate((el) => (el as HTMLElement).style.transform)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 30)
  await page.mouse.up()
  const after = await image.evaluate((el) => (el as HTMLElement).style.transform)
  expect(after).not.toBe(before)
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

test('reports real MP4 progress and resumes on reopen', async ({ page }) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real progress e2e')
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
  const writes: Array<{ fileId: string; position_s: number; duration_s: number | null }> = []
  await mockApi(page, { onProgress: (fileId, body) => writes.push({ fileId, ...body }) })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  const video = page.getByTestId('media-video')
  await expect(video).toHaveAttribute('src', /files\/f0\/stream/)
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1.1)
  await page.keyboard.press('Space')
  await expect.poll(() => writes.length).toBeGreaterThan(0)
  const saved = writes.filter((write) => write.fileId === 'f0').at(-1)!
  expect(saved.position_s).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.media-viewer')).toHaveCount(0)
  await page.locator('[data-bundle-id="b0"]').dblclick()

  await expect(page.locator('.mv-resume')).toContainText('Resumed at')
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(saved.position_s - 0.25)
})

test('restart affordance persists a zero resume point', async ({ page }) => {
  await mockMedia(page)
  const writes: Array<{ fileId: string; position_s: number; duration_s: number | null }> = []
  await mockApi(page, {
    progress: { position_s: 45, duration_s: 120, completed: false },
    onProgress: (fileId, body) => writes.push({ fileId, ...body }),
  })
  await page.goto('/')

  await openMovie(page)
  await expect(page.locator('.mv-resume')).toContainText('Resumed at')
  await page.locator('.mv-resume').click()

  await expect
    .poll(() => writes.some((write) => write.fileId === 'f0' && write.position_s === 0))
    .toBe(true)
})

test('does not carry a previous video position into progress for the next video', async ({
  page,
}) => {
  await mockMedia(page)
  const writes: Array<{ fileId: string; position_s: number; duration_s: number | null }> = []
  await mockApi(page, {
    secondPlayable: true,
    onProgress: (fileId, body) => writes.push({ fileId, ...body }),
  })
  await page.goto('/')

  const video = await openMovie(page)
  await video.evaluate((el) => {
    const media = el as HTMLVideoElement
    media.currentTime = 44
  })
  await page.getByRole('button', { name: /next file/i }).click()
  await expect(page.getByTestId('image-stage')).toBeVisible()
  await page.getByRole('button', { name: /next file/i }).click()
  await expect(page.getByTestId('media-video')).toHaveAttribute('src', /files\/f1\/stream/)
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.media-viewer')).toHaveCount(0)

  expect(writes.filter((write) => write.fileId === 'f1' && write.position_s > 1)).toEqual([])
})

test('shows a storyboard generated by the real backend job', async ({ page }) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real storyboard e2e')

  const libraryRoot = mkdtempSync(join(tmpdir(), 'cairndex-storyboard-lib-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'cairndex-storyboard-data-'))
  let backend: { baseUrl: string; child: ChildProcessWithoutNullStreams } | null = null
  try {
    makeLongVideo(join(libraryRoot, 'story.mp4'))
    backend = await startBackend(dataDir)
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
      root_path: libraryRoot,
      display_name: 'Storyboard Test',
      create_if_missing: false,
    })
    const bundle = await apiPost<{ id: string }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/bundles`,
      { title: 'Storyboard Movie' },
    )
    await apiPost(backend.baseUrl, `/api/v1/libraries/${library.id}/bundles/${bundle.id}/files`, {
      relative_path: 'story.mp4',
      role: 'primary_video',
      media_kind: 'video',
      mime_type: 'video/mp4',
    })
    const probe = await apiPost<{ id: string }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/jobs/probe`,
    )
    await waitApiJob(backend.baseUrl, probe.id)
    const storyboard = await apiPost<{ id: string }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/jobs/storyboards`,
    )
    await waitApiJob(backend.baseUrl, storyboard.id)

    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.locator(`[data-bundle-id="${bundle.id}"]`).dblclick()
    await expect(page.getByTestId('media-video')).toHaveAttribute('src', /story\.mp4|stream/)
    await expect(page.locator('.mv-time')).toContainText('/ 1:05')

    await hoverSeekBar(page, 0.4)
    const preview = page.getByTestId('storyboard-preview')
    await expect(preview).toBeVisible()
    await expect(preview).toHaveCSS('background-image', /storyboard\/sb_001\.jpg/)
  } finally {
    if (backend) await stopBackend(backend.child)
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})
