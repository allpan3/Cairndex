import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { LibraryRead } from '../api/client'
import { getExportPrefs, resetExportPrefsForTests } from '../state/exportPrefs'
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

  expect(getExportPrefs()).toEqual({ watermarkEnabled: false, watermarkText: 'STUDIO ALPHA' })

  fireEvent.click(toggle)
  expect(screen.getByLabelText('Watermark text')).toHaveValue('STUDIO ALPHA')
})

test('a mark cannot grow into a caption', () => {
  renderSettings()
  openExports()
  fireEvent.click(screen.getByRole('checkbox', { name: /Watermark exports/ }))

  expect(screen.getByLabelText('Watermark text')).toHaveAttribute('maxLength', '64')
})
