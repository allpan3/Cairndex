import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

// Observe real decoded frames and media time independently of successful API requests
async function picture(page: Page) {
  return page.locator('video').evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 18
    const context = canvas.getContext('2d')!
    context.drawImage(video, 0, 0, 32, 18)
    return {
      time: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      width: video.videoWidth,
      pixels: [...context.getImageData(0, 0, 32, 18).data].reduce((a, b) => a + b, 0),
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
    }
  })
}

// Select a bundle through the actual catalog UI rather than replacing the production viewer
async function openPlayback(page: Page) {
  await page
    .getByRole('navigation', { name: 'Catalog families' })
    .getByRole('button', { name: 'Bundles', exact: true })
    .click()
  await page
    .getByRole('navigation', { name: 'Bundles', exact: true })
    .getByRole('button', { name: 'Synthetic playback', exact: true })
    .click()
  await page.getByRole('button', { name: 'Open media on this device', exact: true }).click()
}

// Inspect only synthetic private rows; immutable history must not contain runtime observations
function history(dataDir: string, serverDir: string) {
  return execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'import hashlib,sqlite3,sys; from pathlib import Path; p=next(Path(sys.argv[1]).glob("replicas/*/replica.db")); d=sqlite3.connect(p); print(hashlib.sha256(repr(d.execute("SELECT id,raw FROM events ORDER BY id").fetchall()).encode()).hexdigest())',
      dataDir,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
}

// Two browsers and servers have different source availability and exchange metadata during playback
test('replica media keeps local availability, playback and exchange independent @fullstack', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-replica-media-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const original = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1])))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  await cp(original, roots[0], { recursive: true })
  await cp(original, roots[1], { recursive: true })
  await rm(join(roots[1], 'Playback/movie.mp4'))
  const privateDirs = [join(scratch, 'private-A'), join(scratch, 'private-B')]
  const backends = [await startBackend(privateDirs[0]), await startBackend(privateDirs[1])]
  const contexts = [await browser.newContext(), await browser.newContext()]
  const hashes = new Map<string, string>()
  for (const filename of await readdir(join(roots[0], 'Playback'))) {
    hashes.set(
      filename,
      createHash('sha256')
        .update(await readFile(join(roots[0], 'Playback', filename)))
        .digest('hex'),
    )
  }
  try {
    const libraries = await Promise.all(
      backends.map((backend, index) =>
        apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: roots[index],
        }),
      ),
    )
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    const [a, b] = pages
    const base = libraries.map(
      (library, index) => `${backends[index].baseUrl}/api/v1/libraries/${library.id}`,
    )
    for (let index = 0; index < pages.length; index++) {
      await proxyApi(pages[index], backends[index].baseUrl)
      await pages[index].goto('/')
      await pages[index].getByRole('button', { name: 'Metadata review', exact: true }).click()
      await expect(
        pages[index].getByRole('heading', { name: 'Library catalog', exact: true }),
      ).toBeVisible()
      await expect(
        pages[index]
          .getByRole('navigation', { name: 'Bundles', exact: true })
          .getByRole('button', { name: 'Synthetic playback', exact: true }),
      ).toBeVisible()
    }
    const before = privateDirs.map((directory) => history(directory, serverDir))
    await openPlayback(a)
    await expect(a.locator('video')).toBeVisible()
    await expect.poll(async () => (await picture(a)).time).toBeGreaterThan(1)
    expect((await picture(a)).pixels).toBeGreaterThan(32 * 18 * 255)
    await openPlayback(b)
    await expect(b.getByText('Media unavailable on this device.', { exact: true })).toBeVisible()
    // One device can recover its absent file without any shared metadata operation
    await cp(join(roots[0], 'Playback/movie.mp4'), join(roots[1], 'Playback/movie.mp4'))
    await b.getByRole('button', { name: 'Retry local media', exact: true }).click()
    await expect.poll(async () => (await picture(b)).time).toBeGreaterThan(1)
    await b.locator('.media-viewer').press('Escape')
    // Paused seeks preserve pause and reopening resumes this device's last playhead
    await a.locator('video').evaluate((video: HTMLVideoElement) => {
      video.pause()
      video.currentTime = 23
    })
    await expect.poll(async () => (await picture(a)).time).toBeCloseTo(23, 0)
    await a.locator('.media-viewer').press('Escape')
    await openPlayback(a)
    await expect.poll(async () => (await picture(a)).time).toBeGreaterThan(20)
    await expect
      .poll(async () =>
        a
          .locator('video')
          .evaluate((video: HTMLVideoElement) =>
            [...video.textTracks].some((track) => track.activeCues && track.activeCues.length > 0),
          ),
      )
      .toBe(true)
    expect(privateDirs.map((directory) => history(directory, serverDir))).toEqual(before)
    // A peer edits metadata while the first device runs hands-off beyond the old early-end boundary
    const start = await picture(a)
    await b
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Synthetic title during playback')
    await b.getByRole('button', { name: 'Save catalog changes', exact: true }).click()
    await expect(b.getByText('Saved here', { exact: true })).toBeVisible()
    await expect.poll(() => history(privateDirs[1], serverDir)).not.toBe(before[1])
    for (let round = 0; round < 4; round++) {
      await cp(
        join(roots[1], '.cairndex/replica/objects'),
        join(roots[0], '.cairndex/replica/objects'),
        { recursive: true },
      )
      await a.waitForTimeout(17_000)
    }
    const advanced = await picture(a)
    expect(advanced.time - start.time).toBeGreaterThan(60)
    expect(advanced.frames).toBeGreaterThan(start.frames)
    expect(advanced.duration).toBeGreaterThan(149)
    // Only a genuine normal end advances to the next ordered image
    await a.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 149
      void video.play()
    })
    await expect(a.locator('img.mv-image')).toBeVisible({ timeout: 15_000 })
    await a.mouse.move(300, 250)
    await a.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect.poll(async () => (await picture(a)).time).toBeGreaterThan(1)
    // MKV reaches copy-only HLS and the following AVI reaches actual transcode
    await a.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect.poll(async () => (await picture(a)).time).toBeGreaterThan(1)
    await a.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(a.locator('img.mv-image')).toBeVisible()
    await a.locator('.media-viewer').press('Escape')
    await expect(a.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Synthetic title during playback',
    )
    // Saved moments open their actual cataloged video at the authored time
    await a
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Moments', exact: true })
      .click()
    await a
      .getByRole('navigation', { name: 'Moments', exact: true })
      .getByRole('button', { name: 'Synthetic moment', exact: true })
      .click()
    await a.getByRole('button', { name: 'Open media on this device', exact: true }).click()
    await expect.poll(async () => (await picture(a)).time).toBeGreaterThan(41)
    expect((await picture(a)).time).toBeLessThan(48)
    await a.locator('.media-viewer').press('Escape')
    expect(history(privateDirs[0], serverDir)).toBe(history(privateDirs[1], serverDir))
    for (const [filename, hash] of hashes) {
      expect(
        createHash('sha256')
          .update(await readFile(join(roots[0], 'Playback', filename)))
          .digest('hex'),
      ).toBe(hash)
    }
    expect(await readdir(join(roots[0], '.cairndex'))).toEqual(
      expect.arrayContaining(['manifest.json', 'replica']),
    )
    expect(await readdir(join(roots[0], '.cairndex'))).not.toContain('cache')
    // Serving release stops all device-local media sessions without losing the catalog
    await fetch(`${base[0]}/ownership/release`, { method: 'POST' })
    await fetch(`${base[0]}/ownership/reopen`, { method: 'POST' })
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()))
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})

// The portable viewer saves a contact sheet and a GIF from this device's bytes
test('portable viewer scrubs a storyboard and exports a contact sheet and a GIF @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-replica-exports-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]), duration=40))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    await apiPost(backend.baseUrl, '/api/v1/libraries/register', { root_path: root })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Bundles', exact: true })
        .getByRole('button', { name: 'Synthetic playback', exact: true }),
    ).toBeVisible()
    await openPlayback(page)
    await expect.poll(async () => (await picture(page)).time).toBeGreaterThan(1)

    // The server makes the storyboard in the background after the viewer opens
    const seek = page.getByLabel('Seek', { exact: true })
    const preview = page.getByTestId('storyboard-preview')
    await expect(async () => {
      // Controls hide after 2.6 s without pointer movement and then take no pointer
      // events, so a slow storyboard outlasts them; moving over the video shows them
      await page.locator('video').hover()
      await seek.hover({ position: { x: 20, y: 2 } })
      await expect(preview).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 60_000 })
    const sheetImage = await preview.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    )
    expect(sheetImage).toContain('/storyboard/sb_001.jpg?v=')
    expect(
      await page.evaluate(async (value) => (await fetch(value.slice(5, -2))).status, sheetImage),
    ).toBe(200)

    await page.locator('video').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Save Contact Sheet…', exact: true }).click()
    const sheetOptions = page.getByRole('dialog', { name: 'Contact sheet options' })
    const sheetDownload = page.waitForEvent('download')
    await sheetOptions.getByRole('button', { name: 'Save', exact: true }).click()
    const sheet = await sheetDownload
    expect(sheet.suggestedFilename()).toMatch(/contact sheet\.jpg$/)
    const sheetBytes = await readFile((await sheet.path())!)
    expect([...sheetBytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])

    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.pause()
      video.currentTime = 5
    })
    await expect.poll(async () => (await picture(page)).time).toBeCloseTo(5, 0)
    await page.locator('.media-viewer').press('[')
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 7
    })
    await expect.poll(async () => (await picture(page)).time).toBeCloseTo(7, 0)
    await page.locator('.media-viewer').press(']')
    await page.getByRole('button', { name: 'Save GIF…', exact: true }).click()
    const gifOptions = page.getByRole('dialog', { name: 'GIF options' })
    const gifDownload = page.waitForEvent('download')
    await gifOptions.getByRole('button', { name: 'Save', exact: true }).click()
    const gif = await gifDownload
    expect(gif.suggestedFilename()).toMatch(/\.gif$/)
    expect((await readFile((await gif.path())!)).subarray(0, 4).toString()).toBe('GIF8')
    expect(await readdir(join(root, '.cairndex'))).not.toContain('cache')
  } finally {
    // The open workspace keeps polling, and a stopped backend fails its proxy
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

// Moments are catalog rows: marked in the portable viewer, listed in its rail, edited by jobs
test('portable viewer marks, comments on and deletes moments @fullstack', async ({ page }) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-replica-moments-'))
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.replica_media_fixture import create_playable; print(create_playable(parent=Path(sys.argv[1]), duration=60))',
      scratch,
    ],
    { cwd: serverDir },
  )
    .toString()
    .trim()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Metadata review', exact: true }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Bundles', exact: true })
        .getByRole('button', { name: 'Synthetic playback', exact: true }),
    ).toBeVisible()
    await openPlayback(page)
    await expect.poll(async () => (await picture(page)).time).toBeGreaterThan(1)
    // Pause through the player, which a capture reads, rather than only the element
    await page.locator('.media-viewer').press('Space')
    await expect.poll(async () => (await picture(page)).paused).toBe(true)
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.currentTime = 10
    })
    await expect(page.locator('.mv-time')).toContainText('0:10')

    // `b` saves the frame at the playhead and opens the rail on its comment box
    await page.locator('.media-viewer').press('b')
    await expect(page.locator('.mv-export-notice')).toContainText('Moment saved at 0:10')
    const rail = page.getByRole('complementary', { name: 'Moments' })
    const comment = rail.getByLabel('Moment comment')
    await expect(comment).toBeFocused()
    await comment.fill('Synthetic mark')
    await comment.press('Enter')
    await expect(rail.getByText('Synthetic mark')).toBeVisible()
    await expect(rail.locator('.moment-row__time')).toHaveText(['0:10', '0:42'])
    await expect(page.locator('.mv-seek__moment-tick')).toHaveCount(1)
    await expect(page.locator('.mv-seek__moment-band')).toHaveCount(1)

    // The comment box hands focus back, so the next press reaches the viewer
    await page.keyboard.press('b')
    await expect(page.locator('.mv-export-notice')).toContainText('Already marked at 0:10')

    const listed = () =>
      page.evaluate(async (id) => {
        const response = await fetch(
          `/api/v1/libraries/${id}/replica/catalog/bundles/bundle-000001/moments`,
        )
        return ((await response.json()) as { items: { start_s: number; comment: string }[] }).items
      }, library.id)
    await expect
      .poll(async () => (await listed()).map((item) => [item.start_s, item.comment]))
      .toEqual([
        [10, 'Synthetic mark'],
        [42, 'Synthetic moment'],
      ])

    // The seeded span arms the range loop, and the new frame can be forgotten
    await rail.getByRole('button', { name: 'Range loop from 0:42' }).click()
    await expect(
      page.getByTestId('clip-bar').getByRole('button', { name: 'Range loop' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await rail.getByRole('button', { name: 'Moment actions for 0:10' }).click()
    await page.getByRole('menuitem', { name: 'Delete Moment', exact: true }).click()
    await expect(rail.locator('.moment-row__time')).toHaveText(['0:42'])
    await expect.poll(async () => (await listed()).length).toBe(1)
    await expect(page.locator('.mv-seek__moment-tick')).toHaveCount(0)
    expect(await readdir(join(root, '.cairndex'))).not.toContain('cache')
  } finally {
    // The open workspace keeps polling, and a stopped backend fails its proxy
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
