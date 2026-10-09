import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CatalogJobError, catalog, operationId, runJob, type Job } from '../api/catalog'
import type { components } from '../api/schema'
import { InspectorSection } from './InspectorSection'
import { useCatalogDraft } from './useCatalogDraft'

type Choice = components['schemas']['CatalogMembershipChoice']
type Page = components['schemas']['CatalogMembershipPage']

// A prepared membership change retains its exact operation across reload and response loss.
export function CatalogMembershipPicker({
  library,
  bundle,
  editor,
  family,
  blocked,
  onReview,
}: {
  library: string
  bundle: string
  editor: string
  family: 'tags' | 'collections'
  blocked: boolean
  onReview: () => void
}) {
  const title = family === 'tags' ? 'Tags' : 'Collections'
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [after, setAfter] = useState('')
  const [assigned, setAssigned] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const draft = useCatalogDraft(library, `membership/${bundle}/${family}`, editor, {
    operation: '',
    command: '',
    label: '',
    applying: '',
  })
  const page = useQuery({
    queryKey: ['catalog-memberships', library, bundle, family, search, after, assigned],
    queryFn: () =>
      catalog<Page>(
        library,
        `/bundles/${bundle}/memberships/${family}?${new URLSearchParams({
          q: search,
          after,
          assigned: String(assigned),
        })}`,
      ),
    refetchInterval: 2000,
  })
  const prepared = useQuery({
    queryKey: ['catalog-membership-review', library, draft.body.operation],
    enabled: Boolean(draft.body.operation),
    queryFn: () => catalog<Job>(library, `/jobs/${draft.body.operation}`),
    retry: false,
    refetchInterval: draft.body.operation ? 2000 : false,
  })
  async function prepare(choice?: Choice) {
    setBusy(true)
    setError('')
    setMessage('')
    const intent = choice
      ? {
          operation: operationId(),
          command: JSON.stringify({
            action: 'membership',
            bundle,
            family,
            target: choice.id,
            assigned: !choice.assigned,
            observed: choice.observed,
          }),
          label: `${choice.assigned ? 'Remove' : 'Add'} ${choice.name}`,
          applying: '',
        }
      : draft.body
    draft.update(intent)
    try {
      await runJob(library, 'preview', JSON.parse(intent.command), intent.operation)
      await client.invalidateQueries({ queryKey: ['catalog-membership-review', library] })
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function apply() {
    const job = prepared.data
    if (!job?.receipt) return
    setBusy(true)
    setError('')
    draft.update({ ...draft.body, applying: 'true' })
    try {
      await runJob(
        library,
        'commit_preview',
        { job: job.id, receipt: job.receipt },
        `commit_${job.id}`,
      )
      draft.update({ operation: '', command: '', label: '', applying: '' })
      setMessage('Saved here')
      await client.invalidateQueries({ queryKey: ['catalog-memberships', library] })
      await client.invalidateQueries({ queryKey: ['catalog-browse', library] })
    } catch (reason) {
      if (reason instanceof CatalogJobError) draft.update({ ...draft.body, applying: '' })
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <InspectorSection id={family} title={title}>
      <section aria-label={`${title} membership`} className="catalog-membership-picker">
        <label>
          Search {title.toLowerCase()}
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setAfter('')
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={assigned}
            onChange={(event) => {
              setAssigned(event.target.checked)
              setAfter('')
            }}
          />
          Show assigned {title.toLowerCase()} only
        </label>
        {page.isPending && <p>Loading {title.toLowerCase()}…</p>}
        {page.error && (
          <button onClick={() => void page.refetch()}>Retry {title.toLowerCase()}</button>
        )}
        {page.data?.items.length === 0 && <p>No matching {title.toLowerCase()}.</p>}
        {page.data?.items.map((choice) => (
          <div key={choice.id} className="catalog-membership-row">
            <span>
              {choice.name}
              {choice.path.length > 1 && (
                <small className="catalog-membership-path">
                  {choice.path.slice(0, -1).join(' / ')}
                </small>
              )}
            </span>
            {choice.held ? (
              <button onClick={onReview}>Review conflict</button>
            ) : (
              <button
                disabled={blocked || busy || Boolean(draft.body.operation)}
                onClick={() => void prepare(choice)}
                aria-label={`${choice.assigned ? 'Remove' : 'Add'} ${choice.name}`}
              >
                {choice.assigned ? 'Remove' : 'Add'}
              </button>
            )}
          </div>
        ))}
        {after && <button onClick={() => setAfter('')}>First page</button>}
        {page.data?.next_cursor && (
          <button onClick={() => setAfter(page.data!.next_cursor!)}>
            More {title.toLowerCase()}
          </button>
        )}
        {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
        {message && <p role="status">{message}</p>}
        {draft.body.operation && (
          <section aria-label={`Review ${title.toLowerCase()} membership`}>
            <h3>{draft.body.label}</h3>
            {prepared.data?.state === 'succeeded' ? (
              <>
                <p>Only metadata changes. Files stay in place.</p>
                {prepared.data.result?.changes.some(
                  (change) => change.unit.endsWith('/cover_bundle_id') && change.value === 'null',
                ) && (
                  <p>This removal also clears collection covers that require this membership.</p>
                )}
                <button disabled={busy || blocked} onClick={() => void apply()}>
                  {draft.body.applying ? 'Retry membership save' : 'Apply membership change'}
                </button>
              </>
            ) : (
              <>
                <p>{prepared.data?.error ?? 'The prepared review is not available yet.'}</p>
                <button disabled={busy || blocked} onClick={() => void prepare()}>
                  Retry membership review
                </button>
              </>
            )}
            <button
              disabled={busy || Boolean(draft.body.applying)}
              onClick={() =>
                void draft.discard().catch((reason: Error) => setError(reason.message))
              }
            >
              Cancel membership change
            </button>
          </section>
        )}
        {!draft.body.operation &&
          draft.copies
            .filter((copy) => copy.body.operation)
            .map((copy) => (
              <button key={copy.id} onClick={() => draft.update(copy.body)}>
                Recover membership review {copy.revision}
              </button>
            ))}
      </section>
    </InspectorSection>
  )
}
