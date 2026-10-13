import { beforeEach, expect, test, vi } from 'vitest'
import { replicaRequest } from '../api/replicas'
import { catalogBundleDragPaths, catalogBundleHostPath } from './catalogHostFiles'

vi.mock('../api/replicas', () => ({ replicaRequest: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
function page(
  count: number,
  start = 0,
  next: number | null = null,
  revision = 'synthetic-revision',
) {
  return {
    files: Array.from({ length: count }, (_, index) => ({
      relative_path: `Synthetic/file-${start + index}.txt`,
    })),
    directories: [{ relative_path: 'Synthetic/folder' }],
    next_offset: next,
    revision,
  }
}
test('bundle host target supports attachments without probing source bytes', async () => {
  vi.mocked(replicaRequest).mockResolvedValue(page(1))
  expect(await catalogBundleHostPath('library', 'bundle')).toBe('Synthetic/file-0.txt')
  expect(replicaRequest).toHaveBeenCalledWith('library', '/media/bundles/bundle?limit=1')
})
test('bundle drag reads a complete bounded revision and excludes directories', async () => {
  vi.mocked(replicaRequest)
    .mockResolvedValueOnce(page(100, 0, 100))
    .mockResolvedValueOnce(page(28, 100))
  const paths = await catalogBundleDragPaths('library', 'bundle')
  expect(paths).toHaveLength(128)
  expect(paths.at(-1)).toBe('Synthetic/file-127.txt')
  expect(replicaRequest).toHaveBeenLastCalledWith(
    'library',
    '/media/bundles/bundle?offset=100&limit=28&expected_revision=synthetic-revision',
  )
})
test('oversized bundles refuse a partial native drag', async () => {
  vi.mocked(replicaRequest)
    .mockResolvedValueOnce(page(100, 0, 100))
    .mockResolvedValueOnce(page(28, 100, 128))
  await expect(catalogBundleDragPaths('library', 'bundle')).rejects.toThrow('more than 128')
  expect(replicaRequest).toHaveBeenCalledTimes(2)
})
test('changed catalog and non-advancing pages stop the drag', async () => {
  vi.mocked(replicaRequest)
    .mockResolvedValueOnce(page(2, 0, 2))
    .mockResolvedValueOnce(page(2, 2, null, 'changed'))
  await expect(catalogBundleDragPaths('library', 'bundle')).rejects.toThrow('changed')
  vi.mocked(replicaRequest).mockResolvedValue(page(2, 0, 0))
  await expect(catalogBundleDragPaths('library', 'bundle')).rejects.toThrow('changed')
})
