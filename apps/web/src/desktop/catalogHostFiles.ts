import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'

type Playlist = components['schemas']['ReplicaPlaylist']
export const MAX_BUNDLE_DRAG_FILES = 128

export async function catalogBundleHostPath(library: string, bundle: string) {
  const page = await replicaRequest<Playlist>(library, `/media/bundles/${bundle}?limit=1`)
  return page.files[0]?.relative_path ?? null
}

/** Complete bounded selection, fenced by one catalog revision across pages. */
export async function catalogBundleDragPaths(library: string, bundle: string) {
  const paths: string[] = []
  let offset = 0
  let revision: string | null = null
  while (true) {
    const limit = Math.min(100, MAX_BUNDLE_DRAG_FILES - paths.length)
    if (limit === 0)
      throw new Error(
        'This bundle has more than 128 files. Select files in its album to drag them out.',
      )
    const page: Playlist = await replicaRequest<Playlist>(
      library,
      `/media/bundles/${bundle}?offset=${offset}&limit=${limit}${revision ? `&expected_revision=${encodeURIComponent(revision)}` : ''}`,
    )
    if (page.files.length > limit || (revision !== null && page.revision !== revision))
      throw new Error('Bundle files changed. Try the drag again.')
    paths.push(...page.files.map((file) => file.relative_path))
    revision = page.revision ?? null
    if (page.next_offset == null) return [...new Set(paths)]
    if (!revision || page.next_offset <= offset)
      throw new Error('Bundle files changed. Try the drag again.')
    offset = page.next_offset
  }
}
