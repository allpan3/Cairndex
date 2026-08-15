import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
    resume_file_id: 'f0',
    resume_file_updated_at: '2026-06-25T00:00:00Z',
    resume_media_kind: 'video',
    resume_relative_path: 'movie.mp4',
    resume_mime_type: 'video/mp4',
    resume_container: 'mov,mp4,m4a,3gp,3g2,mj2',
    resume_video_codec: 'h264',
    resume_audio_codec: 'aac',
    resume_duration: 3,
    resume_position: null,
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
const GENERATED_MP4_PATH = join(tmpdir(), 'cairndex-m2-viewer-fixture-v3.mp4')

/** Build a tiny browser-decodable MP4 fixture from generated color/audio. */
function mediaBytes(): Buffer | null {
  const out = GENERATED_MP4_PATH
  if (!existsSync(out)) {
    try {
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=25:duration=3',
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

/** Fulfill a media request with HTTP byte-range semantics matching the server stream route. */
async function fulfillMedia(route: Route, body: Buffer) {
  const range = route.request().headers().range
  const match = range?.match(/^bytes=(\d+)-(\d*)$/)
  if (!match) {
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length) },
      body,
    })
    return
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : body.length - 1
  const end = Math.min(requestedEnd, body.length - 1)
  if (!Number.isFinite(start) || start < 0 || start > end) {
    await route.fulfill({
      status: 416,
      headers: { 'Content-Range': `bytes */${body.length}` },
    })
    return
  }
  const chunk = body.subarray(start, end + 1)
  await route.fulfill({
    status: 206,
    contentType: 'video/mp4',
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunk.length),
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
    },
    body: chunk,
  })
}

// Build a real fMP4 HLS stream (init + one segment + VOD playlist) from the MP4
// fixture so the mocked HLS test drives hls.js over genuine MSE-decodable bytes,
// mirroring what an M6 remux session serves. Returns null when ffmpeg is absent.
function hlsFixtureFiles(): Map<string, Buffer> | null {
  if (generatedMp4 === null) return null
  const dir = join(tmpdir(), 'cairndex-m7-hls-fixture')
  const playlist = join(dir, 'index.m3u8')
  if (!existsSync(playlist)) {
    try {
      mkdirSync(dir, { recursive: true })
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          GENERATED_MP4_PATH,
          '-c',
          'copy',
          '-f',
          'hls',
          '-hls_time',
          '1',
          '-hls_playlist_type',
          'vod',
          '-hls_segment_type',
          'fmp4',
          '-hls_fmp4_init_filename',
          'init.mp4',
          '-hls_segment_filename',
          'seg%d.m4s',
          '-hls_list_size',
          '0',
          'index.m3u8',
        ],
        { cwd: dir },
      )
    } catch {
      return null
    }
  }
  const files = new Map<string, Buffer>()
  for (const name of readdirSync(dir)) files.set(name, readFileSync(join(dir, name)))
  return files
}

const hlsFixture = hlsFixtureFiles()

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
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  let lastOutput = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
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
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const ownReadyLine = `Uvicorn running on http://127.0.0.1:${port}`
    const started = Date.now()
    while (Date.now() - started < 30_000) {
      if (child.exitCode !== null || child.signalCode !== null) break
      if (output.includes(ownReadyLine)) {
        try {
          const response = await fetch(`${baseUrl}/api/v1/health`)
          if (response.ok) return { baseUrl, child }
        } catch {
          // Uvicorn logged its socket before the health route accepted requests
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    lastOutput = output
    await stopBackend(child)
  }
  throw new Error(`backend did not start its reserved port: ${lastOutput.slice(-500)}`)
}

// Stop the throwaway backend without leaving a child process behind
async function stopBackend(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
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

// Wait until the completed job's index and first referenced sheet are both servable
async function waitStoryboardArtifacts(apiBaseUrl: string, libraryId: string, fileId: string) {
  const fileBase = `${apiBaseUrl}/api/v1/libraries/${libraryId}/files/${fileId}/`
  const indexUrl = `${fileBase}storyboard.vtt`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(indexUrl)
    if (response.ok) {
      const payload = await response.text()
      const sheetRef = payload.split('\n').find((line) => line.includes('#xywh='))
      if (sheetRef) {
        const sheetUrl = new URL(sheetRef.split('#', 1)[0]!, fileBase)
        if ((await fetch(sheetUrl)).ok) return
      }
    } else if (response.status !== 404) {
      throw new Error(`storyboard index failed with ${response.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`storyboard artifacts for ${fileId} did not become servable`)
}

// Generate a small H.264 + AAC MKV: the browser can't play the container
// directly, so the decision remuxes it into an HLS session.
function makeMkv(path: string) {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=6:size=160x90:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-y',
    path,
  ])
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
    'testsrc2=duration=65:size=160x90:rate=4',
    '-movflags',
    '+faststart',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    // Storyboard sampling takes keyframes, so the fixture has to say where they
    // are: 8 frames at 4 fps is one every 2s, the interval a 65s video samples
    // at, and `scenecut=0` stops x264 adding others of its own. Left to the
    // encoder's defaults this clip has almost no keyframes, and which cue a
    // hover lands in becomes a property of scene detection.
    '-g',
    '8',
    '-x264-params',
    'scenecut=0',
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
  threeVideos?: boolean
  nonNativeImage?: boolean
  // Force the f0 playback decision to a remux HLS session served from the real
  // fMP4 fixture, exercising the hls.js engine + settings menus + teardown.
  forceHls?: boolean
  // Serve the playlist but 404 the init/segment bytes, simulating a session that
  // idled out — the client must transparently re-request a decision (re-attach).
  hlsBreak?: boolean
  onContent?: (url: string) => void
  onPreview?: (url: string) => void
  onProgress?: (fileId: string, body: { position_s: number; duration_s: number | null }) => void
  onSessionDelete?: (url: string) => void
  onDecision?: (fileId: string, body: Record<string, unknown>) => void
  onCoverFrame?: (time: number | null) => void
  summaryPatch?: Record<string, unknown>
  summaryCount?: number
  hoverStreamFailure?: boolean
  missingCurrent?: boolean
  onViewCounts?: (missing: number) => void
  resumeFileId?: string
  onCursor?: (fileId: string) => void
}

/** Mock enough of the Cairndex API for one bundle with playable and fallback media. */
async function mockApi(page: Page, options: MockApiOptions = {}) {
  const mp4 = generatedMp4 ?? Buffer.from([])
  const storyboardStatus = options.storyboardStatus ?? 200
  const imageName = options.nonNativeImage ? 'poster.heic' : 'poster.png'
  const imageMime = options.nonNativeImage ? 'image/heic' : 'image/png'
  const secondaryPlayable = options.secondPlayable || options.threeVideos
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
    f2: null,
  }
  let coverTime: number | null = null
  let missingReconciled = false
  let currentCursor = options.resumeFileId ?? 'f0'
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
  await page.route(/\/api\/v1\/libraries\/lib1\/ownership$/, (r) =>
    r.fulfill({ json: { state: 'own', mountable: true } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/counts$/, (r) => {
    const missing = missingReconciled ? 1 : 0
    options.onViewCounts?.(missing)
    return r.fulfill({
      json: { all: 1, recent: 1, uncategorized: 1, untagged: 1, missing, unbundled: 0 },
    })
  })
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({
      json: {
        items: Array.from({ length: options.summaryCount ?? 1 }, (_, index) => ({
          ...summary(index === 0 ? 'b0' : `b${index}`, `Movie ${index}`),
          resume_file_id: index === 0 ? 'f0' : `f${index}`,
          resume_position:
            index === 0 && options.progress && !options.progress.completed
              ? options.progress.position_s
              : null,
          ...options.summaryPatch,
        })),
        total: options.summaryCount ?? 1,
        offset: 0,
        limit: 100,
      },
    }),
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
  await page.route(
    /\/api\/v1\/libraries\/lib1\/bundles\/b0\/files\/[^/]+\/thumbnail(?:\?.*)?$/,
    (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/f0\/cover-frame$/, async (r) => {
    coverTime =
      r.request().method() === 'DELETE'
        ? null
        : (JSON.parse(r.request().postData() ?? '{}') as { time: number }).time
    options.onCoverFrame?.(coverTime)
    await r.fulfill({
      json: {
        id: 'f0',
        bundle_id: 'b0',
        relative_path: 'movie.mp4',
        original_filename: 'movie.mp4',
        display_title: 'movie.mp4',
        role: 'primary_video',
        media_kind: 'video',
        mime_type: null,
        sequence: 0,
        size_bytes: 0,
        availability: 'available',
        quick_fingerprint: 'video-fingerprint',
        cover_time: coverTime,
        supported: true,
        tech_metadata: {
          container: 'mov,mp4,m4a,3gp,3g2,mj2',
          width: 1920,
          height: 1080,
          duration: 120,
          video_codec: 'h264',
          audio_codec: 'aac',
        },
        created_at: '2026-06-25T00:00:00Z',
        updated_at: new Date().toISOString(),
        version: 2,
      },
    })
  })
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/(?:f0|f1|f2)\/stream$/, (r) =>
    fulfillMedia(r, options.hoverStreamFailure ? Buffer.from('not a video') : mp4),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/img1\/content$/, (r) => {
    options.onContent?.(r.request().url())
    return r.fulfill({ status: 200, contentType: 'image/png', body: png })
  })
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
  await page.route(/\/api\/v1\/libraries\/lib1\/files\/(?:f0|f1|f2)\/progress$/, async (r) => {
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

  // Per-file playback decision (M7). f0 is directly playable (or a forced remux
  // HLS session under forceHls); the MKV f1 has no session in this mock, so it
  // still lands on the fallback card — the "can't play" path must keep working
  // even though real MKVs remux over HLS.
  const audioStreams = [
    { index: 1, codec: 'aac', channels: 6, language: 'eng', title: 'Surround', default: true },
    { index: 2, codec: 'ac3', channels: 2, language: 'fra', title: 'Commentary', default: false },
  ]
  await page.route(
    /\/api\/v1\/libraries\/lib1\/files\/(f0|f1|f2)\/playback-decision$/,
    async (r) => {
      const fileId =
        r
          .request()
          .url()
          .match(/\/files\/(f\d)\//)?.[1] ?? 'f0'
      options.onDecision?.(
        fileId,
        JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>,
      )
      const streamUrl = `/api/v1/libraries/lib1/files/${fileId}/stream`
      const base = {
        duration: fileId === 'f0' ? 120 : options.secondPlayable || options.threeVideos ? 90 : null,
        subtitles: [],
        chapters: [],
        storyboard_url: null,
        progress: progressByFile[fileId],
      }
      if (options.forceHls && fileId === 'f0') {
        return r.fulfill({
          json: {
            ...base,
            method: 'remux',
            reason: 'forced remux for the HLS engine test',
            stream_url: null,
            session: {
              id: 'sess1',
              playlist_url: '/api/v1/libraries/lib1/files/f0/playback-sessions/sess1/index.m3u8',
            },
            audio_streams: audioStreams,
          },
        })
      }
      if (fileId === 'f1' && !options.secondPlayable && !options.threeVideos) {
        return r.fulfill({
          json: {
            ...base,
            method: 'transcode',
            reason: "MKV container isn't playable in browsers",
            stream_url: null,
            session: null,
            audio_streams: [],
          },
        })
      }
      return r.fulfill({
        json: {
          ...base,
          method: 'direct',
          reason: '',
          stream_url: streamUrl,
          session: null,
          audio_streams: [],
        },
      })
    },
  )

  if (options.forceHls && hlsFixture) {
    // Serve the real fMP4 playlist/init/segment bytes for the HLS session.
    await page.route(
      /\/api\/v1\/libraries\/lib1\/files\/f0\/playback-sessions\/sess1\/([^/]+)$/,
      (r) => {
        const name = decodeURIComponent(r.request().url().split('?')[0].split('/').pop() ?? '')
        // hlsBreak keeps the playlist reachable but 404s the media bytes, so
        // hls.js hits a fatal load error and the client must re-attach.
        if (options.hlsBreak && name !== 'index.m3u8') return r.fulfill({ status: 404, body: '' })
        const bytes = hlsFixture.get(name)
        if (!bytes) return r.fulfill({ status: 404, body: '' })
        const contentType = name === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4'
        return r.fulfill({
          status: 200,
          contentType,
          headers: { 'cache-control': 'no-store' },
          body: bytes,
        })
      },
    )
    // Session teardown (DELETE on close / file switch / unmount).
    await page.route(/\/api\/v1\/libraries\/lib1\/files\/f0\/playback-sessions\/sess1$/, (r) => {
      if (r.request().method() === 'DELETE') {
        options.onSessionDelete?.(r.request().url())
        return r.fulfill({ status: 204, body: '' })
      }
      return r.continue()
    })
  }

  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/files$/, (r) => {
    if (options.missingCurrent) missingReconciled = true
    return r.fulfill({
      json: [
        {
          id: 'f0',
          bundle_id: 'b0',
          relative_path: options.missingCurrent ? 'movie.avi' : 'movie.mp4',
          original_filename: options.missingCurrent ? 'movie.avi' : 'movie.mp4',
          display_title: options.missingCurrent ? 'movie.avi' : 'movie.mp4',
          role: 'primary_video',
          media_kind: 'video',
          mime_type: options.missingCurrent ? 'video/x-msvideo' : null,
          sequence: 0,
          size_bytes: 0,
          availability: options.missingCurrent ? 'missing' : 'available',
          quick_fingerprint: 'video-fingerprint',
          cover_time: coverTime,
          resume_position:
            progressByFile.f0 && !progressByFile.f0.completed ? progressByFile.f0.position_s : null,
          supported: true,
          tech_metadata: {
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
            width: 1920,
            height: 1080,
            duration: 120,
            video_codec: 'h264',
            audio_codec: 'aac',
          },
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
        ...(!options.threeVideos
          ? [
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
                cover_time: null,
                resume_position: null,
                supported: true,
                tech_metadata: { width: 640, height: 360 },
                created_at: '2026-06-25T00:00:00Z',
                updated_at: '2026-06-25T00:00:00Z',
                version: 1,
              },
            ]
          : []),
        {
          id: 'f1',
          bundle_id: 'b0',
          relative_path: secondaryPlayable ? 'part2.mp4' : 'movie.mkv',
          original_filename: secondaryPlayable ? 'part2.mp4' : 'movie.mkv',
          display_title: secondaryPlayable ? 'part2.mp4' : 'movie.mkv',
          role: secondaryPlayable ? 'video_part' : 'alternate_version',
          media_kind: 'video',
          mime_type: secondaryPlayable ? 'video/mp4' : 'video/x-matroska',
          sequence: options.threeVideos ? 1 : 2,
          size_bytes: 0,
          availability: 'available',
          quick_fingerprint: 'second-fingerprint',
          cover_time: null,
          resume_position: null,
          supported: true,
          tech_metadata: secondaryPlayable ? { width: 1280, height: 720, duration: 90 } : {},
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-25T00:00:00Z',
          version: 1,
        },
        ...(options.threeVideos
          ? [
              {
                id: 'f2',
                bundle_id: 'b0',
                relative_path: 'part3.mp4',
                original_filename: 'part3.mp4',
                display_title: 'part3.mp4',
                role: 'video_part',
                media_kind: 'video',
                mime_type: 'video/mp4',
                sequence: 2,
                size_bytes: 0,
                availability: 'available',
                quick_fingerprint: 'third-fingerprint',
                cover_time: null,
                resume_position: null,
                supported: true,
                tech_metadata: { width: 1280, height: 720, duration: 90 },
                created_at: '2026-06-25T00:00:00Z',
                updated_at: '2026-06-25T00:00:00Z',
                version: 1,
              },
            ]
          : []),
      ],
    })
  })
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/collections$/, (r) =>
    r.fulfill({ json: { bundle_id: 'b0', collection_ids: [] } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/tags$/, (r) =>
    r.fulfill({ json: { bundle_id: 'b0', tag_ids: [] } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/cursor$/, async (r) => {
    const body = JSON.parse(r.request().postData() ?? '{}') as { file_id: string }
    currentCursor = body.file_id
    options.onCursor?.(currentCursor)
    await r.fulfill({ json: { file_id: currentCursor } })
  })
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0$/, (r) =>
    r.fulfill({
      json: {
        id: 'b0',
        title: 'Movie 0',
        notes: [],
        rating: 0,
        cover_file_id: null,
        resume_file_id: currentCursor,
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
  await page.route(/\/api\/v1\/libraries\/lib1\/bundles\/b0\/playback$/, (r) => {
    if (options.missingCurrent) missingReconciled = true
    return r.fulfill({
      json: {
        bundle_id: 'b0',
        videos: [
          {
            file_id: 'f0',
            display_title: options.missingCurrent ? 'movie.avi' : 'movie.mp4',
            playable: !options.missingCurrent,
            reason: options.missingCurrent ? "AVI container isn't playable in browsers" : '',
            mime_type: options.missingCurrent ? 'video/x-msvideo' : null,
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
            display_title: secondaryPlayable ? 'part2.mp4' : 'movie.mkv',
            playable: secondaryPlayable ?? false,
            reason: secondaryPlayable ? '' : "MKV container isn't playable in browsers",
            mime_type: secondaryPlayable ? 'video/mp4' : 'video/x-matroska',
            stream_url: '/api/v1/libraries/lib1/files/f1/stream',
            width: secondaryPlayable ? 1280 : null,
            height: secondaryPlayable ? 720 : null,
            duration: secondaryPlayable ? 90 : null,
            storyboard_url: null,
            chapters: [],
            progress: progressByFile.f1,
            subtitles: [],
          },
          ...(options.threeVideos
            ? [
                {
                  file_id: 'f2',
                  display_title: 'part3.mp4',
                  playable: true,
                  reason: '',
                  mime_type: 'video/mp4',
                  stream_url: '/api/v1/libraries/lib1/files/f2/stream',
                  width: 1280,
                  height: 720,
                  duration: 90,
                  storyboard_url: null,
                  chapters: [],
                  progress: progressByFile.f2,
                  subtitles: [],
                },
              ]
            : []),
        ],
      },
    })
  })
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

/** Cache the visible sprite pixels before arming the time-sensitive handoff observer. */
async function prepareHoverFrameComparison(page: Page) {
  await page.evaluate(async () => {
    const sprite = document.querySelector<SVGSVGElement>('[data-testid="hover-preview-storyboard"]')
    const spriteImage = sprite?.querySelector<SVGImageElement>('image')
    if (!sprite || !spriteImage) throw new Error('hover comparison sprite missing')

    const image = new Image()
    image.src = spriteImage.href.baseVal
    await image.decode()
    const [cueX, cueY] = (sprite.dataset.cuePosition ?? '').split(',').map(Number)
    const cueWidth = sprite.viewBox.baseVal.width
    const cueHeight = sprite.viewBox.baseVal.height
    const width = 80
    const height = 45
    const spriteCanvas = document.createElement('canvas')
    spriteCanvas.width = width
    spriteCanvas.height = height
    const spriteContext = spriteCanvas.getContext('2d')
    if (!spriteContext) throw new Error('sprite canvas unavailable')
    spriteContext.drawImage(image, cueX!, cueY!, cueWidth, cueHeight, 0, 0, width, height)
    const spritePixels = spriteContext.getImageData(0, 0, width, height).data
    const state = window as unknown as {
      __hoverPreviewFrameReference: {
        cueStart: number
        height: number
        pixels: Uint8ClampedArray
        width: number
      }
    }
    state.__hoverPreviewFrameReference = {
      cueStart: Number(sprite.dataset.cueStart),
      height,
      pixels: spritePixels,
      width,
    }
  })
}

/** Compare the prepared sprite crop with the first video frame exposed at rest. */
async function armHoverFrameComparison(page: Page) {
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="hover-preview-video"]')
    const sprite = document.querySelector<SVGSVGElement>('[data-testid="hover-preview-storyboard"]')
    const container = sprite?.parentElement
    const state = window as unknown as {
      __hoverPreviewFrameMatch: { difference: number; time: number } | null
      __hoverPreviewFrameReference: {
        cueStart: number
        height: number
        pixels: Uint8ClampedArray
        width: number
      }
    }
    if (!video || !sprite || !container || !state.__hoverPreviewFrameReference) {
      throw new Error('hover comparison layers missing')
    }
    const reference = state.__hoverPreviewFrameReference
    if (Number(sprite.dataset.cueStart) !== reference.cueStart) {
      throw new Error('hover comparison cue changed')
    }
    state.__hoverPreviewFrameMatch = null

    const observer = new MutationObserver(() => {
      if (sprite.isConnected) return
      observer.disconnect()
      window.setTimeout(() => {
        const videoCanvas = document.createElement('canvas')
        videoCanvas.width = reference.width
        videoCanvas.height = reference.height
        const videoContext = videoCanvas.getContext('2d')
        if (!videoContext) return
        videoContext.drawImage(video, 0, 0, reference.width, reference.height)
        const videoPixels = videoContext.getImageData(0, 0, reference.width, reference.height).data
        let difference = 0
        for (let index = 0; index < reference.pixels.length; index += 4) {
          difference += Math.abs(reference.pixels[index]! - videoPixels[index]!)
          difference += Math.abs(reference.pixels[index + 1]! - videoPixels[index + 1]!)
          difference += Math.abs(reference.pixels[index + 2]! - videoPixels[index + 2]!)
        }
        state.__hoverPreviewFrameMatch = {
          difference: difference / (reference.width * reference.height * 3),
          time: video.currentTime,
        }
      }, 0)
    })
    observer.observe(container, { childList: true })
  })
}

test('uses storyboard motion and resting video on a real MP4 bundle preview', async ({ page }) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real hover preview e2e')
  const forbidden: string[] = []
  await page.addInitScript(() => {
    ;(window as unknown as { __hoverPreviewSeeks: number }).__hoverPreviewSeeks = 0
    ;(window as unknown as { __hoverPreviewSeekedTimes: number[] }).__hoverPreviewSeekedTimes = []
    document.addEventListener(
      'seeking',
      (event) => {
        if (
          event.target instanceof HTMLVideoElement &&
          event.target.getAttribute('data-testid') === 'hover-preview-video'
        ) {
          ;(window as unknown as { __hoverPreviewSeeks: number }).__hoverPreviewSeeks += 1
        }
      },
      true,
    )
    document.addEventListener(
      'seeked',
      (event) => {
        if (
          event.target instanceof HTMLVideoElement &&
          event.target.getAttribute('data-testid') === 'hover-preview-video'
        ) {
          ;(
            window as unknown as { __hoverPreviewSeekedTimes: number[] }
          ).__hoverPreviewSeekedTimes.push(event.target.currentTime)
        }
      },
      true,
    )
  })
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/playback-decision') || url.includes('/playback-sessions')) {
      forbidden.push(url)
    }
  })
  await mockApi(page, { progress: { position_s: 1.2, duration_s: 3, completed: false } })
  await page.goto('/')

  const card = page.locator('[data-bundle-id="b0"]')
  const storyboardRequest = page.waitForRequest((request) =>
    request.url().includes('/files/f0/storyboard.vtt'),
  )
  await card.hover()
  await storyboardRequest
  await expect(page.getByTestId('hover-preview-video')).toHaveCount(0)
  const video = page.getByTestId('hover-preview-video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1.1)
  await expect(card.locator('.card__thumb')).toHaveCSS('background-size', 'contain')
  await expect(video).toHaveCSS('object-fit', 'contain')

  const box = await card.locator('.card__thumb').boundingBox()
  if (!box) throw new Error('missing bundle hover card bounds')
  // Capture motion state from its DOM commit, independent of driver scheduling
  const nextSkimState = () =>
    card.evaluate(
      (element) =>
        new Promise<{
          storyboardVisible: boolean
          preserveAspectRatio: string | null
          cueStart: string | null
          clipId: string | null
          clipPath: string | null
          videoVisible: boolean
          videoPaused: boolean | null
          seeks: number
          clockRight: number | null
        }>((resolve, reject) => {
          const thumb = element.querySelector<HTMLElement>('.card__thumb')
          if (!thumb) {
            reject(new Error('missing hover preview thumb'))
            return
          }
          const readState = () => {
            const storyboard = thumb.querySelector<SVGElement>(
              '[data-testid="hover-preview-storyboard"]',
            )
            const video = thumb.querySelector<HTMLVideoElement>(
              '[data-testid="hover-preview-video"]',
            )
            const clock = thumb.querySelector<HTMLElement>('.hover-preview__clock')
            const storyboardBox = storyboard?.getBoundingClientRect()
            const videoBox = video?.getBoundingClientRect()
            const clockBox = clock?.getBoundingClientRect()
            const storyboardStyle = storyboard ? getComputedStyle(storyboard) : null
            const videoStyle = video ? getComputedStyle(video) : null
            const clipId = storyboard?.querySelector('clipPath')?.getAttribute('id') ?? null
            return {
              storyboardVisible: Boolean(
                storyboardBox?.width &&
                storyboardBox.height &&
                storyboardStyle?.display !== 'none' &&
                storyboardStyle?.visibility !== 'hidden',
              ),
              preserveAspectRatio: storyboard?.getAttribute('preserveAspectRatio') ?? null,
              cueStart: storyboard?.getAttribute('data-cue-start') ?? null,
              clipId,
              clipPath: storyboard?.querySelector('g')?.getAttribute('clip-path') ?? null,
              videoVisible: Boolean(
                videoBox?.width &&
                videoBox.height &&
                videoStyle?.display !== 'none' &&
                videoStyle?.visibility !== 'hidden',
              ),
              videoPaused: video?.paused ?? null,
              seeks: (window as unknown as { __hoverPreviewSeeks: number }).__hoverPreviewSeeks,
              clockRight: clockBox?.right ?? null,
            }
          }
          let lastSkimState: ReturnType<typeof readState> | null = null
          const observer = new MutationObserver(() => {
            if (thumb.getAttribute('data-hover-preview-state') === 'skimming') {
              lastSkimState = readState()
              return
            }
            if (!lastSkimState) return
            observer.disconnect()
            window.clearTimeout(timeout)
            resolve(lastSkimState)
          })
          const timeout = window.setTimeout(() => {
            observer.disconnect()
            reject(new Error('hover preview never entered skimming'))
          }, 5_000)
          observer.observe(thumb, { attributes: true, childList: true, subtree: true })
        }),
    )
  const cursorFraction = 0.8
  const rawCursorTime = 3 * cursorFraction
  const seeksBeforeSkim = await page.evaluate(
    () => (window as unknown as { __hoverPreviewSeeks: number }).__hoverPreviewSeeks,
  )
  const skimStatePromise = nextSkimState()
  await page.mouse.move(box.x + box.width * cursorFraction, box.y + box.height / 2, { steps: 6 })
  const storyboard = page.getByTestId('hover-preview-storyboard')
  const skimState = await skimStatePromise
  expect(skimState.storyboardVisible).toBe(true)
  expect(skimState.preserveAspectRatio).toBe('xMidYMid meet')
  const storyboardCueStart = Number(skimState.cueStart)
  expect(storyboardCueStart).toBe(2)
  expect(rawCursorTime).toBeCloseTo(2.4, 2)
  expect(storyboardCueStart).not.toBeCloseTo(rawCursorTime, 1)
  expect(skimState.clipId).toBeTruthy()
  expect(skimState.clipPath).toBe(`url(#${skimState.clipId})`)
  expect(skimState.videoVisible).toBe(true)
  expect(skimState.videoPaused).toBe(true)
  expect(skimState.seeks).toBe(seeksBeforeSkim)
  const clock = card.locator('.hover-preview__clock')
  expect(skimState.clockRight).not.toBeNull()

  await expect(video).toBeVisible()
  await expect(storyboard).toHaveCount(0)
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(false)
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(2.1)
  expect(
    await page.evaluate(
      () => (window as unknown as { __hoverPreviewSeeks: number }).__hoverPreviewSeeks,
    ),
  ).toBe(seeksBeforeSkim + 1)
  const restClockBox = await clock.boundingBox()
  const soundBox = await card.getByRole('button', { name: 'Unmute preview' }).boundingBox()
  expect(restClockBox).not.toBeNull()
  expect(soundBox).not.toBeNull()
  expect(Math.abs(restClockBox!.x + restClockBox!.width - skimState.clockRight!)).toBeLessThan(1)
  expect(soundBox!.x + soundBox!.width).toBeLessThanOrEqual(restClockBox!.x)
  const seekedTimes = await page.evaluate(
    () => (window as unknown as { __hoverPreviewSeekedTimes: number[] }).__hoverPreviewSeekedTimes,
  )
  const restSeekTime = seekedTimes.at(-1)
  expect(restSeekTime).toBeCloseTo(storyboardCueStart, 2)
  expect(restSeekTime).not.toBeCloseTo(rawCursorTime, 1)

  await card.getByRole('button', { name: 'Unmute preview' }).click()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).muted))
    .toBe(false)
  await expect(page.locator('.album')).toHaveCount(0)

  const secondSkimStatePromise = nextSkimState()
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2, { steps: 4 })
  const secondSkimState = await secondSkimStatePromise
  expect(secondSkimState.storyboardVisible).toBe(true)
  expect(secondSkimState.videoPaused).toBe(true)
  await expect(video).toBeVisible()
  await expect(storyboard).toHaveCount(0)
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false)
  await expect.poll(() => video.evaluate((element) => element.muted)).toBe(false)
  await expect(card.locator('.card__thumb')).toHaveAttribute('data-hover-preview-mode', 'direct')

  await page.getByRole('tab', { name: 'Files' }).hover()
  await expect(video).toHaveCount(0)
  expect(forbidden).toEqual([])
})

test('uses the same real MP4 hover behavior on a bundle-album file card', async ({ page }) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real hover preview e2e')
  const forbidden: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/playback-decision') || url.includes('/playback-sessions')) {
      forbidden.push(url)
    }
  })
  await mockApi(page)
  await page.goto('/')
  await page.locator('[data-bundle-id="b0"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Bundle' }).click()

  const tile = page.locator('[data-file-id="f0"]')
  await tile.focus()
  await page.keyboard.press('Enter')
  await expect(tile).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.media-viewer')).toHaveCount(0)
  const secondTile = page.locator('[data-file-id="f1"]')
  await secondTile.focus()
  await page.keyboard.press('Space')
  await expect(secondTile).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.media-viewer')).toHaveCount(0)

  await tile.hover()
  const video = page.getByTestId('hover-preview-video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.1)
  await page.mouse.move(0, 0)
  await expect(video).toHaveCount(0)
  expect(forbidden).toEqual([])
})

test('previews a linked video card in the File Browser grid', async ({ page }) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real hover preview e2e')
  const forbidden: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/playback-decision') || url.includes('/playback-sessions')) {
      forbidden.push(url)
    }
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      'cairndex.filePrefs',
      JSON.stringify({ layout: 'grid', zoom: 200, sort: 'name', order: 'asc' }),
    )
  })
  await mockApi(page)
  await page.route(/\/api\/v1\/libraries\/lib1\/file-browser\/entries/, (route) =>
    route.fulfill({
      json: {
        path: '',
        entries: [
          {
            name: 'movie.mp4',
            relative_path: 'movie.mp4',
            kind: 'file',
            size_bytes: generatedMp4?.length ?? 0,
            modified_at: '2026-06-25T00:00:00Z',
            created_at: '2026-06-25T00:00:00Z',
            extension: 'mp4',
            mime_type: null,
            media_kind: 'video',
            supported: true,
            linked: true,
            bundle_id: 'b0',
            file_id: 'f0',
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
            video_codec: 'h264',
            audio_codec: 'aac',
            duration: 3,
            resume_position: null,
            unbundled: false,
          },
        ],
      },
    }),
  )
  await page.goto('/')
  await page.getByRole('tab', { name: 'Files' }).click()

  const card = page.locator('[data-relpath="movie.mp4"]')
  await card.hover()
  const video = page.getByTestId('hover-preview-video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.1)
  expect(forbidden).toEqual([])
})

/** File Browser rows for a folder holding one linked and one unlinked video. */
function fileBrowserVideos(size: number) {
  const base = {
    kind: 'file',
    size_bytes: size,
    modified_at: '2026-06-25T00:00:00Z',
    created_at: '2026-06-25T00:00:00Z',
    extension: 'mp4',
    mime_type: 'video/mp4',
    media_kind: 'video',
    supported: true,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    video_codec: 'h264',
    audio_codec: 'aac',
    resume_position: null,
    unbundled: false,
  }
  return [
    {
      ...base,
      name: 'movie.mp4',
      relative_path: 'movie.mp4',
      linked: true,
      bundle_id: 'b0',
      file_id: 'f0',
      duration: 3,
    },
    {
      ...base,
      name: 'loose.mp4',
      relative_path: 'loose.mp4',
      linked: false,
      bundle_id: null,
      file_id: null,
      duration: null,
    },
  ]
}

test('plays a linked File Browser video in the app player, not native controls', async ({
  page,
}) => {
  const decisions: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/playback-decision')) decisions.push(request.url())
  })
  await mockMedia(page)
  await mockApi(page)
  await page.route(/\/api\/v1\/libraries\/lib1\/file-browser\/entries/, (route) =>
    route.fulfill({ json: { path: '', entries: fileBrowserVideos(generatedMp4?.length ?? 0) } }),
  )
  await page.goto('/')
  await page.getByRole('tab', { name: 'Files' }).click()
  await page.locator('.file-row__name', { hasText: 'movie.mp4' }).dblclick()

  // The app's viewer, with its own control bar — a native <video controls> would
  // have neither of these.
  await expect(page.getByTestId('media-controls')).toBeVisible()
  const video = page.getByTestId('media-video')
  await expect(video).not.toHaveAttribute('controls', /.*/)

  // Being indexed, it goes through the real playback pipeline and gets the
  // manifest's subtitle track.
  await expect.poll(() => decisions.length).toBeGreaterThan(0)
  await expect(page.locator('[data-testid="media-video"] track')).toHaveAttribute(
    'src',
    /subtitles\/s0\/vtt/,
  )

  // Arrow keys seek the track; they do not step to the next file.
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(5)
  await expect(page.locator('.mv-subtitle')).toContainText('movie.mp4')
})

test('plays an unindexed File Browser video with no playback decision', async ({ page }) => {
  const decisions: string[] = []
  const pathReads: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/playback-decision') || url.includes('/playback-sessions')) {
      decisions.push(url)
    }
    if (url.includes('/file?path=')) pathReads.push(url)
  })
  await mockMedia(page)
  await mockApi(page)
  await page.route(/\/api\/v1\/libraries\/lib1\/file-browser\/entries/, (route) =>
    route.fulfill({ json: { path: '', entries: fileBrowserVideos(generatedMp4?.length ?? 0) } }),
  )
  await page.route(/\/api\/v1\/libraries\/lib1\/file\?path=/, (route) =>
    fulfillMedia(route, generatedMp4 ?? Buffer.from([])),
  )
  await page.goto('/')
  await page.getByRole('tab', { name: 'Files' }).click()
  await page.locator('.file-row__name', { hasText: 'loose.mp4' }).dblclick()

  // Same player shell, but sourced straight from the path — an unindexed file has
  // no row to decide on, so no decision/session request may be made for it.
  await expect(page.getByTestId('media-controls')).toBeVisible()
  await expect.poll(() => pathReads.some((url) => url.includes('path=loose.mp4'))).toBe(true)
  expect(decisions).toEqual([])

  // The playlist is the folder — both of its videos, in the listing's order —
  // not the bundle the other one happens to belong to.
  await expect(page.locator('.mv-subtitle')).toContainText('loose.mp4 · 1 / 2')
  await page.getByRole('button', { name: 'Next file' }).click()
  await expect(page.locator('.mv-subtitle')).toContainText('movie.mp4 · 2 / 2')
})

test('skims an MKV cover through storyboards without stream or session requests', async ({
  page,
}) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await mockApi(page, {
    summaryPatch: {
      resume_relative_path: 'movie.mkv',
      resume_container: 'matroska,webm',
      resume_video_codec: 'h264',
      resume_audio_codec: 'aac',
    },
  })
  await page.goto('/')

  const thumb = page.locator('[data-bundle-id="b0"] .card__thumb')
  await thumb.hover()
  const storyboard = page.getByTestId('hover-preview-storyboard')
  await expect(storyboard).toBeVisible()
  const initial = await storyboard.getAttribute('data-cue-position')
  const box = await thumb.boundingBox()
  if (!box) throw new Error('missing storyboard hover card bounds')
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
  await expect.poll(() => storyboard.getAttribute('data-cue-position')).not.toBe(initial)

  expect(requests.some((url) => url.includes('/storyboard.vtt'))).toBe(true)
  expect(requests.some((url) => url.includes('/stream'))).toBe(false)
  expect(requests.some((url) => url.includes('/playback-decision'))).toBe(false)
  expect(requests.some((url) => url.includes('/playback-sessions'))).toBe(false)
})

test('falls back to a storyboard when a direct hover stream cannot decode', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await mockApi(page, { hoverStreamFailure: true })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').hover()
  await expect(page.getByTestId('hover-preview-storyboard')).toBeVisible()
  await expect(page.getByTestId('hover-preview-video')).toHaveCount(0)
  expect(requests.some((url) => url.includes('/stream'))).toBe(true)
  expect(requests.some((url) => url.includes('/playback-decision'))).toBe(false)
  expect(requests.some((url) => url.includes('/playback-sessions'))).toBe(false)
})

test('sweeps across video cards without dwelling and starts no preview requests', async ({
  page,
}) => {
  let streamRequests = 0
  let storyboardRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/stream')) streamRequests += 1
    if (request.url().includes('/storyboard.vtt')) storyboardRequests += 1
  })
  await mockApi(page, { summaryCount: 8 })
  await page.goto('/')

  const cards = page.locator('[data-bundle-id]')
  await expect(cards).toHaveCount(8)
  for (let index = 0; index < 8; index += 1) {
    const box = await cards.nth(index).boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  await page.getByRole('tab', { name: 'Files' }).hover()
  await page.waitForTimeout(200)

  expect(streamRequests).toBe(0)
  expect(storyboardRequests).toBe(0)
  await expect(page.getByTestId('hover-preview-video')).toHaveCount(0)
})

test('never flashes the unplayable card while opening a playable video', async ({ page }) => {
  // Regression: the decision round-trip must show "Preparing playback…", not a
  // frame of the "can't be previewed" fallback, before the source resolves.
  await page.addInitScript(() => {
    ;(window as unknown as { __fallbackSeen: boolean }).__fallbackSeen = false
    new MutationObserver(() => {
      if (document.querySelector('.media-fallback')) {
        ;(window as unknown as { __fallbackSeen: boolean }).__fallbackSeen = true
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  })
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  await openMovie(page)
  expect(
    await page.evaluate(() => (window as unknown as { __fallbackSeen: boolean }).__fallbackSeen),
  ).toBe(false)
})

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
  // `f` leaves fullscreen and keeps watching; Escape is the *close* gesture and
  // now closes from fullscreen in one press (owner, 2026-07-27), so the rest of
  // this test uses `f` to get the viewer back to a window.
  await page.keyboard.press('F')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page.locator('.media-viewer')).toBeVisible()

  const cc = page.getByRole('button', { name: /hide subtitles/i })
  await expect(cc).toHaveAttribute('aria-pressed', 'true')
  // Owner remap (2026-07-27): subtitles toggled on V; C is speed-up now.
  await page.keyboard.press('V')
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

test('uses the resumed video for card preview even when artwork is an image', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page, { summaryPatch: { cover_key: 'img1' } })
  await page.goto('/')

  const thumb = page.locator('[data-bundle-id="b0"] .card__thumb')
  await expect(thumb).toHaveCSS('background-image', /bundles\/b0\/thumbnail/)
  await expect(thumb).toHaveAttribute('data-hover-preview-mode', 'direct')
})

test('opens and remembers the bundle cursor in ordered file navigation', async ({ page }) => {
  await mockMedia(page)
  const cursors: string[] = []
  await mockApi(page, { resumeFileId: 'img1', onCursor: (fileId) => cursors.push(fileId) })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  await expect(page.getByTestId('image-stage')).toBeVisible()
  await expect(page.locator('.mv-subtitle')).toContainText('poster.png · 2 / 3')
  await expect.poll(() => cursors.at(-1)).toBe('img1')

  await page.getByRole('button', { name: /next file/i }).click()
  await expect(page.locator('.mv-subtitle')).toContainText('movie.mkv · 3 / 3')
  await expect.poll(() => cursors.at(-1)).toBe('f1')
})

test('double-clicking an image closes the viewer, and the zoom readout cycles fit', async ({
  page,
}) => {
  // The image stage captures the pointer to pan, and capture retargets the later
  // double-click to the stage — so the close check never recognised it as media
  // and the fit-cycling handler ran instead: a double-click zoomed and stayed
  // open (owner report, 2026-07-30). Fit moved to the zoom readout.
  await mockMedia(page)
  await mockApi(page, { resumeFileId: 'img1' })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  const stage = page.getByTestId('image-stage')
  await expect(stage).toBeVisible()

  // The readout is the fit control now, so it takes its own clicks rather than
  // letting them through to the stage. (Which fit each click lands on is unit
  // tested; here the mocked image is small enough that fit and actual are both
  // 100%.)
  const zoom = page.getByTestId('image-zoom')
  await zoom.click()
  await expect(page.locator('.media-viewer')).toBeVisible()

  // The background toggle is a sibling of the readout; capture used to swallow
  // its click too, so it did nothing at all.
  const background = page.getByRole('button', { name: /toggle image background/i })
  await background.click()
  await expect(stage).not.toHaveClass(/mv-image-stage--dark/)

  // Centre, not a corner: the prev/next arrows overlay the stage's edges and the
  // zoom/background controls its bottom-right, and a double-click on any of those
  // is a control press rather than a press on the picture.
  await stage.dblclick()
  await expect(page.locator('.media-viewer')).toHaveCount(0)
})

test('every viewer notice shares one anchor and stacks', async ({ page }) => {
  // The export notice sat 64px higher than the resume notice, in its own shape,
  // so two messages about the same playback appeared at two unrelated places
  // (owner, 2026-07-30). They share one container now.
  await mockMedia(page)
  await mockApi(page, { progress: { position_s: 45, duration_s: 120, completed: false } })
  // Hang the sheet request so "Building contact sheet…" stays up to be measured.
  const sheetRequests: string[] = []
  await page.route('**/contact-sheet**', (route) => {
    sheetRequests.push(route.request().url())
  })
  await page.goto('/')

  const video = await openMovie(page)
  await expect(page.locator('.mv-resume')).toContainText('Resumed at')

  await video.click({ button: 'right' })
  await page.getByText('Save Contact Sheet…').click()
  await expect(page.getByRole('button', { name: '1600px' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByRole('button', { name: '2048px' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '2560px' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.mv-export-notice')).toContainText('Building contact sheet')
  await expect.poll(() => sheetRequests[0]).toContain('width=2048')

  const [resume, exporting] = await Promise.all([
    page.locator('.mv-resume').boundingBox(),
    page.locator('.mv-export-notice').boundingBox(),
  ])
  // Same vertical axis, to the pixel.
  expect(resume!.x + resume!.width / 2).toBeCloseTo(exporting!.x + exporting!.width / 2, 0)
  // Stacked in one column: the export notice sits directly above the resume
  // notice, separated only by the container's own 8px gap.
  expect(Math.round(resume!.y - (exporting!.y + exporting!.height))).toBe(8)
  // And both are in the shared container rather than positioning themselves.
  await expect(page.locator('.mv-toasts > .mv-resume')).toHaveCount(1)
  await expect(page.locator('.mv-toasts > .mv-export-notice')).toHaveCount(1)
})

test('escape closes the viewer in one press, from fullscreen too', async ({ page }) => {
  // Two presses used to be needed — one to leave fullscreen, one to close — and
  // the owner expects one (2026-07-27). Fullscreen is still dropped on the way
  // out so closing cannot strand the shell there.
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')
  await openMovie(page)
  await expect(page.locator('.media-viewer')).toBeVisible()

  await page.keyboard.press('F')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)

  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(page.locator('.media-viewer')).toHaveCount(0)
})

test('polishes click play, off-track scrub, seek step, and current-frame cover', async ({
  page,
}) => {
  await mockMedia(page)
  const coverWrites: Array<number | null> = []
  await mockApi(page, { onCoverFrame: (time) => coverWrites.push(time) })
  await page.goto('/')

  const video = await openMovie(page)
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false)

  // Left click is the play/pause gesture (plan 3 §7); right click opens the
  // app's own menu (the seam reserved on 2026-07-19, filled 2026-07-27) — the
  // native video menu is suppressed and playback is untouched.
  const nativeMenuAllowed = await video.evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    return element.dispatchEvent(event)
  })
  expect(nativeMenuAllowed).toBe(false)
  await expect(page.getByRole('menuitem', { name: 'Frame Back' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Frame Forward' })).toHaveCount(0)
  const playerMenuLabels = await page.getByRole('menuitem').allTextContents()
  expect(playerMenuLabels.indexOf('Set Frame as Video Cover')).toBeLessThan(
    playerMenuLabels.indexOf('Save Snapshot'),
  )
  expect(playerMenuLabels.indexOf('Reset Video Cover to Default')).toBeLessThan(
    playerMenuLabels.indexOf('Save Snapshot'),
  )
  await page.keyboard.press('Escape')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false)

  await video.click()
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
  await video.click()
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false)
  await video.click()
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)

  const settings = page.getByRole('button', { name: 'Playback settings' })
  await settings.click()
  await page.getByRole('slider', { name: 'Playback speed' }).fill('1.5')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).playbackRate)).toBe(1.5)
  await page.getByRole('slider', { name: 'Seek step' }).fill('3')
  await page.locator('.media-viewer').focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(30)

  const track = page.locator('.mv-seek__track')
  const box = await track.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(2800)
  await expect(page.locator('.mv-controls')).toHaveCSS('opacity', '1')
  await page.mouse.move(2, 2)
  await page.mouse.up()
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime)).toBe(0)

  // Cover actions moved out of the settings menu to the viewer's right-click
  // menu, with the other one-shot actions (owner, 2026-07-27).
  await video.evaluate((el) => ((el as HTMLVideoElement).currentTime = 42))
  await page.mouse.move(400, 400)
  await video.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Set Frame as Video Cover' }).click()
  await expect.poll(() => coverWrites.at(-1)).toBe(42)
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
  const contentRequests: string[] = []
  await mockApi(page, { onContent: (url) => contentRequests.push(url) })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  await expect(page.locator('.mv-filmstrip')).toHaveCount(0)
  await page.getByRole('button', { name: /next file/i }).click()
  await expect(page.getByTestId('image-stage')).toBeVisible()
  const image = page.locator('.mv-image')
  await expect
    .poll(() => contentRequests.some((url) => url.includes('/files/img1/content')))
    .toBe(true)
  await expect(image).toHaveAttribute('data-tier', 'original')
  await expect(image).toHaveAttribute('src', /\/files\/img1\/content$/)

  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.media-fallback')).toContainText("isn't playable")
})

test('shows a moved unsupported video as missing and refreshes the sidebar count', async ({
  page,
}) => {
  await mockMedia(page)
  const missingCounts: number[] = []
  let decisions = 0
  await mockApi(page, {
    missingCurrent: true,
    onViewCounts: (missing) => missingCounts.push(missing),
    onDecision: () => {
      decisions += 1
    },
  })
  await page.goto('/')

  const missingView = page.getByRole('button', { name: /Missing Files/ })
  await expect(missingView.locator('.nav-item__count')).toHaveText('0')
  await page.locator('[data-bundle-id="b0"]').dblclick()

  const fallback = page.locator('.media-fallback')
  await expect(fallback).toContainText('Missing file.')
  await expect(fallback).toContainText('no longer available at its linked path')
  await expect(fallback).not.toContainText("AVI container isn't playable")
  await expect(missingView.locator('.nav-item__count')).toHaveText('1')
  expect(missingCounts).toEqual(expect.arrayContaining([0, 1]))
  expect(decisions).toBe(0)
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
  await expect(image).toHaveAttribute('data-tier', 'preview1600')
  await expect(image).toHaveAttribute('src', /\/files\/img1\/preview\?.*size=1600/)
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

test('auto-advance consumes one ended transition in a three-video bundle', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page, { threeVideos: true })
  await page.goto('/')

  const video = await openMovie(page)
  await video.evaluate((element) => element.dispatchEvent(new Event('ended')))

  await expect(video).toHaveAttribute('src', /files\/f1\/stream/)
  await expect(page.locator('.mv-subtitle')).toContainText('part2.mp4 · 2 / 3')
  await page.waitForTimeout(100)
  await expect(video).not.toHaveAttribute('src', /files\/f2\/stream/)
})

test('shows a storyboard generated by the real backend job @fullstack', async ({ page }) => {
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
    const file = await apiPost<{ id: string }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/bundles/${bundle.id}/files`,
      {
        relative_path: 'story.mp4',
        role: 'primary_video',
        media_kind: 'video',
        mime_type: 'video/mp4',
      },
    )
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
    await waitStoryboardArtifacts(backend.baseUrl, library.id, file.id)
    const thumbnailUrl = `${backend.baseUrl}/api/v1/libraries/${library.id}/bundles/${bundle.id}/thumbnail`
    const automaticThumbnail = Buffer.from(await (await fetch(thumbnailUrl)).arrayBuffer())

    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    const card = page.locator(`[data-bundle-id="${bundle.id}"]`)
    const storyboardResponse = page.waitForResponse((response) =>
      response.url().includes(`/files/${file.id}/storyboard.vtt`),
    )
    await card.hover()
    expect((await storyboardResponse).status()).toBe(200)
    const hoverVideo = page.getByTestId('hover-preview-video')
    await expect(hoverVideo).toBeVisible()
    const hoverBounds = await card.locator('.card__thumb').boundingBox()
    if (!hoverBounds) throw new Error('missing real storyboard card bounds')
    const hoverX = hoverBounds.x + hoverBounds.width * (27 / 65)
    const hoverY = hoverBounds.y + hoverBounds.height / 2
    await page.mouse.move(hoverX, hoverY, { steps: 6 })
    await expect(card.locator('.card__thumb')).toHaveAttribute(
      'data-hover-preview-state',
      'skimming',
    )
    const hoverStoryboard = page.getByTestId('hover-preview-storyboard')
    await expect(hoverStoryboard).toBeVisible()
    await expect(hoverStoryboard).toHaveAttribute('data-cue-start', '26')
    const cueStart = Number(await hoverStoryboard.getAttribute('data-cue-start'))
    expect(cueStart).toBe(26)
    await prepareHoverFrameComparison(page)
    await page.mouse.move(hoverX + 0.5, hoverY)
    await expect(hoverStoryboard).toBeVisible()
    await armHoverFrameComparison(page)
    await page.mouse.move(hoverX + 1, hoverY)
    await expect(card.locator('.card__thumb')).toHaveAttribute(
      'data-hover-preview-state',
      'playing',
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __hoverPreviewFrameMatch: {
                  difference: number
                  time: number
                } | null
              }
            ).__hoverPreviewFrameMatch,
        ),
      )
      .not.toBeNull()
    const capturedFrame = await page.evaluate(
      () =>
        (
          window as unknown as {
            __hoverPreviewFrameMatch: { difference: number; time: number }
          }
        ).__hoverPreviewFrameMatch,
    )
    expect(capturedFrame.time).toBeGreaterThanOrEqual(cueStart)
    expect(capturedFrame.time).toBeLessThan(cueStart + 0.3)
    expect(capturedFrame.difference).toBeLessThan(12)
    await expect(hoverVideo).toBeVisible()
    await expect
      .poll(() => hoverVideo.evaluate((element) => (element as HTMLVideoElement).paused))
      .toBe(false)
    await expect
      .poll(() => hoverVideo.evaluate((element) => (element as HTMLVideoElement).currentTime))
      .toBeGreaterThan(cueStart + 0.05)
    await page.getByRole('tab', { name: 'Files' }).hover()
    await expect(hoverVideo).toHaveCount(0)

    await card.dblclick()
    await expect(page.getByTestId('media-video')).toHaveAttribute('src', /story\.mp4|stream/)
    await expect(page.locator('.mv-time')).toContainText('/ 1:05')

    await hoverSeekBar(page, 0.4)
    const preview = page.getByTestId('storyboard-preview')
    await expect(preview).toBeVisible()
    await expect(preview).toHaveCSS('background-image', /storyboard\/sb_001\.jpg/)

    const video = page.getByTestId('media-video')
    const coverTime = await video.evaluate((element) => {
      const media = element as HTMLVideoElement
      media.pause()
      media.currentTime = 26
      return media.currentTime
    })
    const setResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/files/${file.id}/cover-frame`) &&
        response.request().method() === 'POST',
    )
    await page.getByTestId('media-video').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Set Frame as Video Cover' }).click()
    const selected = (await (await setResponse).json()) as { cover_time: number | null }
    expect(selected.cover_time).toBeCloseTo(coverTime, 3)
    const selectedThumbnail = Buffer.from(await (await fetch(thumbnailUrl)).arrayBuffer())
    expect(selectedThumbnail.equals(automaticThumbnail)).toBe(false)

    const clearResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/files/${file.id}/cover-frame`) &&
        response.request().method() === 'DELETE',
    )
    await page.getByTestId('media-video').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Reset Video Cover to Default' }).click()
    expect((await (await clearResponse).json()) as { cover_time: number | null }).toMatchObject({
      cover_time: null,
    })
  } finally {
    if (!page.isClosed()) await page.close()
    if (backend) await stopBackend(backend.child)
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plays a remux HLS source through hls.js and shows the quality/audio menus', async ({
  page,
}) => {
  test.skip(hlsFixture === null, 'ffmpeg is unavailable; skipping HLS engine e2e')
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
  const deletes: string[] = []
  const decisions: Array<Record<string, unknown>> = []
  await mockApi(page, {
    forceHls: true,
    onSessionDelete: (url) => deletes.push(url),
    onDecision: (fileId, body) => {
      if (fileId === 'f0') decisions.push(body)
    },
  })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  const video = page.getByTestId('media-video')
  // hls.js attaches (Managed)MediaSource, so the element source is a blob/object
  // URL, never the progressive `/stream` — proof the HLS engine, not the native
  // engine, is driving playback.
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).src.includes('/files/f0/stream')))
    .toBe(false)
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime), { timeout: 15_000 })
    .toBeGreaterThan(0.2)
  await expect(page.getByTestId('media-controls')).toBeVisible()

  // Source-aware resolution submenu + audio-track menus come from the decision.
  await page.getByRole('button', { name: /playback settings/i }).click()
  const menu = page.getByTestId('settings-menu')
  const resolution = menu.getByRole('menuitem', { name: /Resolution/ })
  await expect(resolution).toHaveAttribute('aria-expanded', 'false')
  await resolution.click()
  await expect(resolution).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('menuitemradio', { name: '720p' })).toBeVisible()
  await expect(menu).toContainText('Audio')
  await expect(menu.getByRole('menuitemradio', { name: /Surround/ })).toBeVisible()

  // Picking a quality tier re-decides at the current playhead with the new cap.
  await menu.getByRole('menuitemradio', { name: '720p' }).click()
  await expect.poll(() => decisions.some((body) => body.max_height === 720)).toBe(true)

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.media-viewer')).toHaveCount(0)
  // Closing the player tears the HLS session down.
  await expect.poll(() => deletes.length).toBeGreaterThan(0)
})

test('transparently re-attaches a fresh session when HLS segments fail', async ({ page }) => {
  test.skip(hlsFixture === null, 'ffmpeg is unavailable; skipping HLS re-attach e2e')
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
  const decisions: Array<Record<string, unknown>> = []
  // The playlist loads but every media segment 404s — the same failure a session
  // that idled out during a long pause produces. The client should re-request a
  // decision rather than immediately surrendering to the fallback card.
  await mockApi(page, {
    forceHls: true,
    hlsBreak: true,
    onDecision: (fileId, body) => {
      if (fileId === 'f0') decisions.push(body)
    },
  })
  await page.goto('/')

  await page.locator('[data-bundle-id="b0"]').dblclick()
  await expect(page.getByTestId('media-video')).toBeVisible()
  // The initial decision plus at least one transparent re-attach.
  await expect.poll(() => decisions.length, { timeout: 20_000 }).toBeGreaterThan(1)
  // After the re-attach budget is spent the unplayable card finally shows.
  await expect(page.locator('.media-fallback')).toBeVisible({ timeout: 20_000 })
})

test('plays a real MKV over a backend remux session and tears it down on close @fullstack', async ({
  page,
}) => {
  test.skip(generatedMp4 === null, 'ffmpeg is unavailable; skipping real MKV HLS e2e')

  const libraryRoot = mkdtempSync(join(tmpdir(), 'cairndex-hls-lib-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'cairndex-hls-data-'))
  let backend: { baseUrl: string; child: ChildProcessWithoutNullStreams } | null = null
  try {
    makeMkv(join(libraryRoot, 'clip.mkv'))
    backend = await startBackend(dataDir)
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
      root_path: libraryRoot,
      display_name: 'HLS Test',
      create_if_missing: false,
    })
    const bundle = await apiPost<{ id: string }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/bundles`,
      { title: 'MKV Movie' },
    )
    await apiPost(backend.baseUrl, `/api/v1/libraries/${library.id}/bundles/${bundle.id}/files`, {
      relative_path: 'clip.mkv',
      role: 'primary_video',
      media_kind: 'video',
      mime_type: 'video/x-matroska',
    })
    const probe = await apiPost<{ id: string }>(
      backend.baseUrl,
      `/api/v1/libraries/${library.id}/jobs/probe`,
    )
    await waitApiJob(backend.baseUrl, probe.id)

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
    const sessionHits: string[] = []
    const deletes: string[] = []
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/playback-sessions/')) sessionHits.push(`${req.method()} ${url}`)
      if (req.method() === 'DELETE' && url.includes('/playback-sessions/')) deletes.push(url)
    })

    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.locator(`[data-bundle-id="${bundle.id}"]`).dblclick()

    const video = page.getByTestId('media-video')
    await expect(video).toBeVisible()
    // The MKV is not directly playable, so playback advances only if the real
    // remux session served fMP4 segments through hls.js.
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime), { timeout: 30_000 })
      .toBeGreaterThan(0.2)
    expect(sessionHits.some((hit) => hit.includes('index.m3u8'))).toBe(true)

    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('.media-viewer')).toHaveCount(0)
    await expect.poll(() => deletes.length, { timeout: 10_000 }).toBeGreaterThan(0)
    // The teardown must leave no orphaned transcode session dir on the server.
    const transcodeDir = join(dataDir, 'transcode')
    await expect
      .poll(() => (existsSync(transcodeDir) ? readdirSync(transcodeDir).length : 0), {
        timeout: 10_000,
      })
      .toBe(0)
  } finally {
    if (backend) await stopBackend(backend.child)
    rmSync(libraryRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the video stage fills the viewer, letterboxing in one direction only', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  const viewer = page.locator('.media-viewer')

  const [v, box] = await Promise.all([video.boundingBox(), viewer.boundingBox()])
  expect(v).not.toBeNull()
  expect(box).not.toBeNull()

  // The regression this pins: the stage used to carry padding that reserved space
  // for the top bar and controls, so black bands appeared on *all four* sides even
  // when the aspect ratio matched. The media element must now span the viewer on
  // both axes; `object-fit: contain` is what letterboxes the picture inside it,
  // in one direction only.
  expect(Math.round(v!.width)).toBe(Math.round(box!.width))
  expect(Math.round(v!.height)).toBe(Math.round(box!.height))
  expect(Math.round(v!.x)).toBe(Math.round(box!.x))
  expect(Math.round(v!.y)).toBe(Math.round(box!.y))
})

test('viewer top-right buttons stay with the media when the inspector is docked', async ({
  page,
}) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  await openMovie(page)
  await page.getByRole('button', { name: 'Show bundle inspector' }).click()

  const actions = page.locator('.mv-topbar__actions')
  const inspector = page.locator('.media-viewer > .inspector')
  await expect(inspector).toBeVisible()
  const [actionsBox, inspectorBox] = await Promise.all([
    actions.boundingBox(),
    inspector.boundingBox(),
  ])
  expect(actionsBox).not.toBeNull()
  expect(inspectorBox).not.toBeNull()

  // Keep the same 18px inset the actions use at the edge of the full viewer
  expect(Math.round(actionsBox!.x + actionsBox!.width)).toBe(Math.round(inspectorBox!.x - 18))
})

test('viewer chrome overlays the video and autohides when idle', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  const topbar = page.locator('.mv-topbar')
  const controls = page.locator('.mv-controls')

  // Chrome must sit *over* the media rather than beside it, or it would push the
  // video back into a padded box.
  for (const bar of [topbar, controls]) {
    const [barBox, videoBox] = await Promise.all([bar.boundingBox(), video.boundingBox()])
    expect(barBox).not.toBeNull()
    // Overlapping vertically with the video proves it is drawn on top of it.
    const overlaps =
      barBox!.y < videoBox!.y + videoBox!.height && barBox!.y + barBox!.height > videoBox!.y
    expect(overlaps).toBe(true)
  }

  // The top bar fades into the picture instead of being a solid black band.
  const topbarBg = await topbar.evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(topbarBg).toContain('gradient')
  expect(topbarBg).toContain('rgba(0, 0, 0, 0)')

  // Idle hides both; moving the pointer brings them back.
  await page.waitForTimeout(3000)
  await expect(topbar).toHaveCSS('opacity', '0')
  await expect(controls).toHaveCSS('opacity', '0')
  await page.mouse.move(400, 300)
  await expect(topbar).toHaveCSS('opacity', '1')
  await expect(controls).toHaveCSS('opacity', '1')
})

/** Pause and put the playhead exactly on `at`, settled into the player's state. */
async function parkPlayhead(page: Page, video: Locator, at: number, clock: string) {
  await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
  await video.evaluate((el, seconds) => ((el as HTMLVideoElement).currentTime = seconds), at)
  // The mark reads the player's state, not the element, so wait for the clock.
  await expect(page.locator('.mv-time')).toContainText(clock)
}

const clipRow = (page: Page, label: 'In' | 'Out') =>
  page
    .locator('[data-testid="clip-bar"] .mv-clip__row')
    .filter({ hasText: label })
    .locator('output')

test('marks a clip range with [ and ], then adjusts it a frame at a time', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await expect(page.locator('[data-testid="clip-bar"]')).toHaveCount(0)
  await parkPlayhead(page, video, 40, '0:40')

  // `[` opens the picker by marking the in-point at the playhead — the keys
  // plan 1 §2 reserved for this.
  await page.keyboard.press('[')
  await expect(page.locator('[data-testid="clip-bar"]')).toBeVisible()
  await expect(clipRow(page, 'In')).toHaveText('0:40.000')

  // `]` moves only the out-point.
  await video.evaluate((el) => ((el as HTMLVideoElement).currentTime = 46))
  await page.keyboard.press(']')
  await expect(clipRow(page, 'Out')).toHaveText('0:46.000')
  await expect(clipRow(page, 'In')).toHaveText('0:40.000')
  await expect(page.locator('.mv-clip__duration')).toHaveText('6.00 s')

  // The band and both handles are drawn on the seek bar in file proportions:
  // 40s and 46s of a two-minute video.
  await expect(page.locator('.mv-seek__range')).toBeVisible()
  const handlePct = (edge: string) =>
    page.locator(`.mv-seek__handle--${edge}`).evaluate((el) => parseFloat(el.style.left))
  expect(await handlePct('start')).toBeCloseTo(33.33, 1)
  expect(await handlePct('end')).toBeCloseTo(38.33, 1)

  // A frame nudge moves the edge by one frame *and* scrubs to it — the rule the
  // whole picker rests on, since a frame you cannot see cannot be placed.
  const bar = page.locator('[data-testid="clip-bar"]')
  await bar.getByRole('button', { name: 'Move end by one frame forward' }).click()
  await expect(clipRow(page, 'Out')).toHaveText('0:46.033')
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeCloseTo(46.033, 2)

  await bar.getByRole('button', { name: 'Move end by one frame back' }).click()
  await bar.getByRole('button', { name: 'Move end by one frame back' }).click()
  await expect(clipRow(page, 'Out')).toHaveText('0:45.967')

  // …and a coarse step is a whole second on the same edge.
  await bar.getByRole('button', { name: 'Move end forward one second' }).click()
  await expect(clipRow(page, 'Out')).toHaveText('0:46.967')
})

test('an edge stops short of the other, and the zoomed track magnifies the span', async ({
  page,
}) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 30, '0:30')
  await page.keyboard.press('[')

  const bar = page.locator('[data-testid="clip-bar"]')
  await expect(clipRow(page, 'In')).toHaveText('0:30.000')
  await expect(clipRow(page, 'Out')).toHaveText('0:35.000')

  // Walking the in-point forward stops a floor short of the out-point rather
  // than pushing it along or inverting the range.
  for (let i = 0; i < 8; i += 1) {
    await bar.getByRole('button', { name: 'Move start forward one second' }).click()
  }
  await expect(clipRow(page, 'Out')).toHaveText('0:35.000')
  await expect(clipRow(page, 'In')).toHaveText('0:34.900')

  // The magnified track covers the selection plus a half-second margin either
  // side — a hair over a second, against the file's two minutes. That ratio is
  // what makes a pixel worth a frame here and a second on the seek bar.
  const edges = page.locator('.mv-clip-zoom__edge')
  await expect(edges).toHaveCount(2)
  await expect(edges.nth(0)).toHaveText('0:34.400')
  await expect(edges.nth(1)).toHaveText('0:35.500')
})

test('dragging the seek-bar handle keeps the zoomed handles inside their track', async ({
  page,
}) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 30, '0:30')
  await page.keyboard.press('[')

  // The zoom window is frozen for the length of a gesture, so dragging the
  // *seek bar's* handle far to the right carries the out-point well outside it.
  // The magnified handle must pin to the end of its track, not escape into the
  // control bar (owner, 2026-08-15).
  const track = page.locator('.mv-clip-zoom__track')
  const seekHandle = page.locator('.mv-seek__handle--end')
  const trackBox = (await track.boundingBox())!
  const handleBox = (await seekHandle.boundingBox())!

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + 320, handleBox.y + handleBox.height / 2, { steps: 12 })

  for (const edge of ['start', 'end']) {
    const box = (await page.locator(`.mv-clip-zoom__handle--${edge}`).boundingBox())!
    const centre = box.x + box.width / 2
    expect(centre).toBeGreaterThanOrEqual(trackBox.x - 1)
    expect(centre).toBeLessThanOrEqual(trackBox.x + trackBox.width + 1)
  }
  const band = (await page.locator('.mv-clip-zoom__band').boundingBox())!
  expect(band.x + band.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 1)

  await page.mouse.up()
  // Released, the window re-fits the new selection and the handles come back in.
  const settled = (await page.locator('.mv-clip-zoom__handle--end').boundingBox())!
  expect(settled.x + settled.width / 2).toBeLessThan(trackBox.x + trackBox.width)
})

test('exports the marked range as a GIF and drops the artifact after', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)

  const calls: string[] = []
  await page.route('**/files/f0/exports**', async (route) => {
    const request = route.request()
    calls.push(request.method())
    if (request.method() === 'POST') {
      expect(request.postDataJSON()).toMatchObject({ kind: 'gif', start_s: 20, end_s: 25 })
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          export_id: 'e1',
          kind: 'gif',
          status: 'running',
          progress: 0.5,
          filename: 'movie.gif',
          error: null,
        }),
      })
    }
    if (request.method() === 'DELETE') return route.fulfill({ status: 204 })
    if (request.url().endsWith('/download')) {
      return route.fulfill({ status: 200, contentType: 'image/gif', body: 'GIF89a-fake' })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        export_id: 'e1',
        kind: 'gif',
        status: 'done',
        progress: 1,
        filename: 'movie.gif',
        error: null,
      }),
    })
  })
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 20, '0:20')
  await page.keyboard.press('[')
  await expect(page.locator('.mv-clip__duration')).toHaveText('5.00 s')

  const download = page.waitForEvent('download')
  await page.locator('[data-testid="clip-bar"]').getByRole('button', { name: 'Save GIF…' }).click()
  await expect(page.locator('.mv-export-notice')).toContainText('Building GIF')
  // Named from the title without doubling the source's extension.
  expect((await download).suggestedFilename()).toBe('movie.gif')
  await expect(page.locator('.mv-export-notice')).toContainText('GIF saved.')

  // Created, polled, downloaded — and the server told to drop the artifact
  // rather than leaving it to sit until the TTL sweeps it.
  expect(calls).toContain('POST')
  expect(calls).toContain('DELETE')
})

test('refuses to export a range longer than the cap', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 10, '0:10')
  await page.keyboard.press('[')
  await video.evaluate((el) => ((el as HTMLVideoElement).currentTime = 100))
  await page.keyboard.press(']')

  await expect(page.locator('.mv-clip__duration')).toHaveText('90.00 s')
  await expect(page.locator('.mv-clip__warn')).toContainText('max 30 s')
  await expect(
    page.locator('[data-testid="clip-bar"]').getByRole('button', { name: 'Save GIF…' }),
  ).toBeDisabled()
})

test('Set In past the out-point carries the clip and keeps its length', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 20, '0:20')
  await page.keyboard.press('[')
  await expect(page.locator('.mv-clip__duration')).toHaveText('5.00 s')

  // Clamping here used to collapse the clip to 0.10 s. The length is the thing
  // the owner has already decided; the click only says where it begins.
  await video.evaluate((el) => ((el as HTMLVideoElement).currentTime = 70))
  await expect(page.locator('.mv-time')).toContainText('1:10')
  await page
    .locator('[data-testid="clip-bar"]')
    .getByRole('button', { name: /Set In/ })
    .click()

  await expect(clipRow(page, 'In')).toHaveText('1:10.000')
  await expect(clipRow(page, 'Out')).toHaveText('1:15.000')
  await expect(page.locator('.mv-clip__duration')).toHaveText('5.00 s')
})

test('range mode stops at the out-point and loop implies it', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 20, '0:20')
  await page.keyboard.press('[')

  const bar = page.locator('[data-testid="clip-bar"]')
  const rangeToggle = bar.getByRole('button', { name: /Range/ })
  const loopToggle = bar.getByRole('button', { name: /Loop/ })
  await expect(rangeToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(loopToggle).toHaveAttribute('aria-pressed', 'false')

  // Loop is a modifier on Range, so asking for it turns Range on too.
  await loopToggle.click()
  await expect(loopToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(rangeToggle).toHaveAttribute('aria-pressed', 'true')

  // Dropping Loop leaves Range standing — stop at the end rather than repeat.
  await loopToggle.click()
  await expect(loopToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(rangeToggle).toHaveAttribute('aria-pressed', 'true')

  // Turning Range off turns everything off.
  await rangeToggle.click()
  await expect(rangeToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(loopToggle).toHaveAttribute('aria-pressed', 'false')
})

test('the clip selection does not follow the viewer to the next file', async ({ page }) => {
  await mockMedia(page)
  await mockApi(page)
  await page.goto('/')

  const video = await openMovie(page)
  await parkPlayhead(page, video, 15, '0:15')
  await page.keyboard.press('[')
  await expect(page.locator('[data-testid="clip-bar"]')).toBeVisible()

  // A span marked on one file would point at unrelated footage in the next.
  await page.getByRole('button', { name: /next file/i }).click()
  await expect(page.locator('[data-testid="clip-bar"]')).toHaveCount(0)
})
