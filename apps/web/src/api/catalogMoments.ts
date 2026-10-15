// Portable moments are catalog rows; every write is a catalog job with explicit bases
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, operationId, runJob, type Entity } from './catalog'
import { resolveAssetUrl, type Moment, type MomentCreate } from './client'
import { replicaRequest } from './replicas'
import type { components } from './schema'

type MomentPage = components['schemas']['CatalogMomentPage']
type TagPage = components['schemas']['CatalogMembershipPage']
export type MomentTagChoice = components['schemas']['CatalogMembershipChoice']

/** One bundle's moments and the names of the tags they carry. */
export interface CatalogMoments {
  moments: Moment[]
  tagNames: Record<string, string>
}

export const catalogMomentsKey = (library: string, bundleId: string | null) => [
  'catalog-moments',
  library,
  bundleId,
]

/**
 * A portable moment's private previews. The server answers 404 and makes the
 * preview in the background until it is ready; a frame has no clip.
 */
export function catalogMomentPreviews(library: string, moment: Moment): MomentPreviews {
  const base = `/api/v1/libraries/${library}/replica/media/moments/${encodeURIComponent(moment.id)}`
  return {
    poster: resolveAssetUrl(`${base}/poster.jpg`),
    clip: moment.end_s === null ? null : resolveAssetUrl(`${base}/clip.mp4`),
  }
}

export interface MomentPreviews {
  poster: string
  clip: string | null
}

/** Same order as the server: start time, then the stable identity. */
function insertMoment(current: Moment[], saved: Moment): Moment[] {
  const others = current.filter((moment) => moment.id !== saved.id)
  const at = others.findIndex(
    (moment) =>
      moment.start_s > saved.start_s || (moment.start_s === saved.start_s && moment.id > saved.id),
  )
  return at < 0 ? [...others, saved] : [...others.slice(0, at), saved, ...others.slice(at)]
}

/** One bundle's moments, all pages; a bundle holds few, and the rail lists every one. */
export function useCatalogMoments(library: string, bundleId: string | null) {
  return useQuery({
    queryKey: catalogMomentsKey(library, bundleId),
    enabled: bundleId !== null,
    queryFn: async ({ signal }): Promise<CatalogMoments> => {
      const moments: Moment[] = []
      const tagNames: Record<string, string> = {}
      let offset: number | null = 0
      while (offset !== null) {
        const page: MomentPage = await replicaRequest<MomentPage>(
          library,
          `/catalog/bundles/${bundleId}/moments?offset=${offset}`,
          'GET',
          undefined,
          signal,
        )
        moments.push(...page.items)
        Object.assign(tagNames, page.tag_names)
        offset = page.next_offset
      }
      return { moments, tagNames }
    },
    // Another device's moments arrive through the exchange, not through this tab
    refetchInterval: 5000,
  })
}

// A reviewed preview is committed at once: the owner's gesture is the review
async function previewAndCommit(library: string, command: unknown): Promise<void> {
  const prepared = await runJob(library, 'preview', command, operationId())
  await runJob(
    library,
    'commit_preview',
    { job: prepared.id, receipt: prepared.receipt },
    `commit_${prepared.id}`,
  )
}

export function useCatalogMomentMutations(library: string, bundleId: string | null) {
  const client = useQueryClient()
  const key = catalogMomentsKey(library, bundleId)
  const refresh = () => client.invalidateQueries({ queryKey: key })
  const requireBundle = (): string => {
    if (bundleId === null) throw new Error('no bundle to hold a moment')
    return bundleId
  }
  return {
    create: useMutation({
      mutationFn: async (body: MomentCreate): Promise<Moment> => {
        const bundle = requireBundle()
        // The server assigns the identity and timestamps of a new catalog row
        const template = await catalog<{ cells: Record<string, string> }>(
          library,
          '/creation/moments',
        )
        const cells = {
          ...template.cells,
          bundle_id: JSON.stringify(bundle),
          file_id: JSON.stringify(body.file_id),
          start_s: JSON.stringify(body.start_s),
          end_s: JSON.stringify(body.end_s ?? null),
        }
        await previewAndCommit(library, { action: 'create', family: 'moments', cells })
        const row = Object.fromEntries(
          Object.entries(cells).map(([column, raw]) => [column, JSON.parse(raw) as unknown]),
        )
        return { ...(row as Omit<Moment, 'tag_ids'>), tag_ids: [] }
      },
      onSuccess: (saved) => {
        // Only into a list that exists; a list seeded from one answer would hide the others
        client.setQueryData<CatalogMoments>(key, (current) =>
          current ? { ...current, moments: insertMoment(current.moments, saved) } : current,
        )
      },
      onSettled: refresh,
    }),
    update: useMutation({
      mutationFn: async ({
        momentId,
        patch,
      }: {
        momentId: string
        patch: { comment: string }
      }): Promise<void> => {
        const shown = client
          .getQueryData<CatalogMoments>(key)
          ?.moments.find((moment) => moment.id === momentId)?.comment
        const entity = await catalog<Entity>(library, `/entities/moments/${momentId}`)
        const comment = entity.fields.comment
        const alive = entity.fields.$alive
        if (!comment || !alive || alive.value !== 'true' || alive.held || comment.held)
          throw new Error('This moment needs metadata review before its comment can change.')
        // The bases come from the catalog now, so a comment that changed since the
        // owner saw it would be overwritten without review
        if (JSON.parse(comment.value ?? 'null') !== (shown ?? null))
          throw new Error('This comment changed on another device. Open it again to edit it.')
        await runJob(
          library,
          'save',
          {
            changes: [
              {
                unit: comment.unit,
                value: JSON.stringify(patch.comment.trim() ? patch.comment : null),
                basis: comment.basis,
              },
              { unit: alive.unit, value: 'true', basis: alive.basis },
            ],
            parents: entity.parents,
            resolve: false,
            recover: false,
          },
          operationId(),
        )
      },
      // The saved comment is what the next edit must match before the list refetches
      onSuccess: (_saved, { momentId, patch }) =>
        client.setQueryData<CatalogMoments>(key, (current) =>
          current
            ? {
                ...current,
                moments: current.moments.map((moment) =>
                  moment.id === momentId
                    ? { ...moment, comment: patch.comment.trim() ? patch.comment : null }
                    : moment,
                ),
              }
            : current,
        ),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (momentId: string) =>
        previewAndCommit(library, { action: 'delete', family: 'moments', entity: momentId }),
      // The row goes on the click; a failed delete puts it back
      onMutate: async (momentId: string) => {
        await client.cancelQueries({ queryKey: key })
        const previous = client.getQueryData<CatalogMoments>(key)
        if (previous)
          client.setQueryData<CatalogMoments>(key, {
            ...previous,
            moments: previous.moments.filter((moment) => moment.id !== momentId),
          })
        return { previous }
      },
      onError: (_error, _momentId, context) => {
        if (context?.previous) client.setQueryData(key, context.previous)
      },
      onSettled: refresh,
    }),
  }
}

/** Tag choices for one moment, searched on the server, with the bases a change needs. */
export function useMomentTagChoices(
  library: string,
  momentId: string,
  search: string,
  assigned: boolean,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['catalog-moment-tags', library, momentId, search, assigned],
    enabled,
    queryFn: ({ signal }) =>
      replicaRequest<TagPage>(
        library,
        `/catalog/moments/${momentId}/tags?${new URLSearchParams({
          q: search,
          assigned: String(assigned),
          limit: '50',
        })}`,
        'GET',
        undefined,
        signal,
      ),
  })
}

/**
 * Add or remove one tag on a moment. An added tag is also added to the bundle
 * (ADR-0025), so the bundle's tag lists and the browse results refresh too.
 */
export function useSetMomentTag(library: string, bundleId: string | null) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ momentId, choice }: { momentId: string; choice: MomentTagChoice }) =>
      previewAndCommit(library, {
        action: 'moment_tag',
        moment: momentId,
        target: choice.id,
        assigned: !choice.assigned,
        observed: choice.observed,
      }),
    onSettled: () =>
      Promise.all(
        [
          catalogMomentsKey(library, bundleId),
          ['catalog-moment-tags', library],
          ['catalog-memberships', library],
          ['catalog-browse', library],
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  })
}
