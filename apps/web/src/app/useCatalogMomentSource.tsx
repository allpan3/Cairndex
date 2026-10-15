import { useMemo } from 'react'

import {
  catalogMomentPreviews,
  useCatalogMomentMutations,
  useCatalogMoments,
} from '../api/catalogMoments'
import type { FileRead } from '../api/client'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { CatalogMomentTags } from './CatalogMomentTags'
import type { MomentSource } from './momentSource'

/**
 * One portable bundle's moments as a moment source, for the viewer's rail and
 * the browser inspector. The server's `moments_version` decides what a row
 * offers: 1 lists and edits moments, 2 adds tags, 3 adds private previews, and
 * 4 names the marked files, which the browser inspector needs.
 *
 * Only `storyboardFile` has a storyboard, at `storyboardUrl`: a storyboard URL
 * names one observed generation, and only the viewer observes a file.
 */
export function useCatalogMomentSource(
  library: string,
  bundleId: string | null,
  storyboardFile: string | null = null,
  storyboardUrl: string | null = null,
): { version: number; source: MomentSource; files: FileRead[] } {
  const status = useReplicaStatus(library)
  const version = status.data?.moments_version ?? 0
  const moments = useCatalogMoments(library, version >= 1 ? bundleId : null)
  const mutations = useCatalogMomentMutations(library, bundleId)
  const source = useMemo<MomentSource>(() => {
    const tagNames = moments.data?.tagNames ?? {}
    return {
      moments: moments.data?.moments ?? [],
      mutations,
      storyboardUrl: (fileId) => (fileId === storyboardFile ? storyboardUrl : null),
      renderTags:
        version >= 2
          ? (moment) => <CatalogMomentTags library={library} moment={moment} names={tagNames} />
          : undefined,
      previews: version >= 3 ? (moment) => catalogMomentPreviews(library, moment) : undefined,
    }
  }, [library, moments.data, mutations, storyboardFile, storyboardUrl, version])
  return { version, source, files: moments.data?.files ?? [] }
}
