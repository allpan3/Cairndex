// Exact prepared receipts expose complete files, placements and metadata through independent pages
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  discovery,
  type DiscoveryFile,
  type DiscoveryGroup,
  type DiscoveryPage,
  type DiscoveryReview,
} from '../api/discovery'

type Change = { unit: string; value: string }

// Paging never changes the receipt the owner accepts
export function DiscoveryPrepared({
  library,
  review,
}: {
  library: string
  review: DiscoveryReview
}) {
  const [filesAfter, setFilesAfter] = useState(-1)
  const [changesAfter, setChangesAfter] = useState(-1)
  const [groupsAfter, setGroupsAfter] = useState(-1)
  const prepared = review.prepared!
  const files = useQuery({
    queryKey: ['discovery-review-files', library, review.id, filesAfter],
    enabled: prepared.version === 2,
    queryFn: () =>
      discovery<DiscoveryPage<DiscoveryFile>>(
        library,
        `/reviews/${review.id}/pages/files?after=${filesAfter}`,
      ),
  })
  const changes = useQuery({
    queryKey: ['discovery-review-changes', library, review.id, changesAfter],
    enabled: prepared.version === 2,
    queryFn: () =>
      discovery<DiscoveryPage<Change>>(
        library,
        `/reviews/${review.id}/pages/changes?after=${changesAfter}`,
      ),
  })
  const groups = useQuery({
    queryKey: ['discovery-review-groups', library, review.id, groupsAfter],
    enabled: prepared.version === 2,
    queryFn: () =>
      discovery<DiscoveryPage<DiscoveryGroup>>(
        library,
        `/reviews/${review.id}/pages/groups?after=${groupsAfter}`,
      ),
  })
  return (
    <>
      <h3>{prepared.title}</h3>
      <p>
        {prepared.file_count ?? prepared.files.length} selected files
        {prepared.group_count ? ` · ${prepared.group_count} groups` : ''}
      </p>
      {[files.error, changes.error, groups.error].filter(Boolean).map((error, i) => (
        <p key={i} role="alert">
          {error!.message}
          <button
            onClick={() => {
              void files.refetch()
              void changes.refetch()
              void groups.refetch()
            }}
          >
            Retry prepared pages
          </button>
        </p>
      ))}
      <section aria-label="Prepared groups">
        {(groups.data?.items ?? prepared.groups ?? []).map((group) => (
          <p key={group.id}>
            {group.placement?.length ? `${group.placement.join(' / ')} / ` : ''}
            {group.title}
            {group.addition && !group.placement?.length ? ' · Existing collections preserved' : ''}
          </p>
        ))}
      </section>
      {groups.data?.next_cursor != null && (
        <button onClick={() => setGroupsAfter(groups.data!.next_cursor!)}>
          Next prepared groups
        </button>
      )}
      {groupsAfter !== -1 && (
        <button onClick={() => setGroupsAfter(-1)}>First prepared groups</button>
      )}
      <ol aria-label="Prepared files">
        {(files.data?.items ?? prepared.files).map((file) => (
          <li key={file.path}>
            {file.path}
            {file.role ? ` · ${file.role}` : ''}
          </li>
        ))}
      </ol>
      {(files.data?.next_cursor ?? (filesAfter === -1 ? prepared.files_next : null)) != null && (
        <button onClick={() => setFilesAfter(files.data?.next_cursor ?? prepared.files_next!)}>
          Next prepared files
        </button>
      )}
      {filesAfter !== -1 && <button onClick={() => setFilesAfter(-1)}>First prepared files</button>}
      <details>
        <summary>Review complete metadata and order</summary>
        <p>{prepared.catalog.change_count ?? prepared.catalog.changes.length} metadata values</p>
        <pre>
          {JSON.stringify(
            (changes.data?.items ?? prepared.catalog.changes).map((change) => ({
              field: change.unit,
              value: JSON.parse(change.value) as unknown,
            })),
            null,
            2,
          )}
        </pre>
        {(changes.data?.next_cursor ??
          (changesAfter === -1 ? prepared.catalog.next_cursor : null)) != null && (
          <button
            onClick={() =>
              setChangesAfter(changes.data?.next_cursor ?? prepared.catalog.next_cursor!)
            }
          >
            Next metadata values
          </button>
        )}
        {changesAfter !== -1 && (
          <button onClick={() => setChangesAfter(-1)}>First metadata values</button>
        )}
      </details>
    </>
  )
}
