import { expect, test } from 'vitest'

import { webPlatform } from './web'

test('keeps native host capabilities false and harmless in plain web', async () => {
  expect(webPlatform.kind).toBe('web')
  expect(webPlatform.canRevealInFinder).toBe(false)
  expect(webPlatform.canOpenWithDefaultApp).toBe(false)
  expect(webPlatform.canDragOutFiles).toBe(false)

  await expect(webPlatform.revealFile('lib', 'folder/file.mp4')).resolves.toBeUndefined()
  await expect(webPlatform.openFile('lib', 'folder/file.mp4')).resolves.toBeUndefined()
  await expect(webPlatform.startFileDrag([])).resolves.toBeUndefined()
  await expect(webPlatform.getLibraryMapping('lib')).resolves.toBeNull()
  await expect(webPlatform.locateLibrary('lib', 'portable-id')).resolves.toBeNull()
  await expect(webPlatform.clearLibraryMapping('lib')).resolves.toBeUndefined()
})

test('exposes no export save capability in the browser', async () => {
  // M11's Export dialog reads this flag to decide between a native Save As… and
  // an ordinary browser download; the web build must never claim the former.
  expect(webPlatform.canSaveExports).toBe(false)
  await expect(webPlatform.saveExport('clip.gif', new Uint8Array([1]))).resolves.toBeNull()
})
