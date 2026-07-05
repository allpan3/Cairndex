import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { StoryboardPreview } from './StoryboardPreview'

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
storyboard/sb_001.jpg?v=test#xywh=0,0,320,568
`

// Render the preview with an isolated query client
function renderPreview(storyboardUrl: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StoryboardPreview storyboardUrl={storyboardUrl} time={1} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('StoryboardPreview', () => {
  test('scales portrait tiles to fit the hover tooltip bounds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(VTT) })),
    )

    renderPreview('/api/v1/libraries/lib/files/f/storyboard.vtt?v=test')
    const preview = await screen.findByTestId('storyboard-preview')

    expect(preview).toHaveStyle({ width: '135px', height: '240px' })
    expect(preview.style.backgroundSize).toContain('1200px')
  })

  test('refetches when the versioned storyboard URL changes', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(VTT) }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <StoryboardPreview
          storyboardUrl="/api/v1/libraries/lib/files/f/storyboard.vtt?v=one"
          time={1}
        />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    rerender(
      <QueryClientProvider client={client}>
        <StoryboardPreview
          storyboardUrl="/api/v1/libraries/lib/files/f/storyboard.vtt?v=two"
          time={1}
        />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/libraries/lib/files/f/storyboard.vtt?v=two',
      expect.any(Object),
    )
  })
})
