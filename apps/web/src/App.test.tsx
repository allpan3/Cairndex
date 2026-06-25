import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import type { HealthStatus } from './api/client'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchOnce(body: HealthStatus, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
    }),
  )
}

test('renders the app title and tagline', () => {
  mockFetchOnce({ status: 'ok', app_name: 'Cairndex', environment: 'test' })
  render(<App />)

  expect(screen.getByRole('heading', { name: 'Cairndex' })).toBeInTheDocument()
  expect(screen.getByText('Local-first media asset manager')).toBeInTheDocument()
})

test('shows backend-online status once the health probe resolves', async () => {
  mockFetchOnce({ status: 'ok', app_name: 'Cairndex', environment: 'test' })
  render(<App />)

  await waitFor(() => {
    expect(screen.getByText(/Backend online/)).toHaveTextContent('Cairndex (test)')
  })
})

test('shows an error status when the backend is unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
  render(<App />)

  await waitFor(() => {
    expect(screen.getByText(/Backend unreachable/)).toHaveTextContent('network down')
  })
})
