import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { FileRead } from '../../api/client'
import { setActiveLibraryId } from '../../api/client'
import { ImageStage } from './ImageStage'
import { viewerItemFromFile } from './viewerItem'

interface DecodeRequest {
  src: string
  resolve: () => void
  reject: () => void
}

let resizeObserverCallback: ResizeObserverCallback | null = null

// Build the FileRead shape used by viewer tests
function file(overrides: Partial<FileRead> = {}): FileRead {
  return {
    id: 'f1',
    bundle_id: 'b1',
    relative_path: 'photo.png',
    original_filename: 'photo.png',
    display_title: 'Photo',
    role: 'image',
    media_kind: 'image',
    mime_type: 'image/png',
    sequence: 0,
    size_bytes: 123,
    availability: 'available',
    quick_fingerprint: '123:456',
    cover_time: null,
    supported: true,
    tech_metadata: { width: 1600, height: 1000 },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  }
}

// Render ImageStage inside the viewer root used for scoped shortcuts
function renderStage(imageFile: FileRead, onError = vi.fn()) {
  return render(
    <div className="media-viewer">
      <ImageStage key={imageFile.id} item={viewerItemFromFile(imageFile)} onError={onError} />
    </div>,
  )
}

// Mock browser layout and image decoding for deterministic jsdom tests
function installBrowserMocks(autoResolve = true): DecodeRequest[] {
  setActiveLibraryId('lib1')
  const decodes: DecodeRequest[] = []
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback
    }
    observe() {}
    disconnect() {}
  }
  class MockImage {
    decoding = ''
    src = ''
    naturalWidth = 1600
    naturalHeight = 1000
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    decode() {
      return new Promise<void>((resolve, reject) => {
        decodes.push({
          src: this.src,
          resolve: () => {
            resolve()
            this.onload?.()
          },
          reject,
        })
        if (autoResolve) {
          resolve()
          this.onload?.()
        }
      })
    }
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.stubGlobal('Image', MockImage)
  return decodes
}

afterEach(() => {
  resizeObserverCallback = null
  vi.restoreAllMocks()
  setActiveLibraryId(null)
})

describe('ImageStage', () => {
  test('resets transform when the file changes', async () => {
    installBrowserMocks()
    const { rerender } = renderStage(file())
    const stage = screen.getByTestId('image-stage')
    const img = screen.getByRole('img')

    fireEvent.wheel(stage, { deltaY: -400, clientX: 0, clientY: 0 })
    await waitFor(() => expect(img.style.transform).toContain('scale(1.822'))

    rerender(
      <div className="media-viewer">
        <ImageStage
          key="f2"
          item={viewerItemFromFile(file({ id: 'f2', relative_path: 'other.png' }))}
          onError={vi.fn()}
        />
      </div>,
    )

    await waitFor(() => expect(screen.getByRole('img').style.transform).toContain('scale(1)'))
  })

  test('keeps the current tier visible until decode resolves', async () => {
    const decodes = installBrowserMocks(false)
    renderStage(file({ relative_path: 'still.heic', mime_type: 'image/heic' }))
    const img = screen.getByRole('img') as HTMLImageElement

    expect(img.src).toContain('/api/v1/libraries/lib1/bundles/b1/files/f1/thumbnail')
    await waitFor(() => expect(decodes[0]?.src).toContain('size=1600'))
    expect(img.src).toContain('/api/v1/libraries/lib1/bundles/b1/files/f1/thumbnail')

    await act(async () => decodes[0]!.resolve())
    await waitFor(() => expect(img.src).toContain('/api/v1/libraries/lib1/files/f1/preview'))
    expect(img.src).toContain('size=1600')
  })

  test('keeps the last good tier when a higher tier fails', async () => {
    const decodes = installBrowserMocks(false)
    const onError = vi.fn()
    renderStage(file({ relative_path: 'still.heic', mime_type: 'image/heic' }), onError)
    const img = screen.getByRole('img') as HTMLImageElement

    await waitFor(() => expect(decodes[0]?.src).toContain('size=1600'))
    await act(async () => decodes[0]!.reject())

    expect(img.src).toContain('/api/v1/libraries/lib1/bundles/b1/files/f1/thumbnail')
    expect(onError).not.toHaveBeenCalled()
  })

  test('native images upgrade directly from thumbnail to original content', async () => {
    const decodes = installBrowserMocks(false)
    renderStage(file({ relative_path: 'photo.png', mime_type: 'image/png' }))
    const img = screen.getByRole('img') as HTMLImageElement

    await waitFor(() =>
      expect(decodes[0]?.src).toContain('/api/v1/libraries/lib1/files/f1/content'),
    )
    expect(decodes[0]!.src).not.toContain('/preview')
    await act(async () => decodes[0]!.resolve())

    await waitFor(() => expect(img.src).toContain('/api/v1/libraries/lib1/files/f1/content'))
  })

  test('keeps the wanted decode alive when viewport measurement changes fit scale', async () => {
    const decodes = installBrowserMocks(false)
    let viewport = { width: 0, height: 0 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          right: viewport.width,
          bottom: viewport.height,
          left: 0,
          width: viewport.width,
          height: viewport.height,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    renderStage(file({ relative_path: 'large.png', mime_type: 'image/png' }))
    const img = screen.getByRole('img') as HTMLImageElement

    await waitFor(() => expect(decodes).toHaveLength(1))
    viewport = { width: 800, height: 600 }
    act(() => resizeObserverCallback?.([], {} as ResizeObserver))

    await waitFor(() => expect(screen.getByTestId('image-zoom')).toHaveTextContent('50%'))
    expect(decodes).toHaveLength(1)
    await act(async () => decodes[0]!.resolve())

    await waitFor(() => expect(img).toHaveAttribute('data-tier', 'original'))
    expect(img.src).toContain('/api/v1/libraries/lib1/files/f1/content')
  })

  test('requests the 2560 preview only after zooming past native scale', async () => {
    const decodes = installBrowserMocks(false)
    renderStage(file({ relative_path: 'still.heic', mime_type: 'image/heic' }))
    const stage = screen.getByTestId('image-stage')
    const img = screen.getByRole('img') as HTMLImageElement

    await waitFor(() => expect(decodes).toHaveLength(1))
    expect(decodes[0]!.src).toContain('size=1600')
    await act(async () => decodes[0]!.resolve())
    await waitFor(() => expect(img.src).toContain('size=1600'))
    expect(decodes).toHaveLength(1)

    fireEvent.wheel(stage, { deltaY: -400, clientX: 0, clientY: 0 })
    await waitFor(() => expect(decodes).toHaveLength(2))
    expect(decodes[1]!.src).toContain('size=2560')
    await act(async () => decodes[1]!.resolve())
    await waitFor(() => expect(img.src).toContain('size=2560'))
  })
})
