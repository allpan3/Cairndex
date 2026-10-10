// Complete candidate selection stays independent of the currently displayed page
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import {
  discovery,
  type DiscoveryCandidate,
  type DiscoveryFile,
  type DiscoveryGroup,
  type DiscoveryPage,
  type DiscoveryReview,
} from '../api/discovery'
import { CatalogValue } from './CatalogControls'
import { DiscoveryVerification } from './DiscoveryVerification'
import { useCatalogDraft } from './useCatalogDraft'
import { validSelection, type Selection } from './discoverySelection'

// Prepared choices pin the original suggestion while later catalog refreshes preserve this draft
export function CandidateReview({
  library,
  editor,
  candidate,
  onPrepared,
}: {
  library: string
  editor: string
  candidate: DiscoveryCandidate
  onPrepared: (id: string) => void
}) {
  const { body } = candidate
  const [initialOperation] = useState(operationId)
  const draft = useCatalogDraft(
    library,
    `discovery/${candidate.id}`,
    editor,
    {
      title: body.title,
      target: body.target ?? '',
      files: JSON.stringify(
        body.version === 2
          ? { all: true, exclude: [], groups: [], collection: '', moves: [] }
          : body.files.flatMap((file) => (file.id ? [file.id] : [])),
      ),
      repair: '',
      replacement: false,
      operation: initialOperation,
    },
    validSelection,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [verification, setVerification] = useState<string | null>(null)
  const [after, setAfter] = useState(-1)
  const [groupAfter, setGroupAfter] = useState('')
  const [choiceAfter, setChoiceAfter] = useState('')
  const choice = JSON.parse(draft.body.files) as Selection | string[]
  const selection = Array.isArray(choice) ? null : choice
  const selectable = body.kind === 'new' || body.kind === 'collection'
  const files = useQuery({
    queryKey: ['discovery-files', library, candidate.id, after],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      discovery<DiscoveryPage<DiscoveryFile>>(
        library,
        `/candidates/${candidate.id}/files?after=${after}`,
        'GET',
        undefined,
        signal,
      ),
    enabled: body.version === 2,
  })
  const groups = useQuery({
    queryKey: ['discovery-groups', library, candidate.id, groupAfter],
    queryFn: ({ signal }) =>
      discovery<DiscoveryPage<DiscoveryGroup, string>>(
        library,
        `/candidates/${candidate.id}/groups?after=${encodeURIComponent(groupAfter)}`,
        'GET',
        undefined,
        signal,
      ),
    enabled: body.version === 2,
  })
  const identities = useQuery({
    queryKey: ['discovery-choices', library, candidate.id, choiceAfter, draft.body.repair],
    queryFn: () =>
      discovery<{
        items: { file_id: string; path: string }[]
        next_cursor: string | null
        selected: { file_id: string; path: string } | null
      }>(
        library,
        `/candidates/${candidate.id}/choices?after=${encodeURIComponent(choiceAfter)}&selected=${encodeURIComponent(draft.body.repair)}`,
      ),
    enabled: Boolean(body.choices_total),
  })
  const page = files.data?.items ?? body.files
  const next = files.data?.next_cursor ?? (after === -1 ? body.files_next : null)
  // A changed decision receives a new retry identity; untouched requests keep their original identity
  function update(value: Partial<typeof draft.body>) {
    draft.update({ ...draft.body, ...value, operation: operationId() })
  }
  // Selection edits retain exceptions from every previously visited page
  function select(value: Partial<Selection>) {
    if (selection) update({ files: JSON.stringify({ ...selection, ...value }) })
  }
  // Accepted sources and excluded groups remain outside the effective selection
  function checked(file: DiscoveryFile): boolean {
    if (file.accepted) return false
    return selection
      ? !selection.groups.includes(file.group ?? '') &&
          selection.all !== selection.exclude.includes(file.id!)
      : (choice as string[]).includes(file.id!)
  }
  // A complete verification receipt and grouping decision share one retry identity
  async function prepare() {
    setBusy(true)
    setError('')
    try {
      const review = await discovery<DiscoveryReview>(library, '/reviews', 'POST', {
        operation: verification
          ? `${draft.body.operation.slice(0, 30)}_${verification.slice(0, 30)}`
          : draft.body.operation,
        candidate: candidate.id,
        title: draft.body.title,
        ...(body.kind === 'new' && draft.body.target !== (body.target ?? '')
          ? { target: draft.body.target || null }
          : {}),
        ...(selectable
          ? selection
            ? {
                ...(selection.all
                  ? { exclude_files: selection.exclude }
                  : { files: selection.exclude }),
                exclude_groups: selection.groups,
                collection: selection.collection || null,
                moves: selection.moves,
              }
            : { files: choice }
          : {}),
        repair_file: draft.body.repair || null,
        use_replacement: draft.body.replacement,
        ...(verification ? { verification } : {}),
      })
      onPrepared(review.id)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Discovery grouping choice">
      <h3>{body.title}</h3>
      <p>{body.reason}</p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {(body.unverified_count ??
        body.files.filter((file) => file.evidence.algorithm !== 'sha256').length) > 0 && (
        <DiscoveryVerification
          library={library}
          editor={editor}
          candidate={candidate.id}
          onVerified={setVerification}
        />
      )}
      {draft.copies.map((copy) => (
        <button key={copy.id} onClick={() => draft.update(copy.body)}>
          Recover discovery draft {copy.revision}
        </button>
      ))}
      {selectable && (
        <>
          <label>
            {body.kind === 'collection' ? 'Collection name' : 'Bundle title'}
            <input
              value={draft.body.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>
          {body.kind === 'new' && (
            <label>
              Destination
              <CatalogValue
                library={library}
                control={{
                  field: 'bundle_id',
                  label: 'Destination',
                  kind: 'reference',
                  nullable: true,
                  choices: [],
                  reference_family: 'asset_bundles',
                  columns: [],
                }}
                raw={JSON.stringify(draft.body.target || null)}
                onChange={(raw) => update({ target: (JSON.parse(raw) as string | null) ?? '' })}
              />
            </label>
          )}
          {selection && (
            <label>
              Place in collection
              <CatalogValue
                library={library}
                control={{
                  field: 'collection_id',
                  label: 'Place in collection',
                  kind: 'reference',
                  nullable: true,
                  choices: [],
                  reference_family: 'collections',
                  columns: [],
                }}
                raw={JSON.stringify(selection.collection || null)}
                onChange={(raw) => select({ collection: (JSON.parse(raw) as string | null) ?? '' })}
              />
            </label>
          )}
          <p>
            {draft.body.target
              ? 'Add selected files to this bundle; its existing order and metadata remain.'
              : body.kind === 'collection'
                ? 'Create the selected groups with their required collection ancestors.'
                : 'Create a new bundle from the selected files.'}
          </p>
          {selection && (
            <>
              <button onClick={() => select({ all: true, exclude: [], groups: [] })}>
                Select all files
              </button>
              <button onClick={() => select({ all: false, exclude: [] })}>
                Deselect all files
              </button>
              <p>
                Selection applies to all {body.file_count} files, including other pages. Already
                accepted files stay in their settled bundles.
              </p>
            </>
          )}
        </>
      )}
      {groups.error && (
        <p role="alert">
          {groups.error.message}
          <button onClick={() => void groups.refetch()}>Retry group page</button>
        </p>
      )}
      {groups.data && (
        <section aria-label="Proposed groups and ancestors">
          {groups.data.items.map((group) => (
            <div key={group.id}>
              {body.kind === 'collection' && selection ? (
                <label>
                  <input
                    type="checkbox"
                    checked={!selection.groups.includes(group.id)}
                    onChange={(event) =>
                      select({
                        groups: event.target.checked
                          ? selection.groups.filter((id) => id !== group.id)
                          : [...selection.groups, group.id],
                      })
                    }
                  />
                  {group.title}
                </label>
              ) : (
                <strong>{group.title}</strong>
              )}
              <p>
                {group.target
                  ? 'Addition to an existing bundle; its current collections are preserved.'
                  : group.ancestors.length
                    ? `Required collections: ${group.ancestors.map((node) => node.title).join(' / ')}`
                    : 'No required collection ancestors'}
              </p>
            </div>
          ))}
          {groups.data.next_cursor && (
            <button onClick={() => setGroupAfter(groups.data!.next_cursor!)}>Next groups</button>
          )}
          {groupAfter && <button onClick={() => setGroupAfter('')}>First groups</button>}
        </section>
      )}
      {body.kind === 'repair' && (
        <label>
          Missing file to repair
          <select
            value={draft.body.repair}
            onChange={(event) => update({ repair: event.target.value })}
          >
            <option value="">Choose a missing file</option>
            {identities.data?.selected &&
              !identities.data.items.some((item) => item.file_id === draft.body.repair) && (
                <option value={draft.body.repair}>{identities.data.selected.path}</option>
              )}
            {(identities.data?.items ?? body.choices)?.map((item) => (
              <option key={item.file_id} value={item.file_id}>
                {item.path}
              </option>
            ))}
          </select>
          {identities.data?.next_cursor && (
            <button onClick={() => setChoiceAfter(identities.data!.next_cursor!)}>
              Next missing identities
            </button>
          )}
          {choiceAfter && (
            <button onClick={() => setChoiceAfter('')}>First missing identities</button>
          )}
          {identities.error && (
            <p role="alert">
              {identities.error.message}
              <button onClick={() => void identities.refetch()}>Retry missing identities</button>
            </p>
          )}
        </label>
      )}
      {body.kind === 'replacement' && (
        <label>
          <input
            type="checkbox"
            checked={draft.body.replacement}
            onChange={(event) => update({ replacement: event.target.checked })}
          />
          Use these replacement bytes for the existing file identity and its metadata
        </label>
      )}
      {files.isFetching && <p>Loading file page…</p>}
      {files.error && (
        <p role="alert">
          {files.error.message}
          <button onClick={() => void files.refetch()}>Retry file page</button>
        </p>
      )}
      <ol aria-label="Discovered files">
        {page.map((file, index) => (
          <li key={file.path}>
            {selectable ? (
              <label>
                <input
                  type="checkbox"
                  checked={checked(file)}
                  disabled={file.accepted}
                  onChange={(event) => {
                    if (selection)
                      select({
                        exclude: selection.exclude.includes(file.id!)
                          ? selection.exclude.filter((id) => id !== file.id)
                          : [...selection.exclude, file.id!],
                      })
                    else
                      update({
                        files: JSON.stringify(
                          event.target.checked
                            ? [...(choice as string[]), file.id!]
                            : (choice as string[]).filter((id) => id !== file.id),
                        ),
                      })
                  }}
                />
                {file.path}
                {file.accepted ? ' · Already accepted' : ''}
              </label>
            ) : (
              file.path
            )}
            {selectable && checked(file) && (
              <button
                aria-label={`Move ${file.path} earlier`}
                disabled={index === 0}
                onClick={() => {
                  if (selection)
                    select({
                      moves: [...selection.moves, { file: file.id!, before: page[index - 1]!.id! }],
                    })
                  else {
                    const order = [...(choice as string[])]
                    const at = order.indexOf(file.id!)
                    if (at > 0) {
                      ;[order[at - 1], order[at]] = [order[at]!, order[at - 1]!]
                      update({ files: JSON.stringify(order) })
                    }
                  }
                }}
              >
                Move earlier
              </button>
            )}
          </li>
        ))}
      </ol>
      {next != null && <button onClick={() => setAfter(next)}>Next files</button>}
      {after !== -1 && <button onClick={() => setAfter(-1)}>First files</button>}
      {selection && selection.moves.length > 0 && (
        <p>{selection.moves.length} file order changes will be shown in the prepared review.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={
          busy ||
          (selectable &&
            (selection
              ? !selection.all && !selection.exclude.length
              : !(choice as string[]).length)) ||
          (body.kind === 'repair' && !draft.body.repair) ||
          (body.kind === 'verification' && !verification) ||
          (body.kind === 'replacement' && !draft.body.replacement)
        }
        onClick={() => void prepare()}
      >
        {busy ? 'Preparing…' : 'Prepare grouping review'}
      </button>
    </section>
  )
}
