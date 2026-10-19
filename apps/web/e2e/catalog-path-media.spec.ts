import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, proxyApi, startBackend, stopBackend } from './realBackend'

test('portable File Browser mixes unindexed video, audio and images with linked resume @fullstack', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-path-viewer-'))
  const root = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'from pathlib import Path; import sys; from cairndex.devtools.discovery_fixture import create_discovery; print(create_discovery(parent=Path(sys.argv[1]),playable=True))',
      scratch,
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)), encoding: 'utf8' },
  ).trim()
  await cp(join(root, 'Playback/movie.mp4'), join(root, 'Playback/loose.mp4'))
  await cp(join(root, 'Playback/preview.tiff'), join(root, 'Playback/loose.tiff'))
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      'import wave,sys; w=wave.open(sys.argv[1],"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(bytes(16000)); w.close()',
      join(root, 'Playback/loose.wav'),
    ],
    { cwd: fileURLToPath(new URL('../../server/', import.meta.url)) },
  )
  const hashes = async () =>
    Promise.all(
      (await readdir(join(root, 'Playback'))).sort().map(async (name) =>
        createHash('sha256')
          .update(await readFile(join(root, 'Playback', name)))
          .digest('hex'),
      ),
    )
  const beforeBytes = await hashes()
  const backend = await startBackend(join(scratch, 'private'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const base = `/api/v1/libraries/${library.id}`
    const read = async (path: string) => (await fetch(backend.baseUrl + base + path)).json()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.locator('[data-relpath="Playback"]').dblclick()
    const loose = page.locator('[data-relpath="Playback/loose.mp4"]')
    await expect(loose).toBeVisible()
    const before = await read('/replica/catalog/entities/asset_files/media-direct')
    const local = await read('/replica/media/files/media-direct')
    const progress = await fetch(backend.baseUrl + base + '/files/media-direct/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position_s: 7, duration_s: 18, source_generation: local.generation }),
    })
    expect(progress.ok).toBe(true)
    await loose.dblclick()
    const viewer = page.locator('.media-viewer')
    await expect(viewer).toBeVisible()
    const time = () =>
      viewer
        .locator('video')
        .evaluate((video: HTMLVideoElement) => (video.readyState >= 2 ? video.currentTime : 0))
    await expect.poll(time).toBeGreaterThan(0.2)
    await page.mouse.move(300, 250)
    await viewer.getByRole('button', { name: 'Info', exact: true }).click()
    const files = viewer.getByRole('listbox', { name: 'Files', exact: true })
    await files.getByRole('option').filter({ hasText: 'movie.mp4' }).click()
    await expect.poll(time).toBeGreaterThan(6)
    await viewer.locator('video').evaluate((video: HTMLVideoElement) => {
      video.pause()
      video.currentTime = 11
    })
    await files.getByRole('option').filter({ hasText: 'loose.tiff' }).click()
    const image = viewer.locator('img.mv-image')
    await expect(image).toBeVisible()
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    expect(await image.getAttribute('src')).toContain('source_generation=')
    await expect
      .poll(
        async () =>
          (await read('/replica/media/files/media-direct')).playback?.progress?.position_s ?? 0,
      )
      .toBeGreaterThan(10)
    await page.screenshot({ path: test.info().outputPath('synthetic-path-viewer.png') })
    await files.getByRole('option').filter({ hasText: 'loose.mp4' }).click()
    await expect.poll(time).toBeGreaterThan(0.2)
    await files.getByRole('option').filter({ hasText: 'loose.wav' }).click()
    await expect(viewer.locator('audio')).toBeVisible()
    await expect
      .poll(() =>
        viewer
          .locator('audio')
          .evaluate((audio: HTMLAudioElement) => (audio.readyState >= 2 ? audio.duration : 0)),
      )
      .toBeGreaterThan(0)
    await viewer.press('Escape')
    expect(await read('/replica/catalog/entities/asset_files/media-direct')).toEqual(before)
    expect(await hashes()).toEqual(beforeBytes)
  } finally {
    await page.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
