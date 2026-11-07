import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { joinPath } from './sourceTasks'

type Listing = components['schemas']['FileBrowserListingRead']

/** The listing the picker and destination suggestions share, so both read one cache entry. */
export function folderListing(library: string, folder: string) {
  return {
    queryKey: ['catalog-local-directory', library, folder],
    queryFn: () =>
      replicaRequest<Listing>(library, `/media/directory?path=${encodeURIComponent(folder)}`),
  }
}

/** The folder a picker's choice names once its pending folders exist. */
export function pickedFolder(value: string, pending: readonly string[]): string {
  return pending.reduce(joinPath, value)
}
