import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LibraryRead } from '../api/client'
import {
  captureRequestScope,
  getConnectionScopeKey,
  requestScopeVersion,
} from '../api/requestScope'
import { getActiveConnection } from './connections'
import {
  adoptHostLibraryMapping,
  getHostLabels,
  getHostPlatform,
  hostOperationErrorMessage,
} from '../platform'

export const libraryMappingKey = (library: string) =>
  ['library-mapping', getConnectionScopeKey(), library] as const

export async function readLibraryMapping(library: string) {
  const current = captureRequestScope(false)
  const root = await getHostPlatform().getLibraryMapping(library)
  current()
  return root
}

export type LibraryHostFiles = {
  mapped: boolean
  pending: boolean
  labels: ReturnType<typeof getHostLabels>
  onRevealFile?: (path: string) => void
  onOpenFile?: (path: string) => void
  onStartFileDrag?: (paths: string[]) => void
  error: string
  dismissError: () => void
}

/** Native commands resolve relative paths against the active server's verified mapping. */
export function useLibraryHostFiles(library: string, registration?: LibraryRead): LibraryHostFiles {
  const platform = getHostPlatform()
  const cache = useQueryClient()
  const [error, setError] = useState('')
  const mapping = useQuery({
    queryKey: libraryMappingKey(library),
    queryFn: () => readLibraryMapping(library),
    enabled: platform.kind === 'desktop',
  })
  const scope = requestScopeVersion()
  const uuid = registration?.library_uuid
  const rootPath = registration?.root_path
  useEffect(() => {
    if (platform.kind !== 'desktop' || getActiveConnection()?.kind !== 'local') return
    if (mapping.isPending || mapping.data != null || !uuid || !rootPath) return
    let active = true
    const key = libraryMappingKey(library)
    void adoptHostLibraryMapping(library, uuid, rootPath)
      .then((root) => {
        if (active && requestScopeVersion() === scope && root !== null)
          cache.setQueryData(key, root)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [cache, library, uuid, rootPath, mapping.isPending, mapping.data, platform.kind, scope])

  const act = useCallback((operation: () => Promise<void>) => {
    const acceptedScope = requestScopeVersion()
    setError('')
    void operation().catch((reason: unknown) => {
      if (acceptedScope === requestScopeVersion()) setError(hostOperationErrorMessage(reason))
    })
  }, [])
  const reveal = useCallback(
    (path: string) => act(() => platform.revealFile(library, path)),
    [act, library, platform],
  )
  const open = useCallback(
    (path: string) => act(() => platform.openFile(library, path)),
    [act, library, platform],
  )
  const drag = useCallback(
    (paths: string[]) =>
      act(() =>
        platform.startFileDrag(
          [...new Set(paths)].map((relativePath) => ({ libraryId: library, relativePath })),
        ),
      ),
    [act, library, platform],
  )
  const mapped = platform.kind === 'desktop' && mapping.isSuccess && mapping.data != null
  return useMemo(
    () => ({
      mapped,
      pending: platform.kind === 'desktop' && mapping.isPending,
      labels: getHostLabels(),
      onRevealFile: mapped && platform.canRevealInFinder ? reveal : undefined,
      onOpenFile: mapped && platform.canOpenWithDefaultApp ? open : undefined,
      onStartFileDrag: mapped && platform.canDragOutFiles ? drag : undefined,
      error,
      dismissError: () => setError(''),
    }),
    [mapped, mapping.isPending, platform, reveal, open, drag, error],
  )
}
