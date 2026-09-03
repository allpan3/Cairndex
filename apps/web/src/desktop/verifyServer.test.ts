import { expect, test, vi } from 'vitest'

import { fetchHealth } from '../api/client'
import {
  INCOMPATIBLE_SERVER_ERROR,
  UNREACHABLE_SERVER_ERROR,
  unreachableServerMessage,
  verifyServer,
} from './verifyServer'

vi.mock('../api/client', () => ({ fetchHealth: vi.fn() }))

const healthy = {
  status: 'ok',
  app_name: 'Cairndex',
  api_features: ['pairing', 'progress', 'hls'],
}

test('accepts a live server carrying the features the client needs', async () => {
  vi.mocked(fetchHealth).mockResolvedValue(healthy as never)
  await expect(verifyServer('http://nas:8000')).resolves.toBeUndefined()
})

test('rejects a responder that is not a compatible Cairndex', async () => {
  vi.mocked(fetchHealth).mockResolvedValue({ ...healthy, api_features: ['hls'] } as never)
  await expect(verifyServer('http://nas:8000')).rejects.toThrow(INCOMPATIBLE_SERVER_ERROR)
})

test('a blocked or dead request explains the development origin', async () => {
  // A CORS refusal reaches the page as an ordinary network failure, so this one
  // message covers both — and in a dev build it must name the reason a running
  // production server still looks dead (owner, 2026-09-01).
  vi.mocked(fetchHealth).mockRejectedValue(new TypeError('Failed to fetch'))

  await expect(verifyServer('http://nas:8000')).rejects.toThrow(UNREACHABLE_SERVER_ERROR)
  expect(unreachableServerMessage()).toContain('CAIRNDEX_CORS_EXTRA_ORIGINS')
})
