import { useQuery } from '@tanstack/react-query'
import { discovery, type DiscoveryCandidate } from '../../api/discovery'
import type { ReplicaDiscoveryState } from '../useReplicaDiscovery'

export type FileChangeEntry = { label: string; earlier: boolean }

/** The footer entry for work beside the grouping tree, named for what exists.
 *
 * File changes come from the server's filtered list. The unfiltered candidates
 * also hold this Update's ordinary grouping proposals, so their first page says
 * nothing about a repair further on. */
export function useFileChangeEntry(
  library: string,
  d: Pick<ReplicaDiscoveryState, 'pending' | 'reviews'>,
): FileChangeEntry | null {
  const changes = useQuery({
    queryKey: ['discovery-file-changes', library, 'any'],
    queryFn: ({ signal }) =>
      discovery<{ items: DiscoveryCandidate[]; next_cursor: string | null }>(
        library,
        '/candidates?file_changes=true&limit=1',
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 1500,
  })
  // Offered once both answers arrive, so the entry never changes its name in place
  if (!changes.data || !d.reviews.data) return null
  const files = changes.data.items.length > 0
  const reviews = d.reviews.data.items.length > 0
  if (files && reviews) return { label: 'File changes and saved reviews…', earlier: false }
  if (files) return { label: 'File changes…', earlier: false }
  if (reviews) return { label: 'Saved reviews…', earlier: false }
  // Only this Update's grouping proposals remain: the tree's own files, offered
  // one choice at a time as the earlier review did
  return d.pending ? { label: 'Earlier grouping choices…', earlier: true } : null
}
