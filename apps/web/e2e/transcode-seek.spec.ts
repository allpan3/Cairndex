import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

test('a portable transcode seeks only when the seek-bar drag ends @fullstack', async ({ page }) => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-transcode-seek-'))
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
    await openMetadataReview(page)
    await page
      .getByRole('navigation', { name: 'Catalog families' })
      .getByRole('button', { name: 'Files', exact: true })
      .click()
    await page
      .getByRole('navigation', { name: 'Files', exact: true })
      .getByRole('button', { name: 'fallback.avi', exact: true })
      .click()
    const decision = page.waitForResponse(
      (response) =>
        response.url().includes('/files/media-fallback/playback-decision') &&
        response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Open media on this device', exact: true }).click()
    expect((await (await decision).json()).method).toBe('transcode')
    const video = page.getByTestId('media-video')
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(0.2)
    await video.evaluate((media: HTMLVideoElement) => {
      media.pause()
      media.dataset.testSeeks = '0'
      media.addEventListener('seeking', () => {
        media.dataset.testSeeks = String(Number(media.dataset.testSeeks) + 1)
      })
    })

    const track = page.getByRole('slider', { name: 'Seek', exact: true })
    await page.mouse.move(300, 250)
    const box = await track.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height / 2, { steps: 8 })
    // Let the ordinary in-drag throttle expire while the pointer is still down
    await page.waitForTimeout(500)
    expect(await video.getAttribute('data-test-seeks')).toBe('0')
    await page.mouse.up()
    await expect.poll(() => video.getAttribute('data-test-seeks')).toBe('1')
    await expect
      .poll(() => video.evaluate((media: HTMLVideoElement) => media.currentTime / media.duration))
      .toBeCloseTo(0.8, 1)
    await page.locator('.media-viewer').press('Escape')
  } finally {
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
