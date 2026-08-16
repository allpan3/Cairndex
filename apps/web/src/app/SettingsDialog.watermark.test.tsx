import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { LibraryRead } from '../api/client'
import { getExportPrefs, resetExportPrefsForTests, useExportPrefs } from '../state/exportPrefs'
import { SettingsDialog } from './SettingsDialog'

const LIBRARY: LibraryRead = {
  id: 'available',
  library_uuid: '01J00000000000000000000000',
  name: 'Available Library',
  root_path: '/libraries/available',
  status: 'available',
  schema_version: 1,
  write_mode_enabled: false,
  created_at: '2026-07-13T00:00:00Z',
  updated_at: '2026-07-13T00:00:00Z',
  last_opened_at: null,
}

beforeEach(() => {
  resetExportPrefsForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetExportPrefsForTests()
})

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog libraries={[LIBRARY]} libraryId={LIBRARY.id} onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

const openExports = () => fireEvent.click(screen.getByRole('button', { name: 'Exports' }))

// The page was introduced desktop-only for the export folder, but a watermark
// applies wherever an export can be started — a browser download included.
test('Exports is reachable in a browser, without the desktop-only folder row', () => {
  renderSettings()
  openExports()

  expect(screen.getByRole('heading', { name: 'Exports' })).toBeInTheDocument()
  expect(screen.getByText('Watermark exports')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Choose Folder…' })).not.toBeInTheDocument()
})

test('the mark is off until it is asked for, and the wording follows', () => {
  renderSettings()
  openExports()

  const toggle = screen.getByRole('checkbox', { name: /Watermark exports/ })
  expect(toggle).not.toBeChecked()
  // Nothing to say about the wording of a mark that is not applied.
  expect(screen.queryByLabelText('Watermark text')).not.toBeInTheDocument()

  fireEvent.click(toggle)

  expect(getExportPrefs().watermarkEnabled).toBe(true)
  expect(screen.getByLabelText('Watermark text')).toHaveValue('CAIRNDEX')
})

test('custom text is kept', () => {
  renderSettings()
  openExports()
  fireEvent.click(screen.getByRole('checkbox', { name: /Watermark exports/ }))

  fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: 'STUDIO ALPHA' } })

  expect(getExportPrefs().watermarkText).toBe('STUDIO ALPHA')
})

// Switching the mark off must not discard the wording — turning it back on
// should not make the owner retype what they already chose.
test('turning the mark off keeps the text for next time', () => {
  renderSettings()
  openExports()
  const toggle = screen.getByRole('checkbox', { name: /Watermark exports/ })

  fireEvent.click(toggle)
  fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: 'STUDIO ALPHA' } })
  fireEvent.click(toggle)

  expect(getExportPrefs()).toMatchObject({
    watermarkEnabled: false,
    watermarkText: 'STUDIO ALPHA',
  })

  fireEvent.click(toggle)
  expect(screen.getByLabelText('Watermark text')).toHaveValue('STUDIO ALPHA')
})

test('a mark cannot grow into a caption', () => {
  renderSettings()
  openExports()
  fireEvent.click(screen.getByRole('checkbox', { name: /Watermark exports/ }))

  expect(screen.getByLabelText('Watermark text')).toHaveAttribute('maxLength', '64')
})

const enableWatermark = () =>
  fireEvent.click(screen.getByRole('checkbox', { name: /Watermark exports/ }))

// Text first, because an image needs a file chosen before it marks anything —
// starting there would show an empty setting.
test('starts on text, and switches to image on request', () => {
  renderSettings()
  openExports()
  enableWatermark()

  expect(screen.getByRole('radio', { name: 'Text' })).toBeChecked()
  expect(screen.getByLabelText('Watermark text')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

  expect(getExportPrefs().watermarkKind).toBe('image')
  expect(screen.queryByLabelText('Watermark text')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Choose Image…' })).toBeInTheDocument()
})

// Switching kinds must not discard the other one's answer.
test('keeps the text when the image kind is chosen', () => {
  renderSettings()
  openExports()
  enableWatermark()
  fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: 'STUDIO ALPHA' } })

  fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Text' }))

  expect(screen.getByLabelText('Watermark text')).toHaveValue('STUDIO ALPHA')
})

test('a chosen image is shown, and can be taken away again', () => {
  renderSettings()
  openExports()
  enableWatermark()
  fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

  // Through the shared store, exactly as a successful import would: the open
  // dialog is a subscriber, so it re-renders with the picture in place.
  const store = renderHook(() => useExportPrefs())
  act(() =>
    store.result.current[1]({
      watermarkImage: 'data:image/png;base64,AAAA',
      watermarkImageName: 'badge.png',
    }),
  )

  expect(screen.getByAltText('Watermark preview')).toHaveAttribute(
    'src',
    'data:image/png;base64,AAAA',
  )
  expect(screen.getByText('badge.png')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

  expect(getExportPrefs().watermarkImage).toBeNull()
  expect(screen.queryByAltText('Watermark preview')).not.toBeInTheDocument()
})

test('rejects a file that could not be a watermark, and says why', async () => {
  renderSettings()
  openExports()
  enableWatermark()
  fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

  const input = document.querySelector('input[type="file"]')
  expect(input).not.toBeNull()
  fireEvent.change(input as Element, {
    target: { files: [{ type: 'image/svg+xml', size: 10, name: 'logo.svg' }] },
  })

  expect(await screen.findByRole('alert')).toHaveTextContent(/PNG, JPEG/)
  expect(getExportPrefs().watermarkImage).toBeNull()
})
