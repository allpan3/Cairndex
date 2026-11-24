import {
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query'
import { catalog } from './catalog'
import { SELECTION_REQUEST } from './catalogBulk'
import { commit } from './catalogOrganize'
import { fileLockKey, withCatalogWriteLock } from './catalogWriteQueue'
import { captureRequestScope, requestScopeVersion } from './requestScope'
import type { components } from './schema'
import { catalogPoll } from './catalogRevision'

export type CatalogFileStarRead = components['schemas']['CatalogFileStarRead']
export type CatalogFileSelectionRead = components['schemas']['CatalogFileSelectionRead']
type CatalogAlbumPage = components['schemas']['CatalogAlbumPage']
type LocalMediaRead = components['schemas']['LocalMediaRead']
type MembershipPage = components['schemas']['CatalogMembershipPage']
export type FileTagChoice = MembershipPage['items'][number]

export class FileAnnotationConflictError extends Error {
  readonly unit: string

  constructor(unit: string, message: string) {
    super(message)
    this.unit = unit
  }
}

const STAR_AFFECTED_QUERIES = [
  'catalog-file-star',
  'catalog-album',
  'catalog-inspector-files',
  'catalog-local-file',
  'catalog-browse',
  'catalog-view-counts',
  'catalog-selection',
] as const

const AFFECTED_QUERIES = [
  ...STAR_AFFECTED_QUERIES,
  'catalog-file-tags',
  'catalog-detail',
  'catalog-memberships',
  'catalog-bulk-memberships',
  'catalog-tag-counts',
  'catalog-navigation',
  'tags',
] as const

export async function invalidateFileStars(client: QueryClient, library: string) {
  await Promise.all(
    STAR_AFFECTED_QUERIES.map((key) => client.invalidateQueries({ queryKey: [key, library] })),
  )
}

export async function invalidateFileAnnotations(client: QueryClient, library: string) {
  await Promise.all(
    AFFECTED_QUERIES.map((key) => client.invalidateQueries({ queryKey: [key, library] })),
  )
}

export function fetchFileStar(library: string, fileId: string, signal?: AbortSignal) {
  return catalog<CatalogFileStarRead>(library, `/files/${fileId}/star`, 'GET', undefined).then(
    (result) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return result
    },
  )
}

export function fetchFileSelection(library: string, ids: string[]) {
  return catalog<CatalogFileSelectionRead>(library, '/files/selection', 'POST', { ids })
}

function sameRevisionSet(a?: string[], b?: string[]): boolean {
  if (!a || !b || a.length !== b.length) return false
  const right = new Set(b)
  return a.every((rev) => right.has(rev))
}

// Track latest desired star state per `(scope, library, fileId)` so rapid toggles
// coalesce cleanly and intermediate completions do not flash stale refetches.
const pendingStarSeq = new Map<string, { seq: number; starred: boolean }>()
let nextStarSeq = 0

function starIntentKey(library: string, fileId: string): string {
  return `${requestScopeVersion(true)}:${library}:${fileId}`
}

function patchAlbumPageStars(
  page: CatalogAlbumPage,
  targetSet: ReadonlySet<string>,
  starred: boolean,
): CatalogAlbumPage {
  let changed = false
  const items = page.items.map((item) => {
    if (!item.file || !targetSet.has(item.file.id) || Boolean(item.file.starred) === starred) {
      return item
    }
    changed = true
    return { ...item, file: { ...item.file, starred } }
  })
  return changed ? { ...page, items } : page
}

function applyOptimisticFileStars(
  client: QueryClient,
  library: string,
  ids: string[],
  starred: boolean,
): Array<[QueryKey, unknown]> {
  const targetSet = new Set(ids)
  const snapshots: Array<[QueryKey, unknown]> = []

  for (const id of targetSet) {
    const key: QueryKey = ['catalog-file-star', library, id]
    const prev = client.getQueryData<CatalogFileStarRead>(key)
    if (prev !== undefined) {
      snapshots.push([key, prev])
      client.setQueryData<CatalogFileStarRead>(key, { ...prev, starred })
    }
  }

  for (const [key, prev] of client.getQueriesData<CatalogAlbumPage>({
    queryKey: ['catalog-inspector-files', library],
  })) {
    if (!prev) continue
    const next = patchAlbumPageStars(prev, targetSet, starred)
    if (next !== prev) {
      snapshots.push([key, prev])
      client.setQueryData<CatalogAlbumPage>(key, next)
    }
  }

  for (const [key, prev] of client.getQueriesData<InfiniteData<CatalogAlbumPage>>({
    queryKey: ['catalog-album', library],
  })) {
    if (!prev) continue
    let changed = false
    const pages = prev.pages.map((page) => {
      const next = patchAlbumPageStars(page, targetSet, starred)
      if (next !== page) changed = true
      return next
    })
    if (changed) {
      snapshots.push([key, prev])
      client.setQueryData<InfiniteData<CatalogAlbumPage>>(key, { ...prev, pages })
    }
  }

  for (const [key, prev] of client.getQueriesData<LocalMediaRead>({
    queryKey: ['catalog-local-file', library],
  })) {
    if (!prev?.file || !targetSet.has(prev.file.id) || Boolean(prev.file.starred) === starred) {
      continue
    }
    snapshots.push([key, prev])
    client.setQueryData<LocalMediaRead>(key, {
      ...prev,
      file: { ...prev.file, starred },
    })
  }

  return snapshots
}

/**
 * Star or unstar one or more files cleanly via `/files/selection` (batching
 * at `SELECTION_REQUEST`), checking held conflicts before committing so peer
 * edits never silently overwrite each other.
 */
export async function setFileStars(
  library: string,
  ids: string[],
  starred: boolean,
  knownObserved?: Record<string, string[]>,
): Promise<void> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return
  const seq = ++nextStarSeq
  for (const id of uniqueIds) {
    pendingStarSeq.set(starIntentKey(library, id), { seq, starred })
  }
  const current = captureRequestScope()
  return withCatalogWriteLock(
    uniqueIds.map((id) => fileLockKey(library, id)),
    async ({ waited }) => {
      current()
      // Skip superseded intermediate toggles when a newer click for every target
      // is already queued behind this lock acquisition.
      const activeIds = uniqueIds.filter((id) => {
        const latest = pendingStarSeq.get(starIntentKey(library, id))
        return !latest || latest.seq === seq
      })
      if (activeIds.length === 0) return

      try {
        if (
          !waited &&
          activeIds.length === 1 &&
          knownObserved &&
          Object.keys(knownObserved).length > 0
        ) {
          try {
            await commit(library, {
              action: 'file_stars',
              ids: activeIds,
              starred,
              observed: knownObserved,
            })
            return
          } catch (reason) {
            if (!(
              reason instanceof Error && /changed or requires conflict review/i.test(reason.message)
            )) {
              throw reason
            }
            // Fall through to verify whether only an unrelated file unit moved.
          }
        }
        for (let start = 0; start < activeIds.length; start += SELECTION_REQUEST) {
          const chunk = activeIds.slice(start, start + SELECTION_REQUEST)
          const selection = await fetchFileSelection(library, chunk)
          current()
          const held = selection.items.find((item) => item.held)
          if (held)
            throw new FileAnnotationConflictError(
              `asset_file_stars/${held.id}/$alive`,
              'This file star needs conflict review first.',
            )
          if (!waited && activeIds.length === 1 && knownObserved) {
            const sole = selection.items[0]
            const starUnit = `asset_file_stars/${activeIds[0]}/$alive`
            const prevStar = knownObserved[starUnit]
            const currStar = sole?.observed[starUnit]
            if (
              sole &&
              prevStar !== undefined &&
              currStar !== undefined &&
              !sameRevisionSet(prevStar, currStar)
            ) {
              throw new Error(
                'Selected file metadata changed or requires conflict review; refresh choices',
              )
            }
          }
          const observed: Record<string, string[]> = {}
          for (const item of selection.items) Object.assign(observed, item.observed)
          const targetIds = selection.items.map((item) => item.id)
          if (!targetIds.length) continue
          await commit(library, {
            action: 'file_stars',
            ids: targetIds,
            starred,
            observed,
          })
          current()
        }
      } finally {
        for (const id of uniqueIds) {
          const key = starIntentKey(library, id)
          if (pendingStarSeq.get(key)?.seq === seq) pendingStarSeq.delete(key)
        }
      }
    },
  )
}

export function useFileStar(library: string, fileId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog-file-star', library, fileId],
    enabled: enabled && fileId !== null,
    queryFn: () => fetchFileStar(library, fileId!),
    refetchInterval: catalogPoll(library, 2000),
  })
}

export function useToggleFileStar(library: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      ids,
      starred,
      observed,
    }: {
      ids: string[]
      starred: boolean
      observed?: Record<string, string[]>
    }) => setFileStars(library, ids, starred, observed),
    onMutate: ({ ids, starred }) => {
      // Cancel in-flight reads without awaiting so the optimistic cache flip paints synchronously (0ms).
      for (const key of [
        'catalog-file-star',
        'catalog-inspector-files',
        'catalog-album',
        'catalog-local-file',
      ] as const) {
        void client.cancelQueries({ queryKey: [key, library] })
      }
      const snapshots = applyOptimisticFileStars(client, library, ids, starred)
      return { snapshots }
    },
    onError: (_error, variables, context) => {
      const stillQueued = variables.ids.some((id) => pendingStarSeq.has(starIntentKey(library, id)))
      if (stillQueued || !context?.snapshots) return
      for (const [key, prev] of context.snapshots) {
        client.setQueryData(key, prev)
      }
    },
    onSettled: (_data, _error, variables) => {
      const stillQueued = variables.ids.some((id) => pendingStarSeq.has(starIntentKey(library, id)))
      if (!stillQueued) return invalidateFileStars(client, library)
    },
  })
}

export function useFileTagChoices(
  library: string,
  fileId: string | null,
  search: string,
  assigned: boolean,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['catalog-file-tags', library, fileId, search, assigned],
    enabled: enabled && fileId !== null,
    queryFn: () =>
      catalog<MembershipPage>(
        library,
        `/files/${fileId}/tags?${new URLSearchParams({
          q: search,
          assigned: String(assigned),
          limit: '50',
        })}`,
      ),
    refetchInterval: assigned ? catalogPoll(library, 2000) : false,
  })
}

export function useSetFileTag(library: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (
      input: { fileId: string } & (
        { choice: FileTagChoice; assigned?: boolean } | { target: string; assigned: boolean }
      ),
    ) => {
      const current = captureRequestScope()
      const targetId = 'choice' in input ? input.choice.id : input.target
      return withCatalogWriteLock(
        [fileLockKey(library, input.fileId), `${library}:tags/${targetId}`],
        async ({ waited }) => {
          current()
          const readFreshChoice = async () => {
            const fresh = (
              await catalog<MembershipPage>(
                library,
                `/files/${input.fileId}/tags?${new URLSearchParams({
                  target: targetId,
                  limit: '1',
                })}`,
              )
            ).items.find((item) => item.id === targetId)
            current()
            if (!fresh) throw new Error('This tag is no longer in the library.')
            if (fresh.held)
              throw new FileAnnotationConflictError(
                `asset_file_tags/${input.fileId}~${fresh.id}/$alive`,
                'This file tag needs conflict review first.',
              )
            return fresh
          }
          const verifyChoiceUnchanged = async (prev: FileTagChoice) => {
            const fresh = await readFreshChoice()
            const edgeUnit = `asset_file_tags/${input.fileId}~${prev.id}/$alive`
            const tagUnit = `tags/${prev.id}/$alive`
            if (
              fresh.assigned !== prev.assigned ||
              (prev.observed[edgeUnit] !== undefined &&
                !sameRevisionSet(prev.observed[edgeUnit], fresh.observed[edgeUnit])) ||
              (prev.observed[tagUnit] !== undefined &&
                !sameRevisionSet(prev.observed[tagUnit], fresh.observed[tagUnit]))
            ) {
              throw new Error(
                'File tag membership changed or requires conflict review; refresh choices',
              )
            }
            return fresh
          }
          if ('choice' in input) {
            const assign = input.assigned ?? !input.choice.assigned
            if (waited) {
              const fresh = await verifyChoiceUnchanged(input.choice)
              await commit(library, {
                action: 'file_tag',
                file: input.fileId,
                target: fresh.id,
                assigned: assign,
                observed: fresh.observed,
              })
              return
            }
            if (input.choice.held)
              throw new FileAnnotationConflictError(
                `asset_file_tags/${input.fileId}~${input.choice.id}/$alive`,
                'This file tag needs conflict review first.',
              )
            try {
              await commit(library, {
                action: 'file_tag',
                file: input.fileId,
                target: input.choice.id,
                assigned: assign,
                observed: input.choice.observed,
              })
            } catch (reason) {
              if (
                reason instanceof Error &&
                /changed or requires conflict review/i.test(reason.message)
              ) {
                const fresh = await verifyChoiceUnchanged(input.choice)
                await commit(library, {
                  action: 'file_tag',
                  file: input.fileId,
                  target: fresh.id,
                  assigned: assign,
                  observed: fresh.observed,
                })
                return
              }
              throw reason
            }
            return
          }
          const fresh = await readFreshChoice()
          await commit(library, {
            action: 'file_tag',
            file: input.fileId,
            target: fresh.id,
            assigned: input.assigned,
            observed: fresh.observed,
          })
        },
      )
    },
    onMutate: (input) => {
      const assignedKey = ['catalog-file-tags', library, input.fileId, '', true] as const
      void client.cancelQueries({ queryKey: assignedKey })
      const prev = client.getQueryData<MembershipPage>(assignedKey)
      const targetId = 'choice' in input ? input.choice.id : input.target
      const assign = 'choice' in input ? (input.assigned ?? !input.choice.assigned) : input.assigned
      const knownName =
        'choice' in input
          ? input.choice.name
          : (client
              .getQueryData<{ id: string; name: string }[]>(['catalog-navigation', library, 'tags'])
              ?.find((item) => item.id === targetId)?.name ??
            prev?.items.find((item) => item.id === targetId)?.name ??
            targetId)
      client.setQueryData<MembershipPage>(assignedKey, (current) => {
        if (!current) return current
        if (assign) {
          if (current.items.some((item) => item.id === targetId)) return current
          return {
            ...current,
            items: [
              ...current.items,
              {
                id: targetId,
                name: knownName,
                parent_id: null,
                path: [knownName],
                assigned: true,
                held: false,
                observed: {},
              },
            ],
          }
        }
        return { ...current, items: current.items.filter((item) => item.id !== targetId) }
      })
      return { assignedKey, prev }
    },
    onError: (_error, _variables, context) => {
      if (context?.prev !== undefined) client.setQueryData(context.assignedKey, context.prev)
    },
    onSettled: () => invalidateFileAnnotations(client, library),
  })
}
