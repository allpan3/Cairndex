import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, CatalogJobError, operationId, runJob, type Job } from '../api/catalog'
import type { components } from '../api/schema'
import { useCatalogDraft } from './useCatalogDraft'
import { validCatalogBulkDraft } from './catalogBulkDraft'

type Snapshot = components['schemas']['CatalogSelectionRead']
type Choices = components['schemas']['CatalogBulkMembershipPage']
const empty = {
  snapshot: '',
  field: 'title',
  value: '',
  command: '',
  operation: '',
  applying: '',
  label: '',
}

// One retained review owns its targets independently of the current browser selection.
export function CatalogMultiBundleInspector({
  library,
  editor,
  ids,
  blocked,
  onReview,
  onClose,
}: {
  library: string
  editor: string
  ids: string[]
  blocked: boolean
  onReview: () => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const draft = useCatalogDraft(library, 'bulk', editor, empty, validCatalogBulkDraft)
  const [family, setFamily] = useState<'tags' | 'collections'>('tags')
  const [search, setSearch] = useState('')
  const [after, setAfter] = useState('')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const supported = ids.length > 0 && ids.length <= 100
  const snapshot = useQuery({
    queryKey: ['catalog-selection', library, ids],
    enabled: supported,
    queryFn: () => catalog<Snapshot>(library, '/bundles/selection', 'POST', { ids }),
    refetchInterval: 2000,
  })
  const choices = useQuery({
    queryKey: ['catalog-bulk-memberships', library, ids, family, search, after],
    enabled: supported,
    queryFn: () =>
      catalog<Choices>(library, '/bundles/selection/memberships', 'POST', {
        ids,
        family,
        q: search,
        after,
      }),
    refetchInterval: 2000,
  })
  const review = useQuery({
    queryKey: ['catalog-bulk-review', library, draft.body.operation],
    enabled: Boolean(draft.body.operation),
    queryFn: () => catalog<Job>(library, `/jobs/${draft.body.operation}`),
    retry: false,
    refetchInterval: draft.body.operation ? 2000 : false,
  })
  const retained: Snapshot | undefined = draft.body.snapshot
    ? JSON.parse(draft.body.snapshot)
    : undefined
  const targets = retained?.items ?? snapshot.data?.items ?? []
  const locked = busy || blocked || Boolean(draft.body.operation)
  function change(field: string, value: string) {
    if (!snapshot.data || locked) return
    draft.update({
      ...draft.body,
      field,
      value,
      snapshot: draft.body.snapshot || JSON.stringify(snapshot.data),
    })
    setMessage('Private draft retained')
  }
  async function prepare(command?: object, label?: string) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    const intent = command
      ? {
          ...draft.body,
          operation: operationId(),
          command: JSON.stringify(command),
          snapshot: draft.body.snapshot || JSON.stringify(snapshot.data),
          label: label!,
          applying: '',
        }
      : draft.body
    draft.update(intent)
    try {
      await runJob(library, 'preview', JSON.parse(intent.command), intent.operation)
      await client.invalidateQueries({ queryKey: ['catalog-bulk-review', library] })
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  function scalar() {
    const field = draft.body.field
    const observed = Object.fromEntries(
      targets.flatMap((item) =>
        Object.entries(item.observed).filter(
          ([unit]) => unit.endsWith(`/${field}`) || unit.endsWith('/$alive'),
        ),
      ),
    )
    void prepare(
      {
        action: 'bulk',
        ids: targets.map((item) => item.id),
        field,
        value:
          field === 'title'
            ? draft.body.value
            : draft.body.value === ''
              ? null
              : Number(draft.body.value),
        observed,
      },
      field === 'title'
        ? `Set title: ${draft.body.value}`
        : `Set rating: ${draft.body.value || 'Not set'}`,
    )
  }
  async function apply() {
    if (running.current || !review.data?.receipt) return
    running.current = true
    setBusy(true)
    setError('')
    draft.update({ ...draft.body, applying: 'true' })
    try {
      await runJob(
        library,
        'commit_preview',
        { job: review.data.id, receipt: review.data.receipt },
        `commit_${review.data.id}`,
      )
      const saved = await catalog<Snapshot>(library, '/bundles/selection', 'POST', {
        ids: targets.map((item) => item.id),
      }).catch(() => null)
      draft.update(empty)
      setMessage(
        !saved || saved.items.some((item) => item.held)
          ? 'Saved here. Review the current metadata before another change.'
          : 'Saved here',
      )
      for (const key of [
        'catalog-browse',
        'catalog-detail',
        'catalog-selection',
        'catalog-bulk-memberships',
        'catalog-memberships',
      ])
        await client.invalidateQueries({ queryKey: [key, library] })
    } catch (reason) {
      if (reason instanceof CatalogJobError) draft.update({ ...draft.body, applying: '' })
      setError((reason as Error).message)
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <aside className="inspector catalog-bulk-inspector" aria-label="Selected bundles inspector">
      <h2>{ids.length} bundles selected</h2>
      <button onClick={onClose}>Close bulk editor</button>
      {!supported && <p>Select between 1 and 100 bundles for one metadata change.</p>}
      {snapshot.isPending && supported && <p>Loading selected metadata…</p>}
      {snapshot.data?.items.some((item) => item.held) && (
        <p role="alert">Competing metadata requires review.</p>
      )}
      {snapshot.error && (
        <button onClick={() => void snapshot.refetch()}>Retry selected metadata</button>
      )}
      <p>Each change applies only to the listed bundles. Files stay in place.</p>
      {retained && <p>The retained draft keeps its original selection.</p>}
      <details>
        <summary>Affected bundles ({targets.length})</summary>
        <ul>
          {targets.map((item) => (
            <li key={item.id}>{item.title || item.id}</li>
          ))}
        </ul>
      </details>
      <label>
        Change field
        <select
          aria-label="Bulk field"
          value={draft.body.field}
          disabled={locked || !snapshot.data || Boolean(retained)}
          onChange={(event) => change(event.target.value, '')}
        >
          <option value="title">Title</option>
          <option value="rating">Rating</option>
        </select>
      </label>
      {draft.body.field === 'title' ? (
        <label>
          Title
          <input
            aria-label="Bulk title"
            value={draft.body.value}
            disabled={locked || !snapshot.data}
            onChange={(event) => change('title', event.target.value)}
          />
        </label>
      ) : (
        <label>
          Rating
          <select
            aria-label="Bulk rating"
            value={draft.body.value}
            disabled={locked || !snapshot.data}
            onChange={(event) => change('rating', event.target.value)}
          >
            <option value="">Not set</option>
            {Array.from({ length: 11 }, (_, i) => (
              <option key={i} value={i / 2}>
                {i / 2}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        disabled={
          locked ||
          !retained ||
          targets.some((item) => item.held) ||
          (draft.body.field === 'title' && !draft.body.value.trim())
        }
        onClick={scalar}
      >
        Review bulk change
      </button>
      {!draft.body.snapshot && (
        <section aria-label="Bulk membership">
          <label>
            Membership
            <select
              aria-label="Bulk membership family"
              value={family}
              disabled={locked}
              onChange={(event) => {
                setFamily(event.target.value as 'tags' | 'collections')
                setAfter('')
                setSearch('')
              }}
            >
              <option value="tags">Tags</option>
              <option value="collections">Collections</option>
            </select>
          </label>
          <label>
            Search destinations
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setAfter('')
              }}
            />
          </label>
          {choices.error && (
            <button onClick={() => void choices.refetch()}>Retry destinations</button>
          )}
          {choices.data?.items.length === 0 && <p>No matching destinations.</p>}
          {choices.data?.items.map((choice) => (
            <div className="catalog-membership-row" key={choice.id}>
              <span>
                {choice.name} · {choice.assigned_count}/{ids.length}
              </span>
              <button
                disabled={
                  locked || !snapshot.data || choice.held || choice.assigned_count === ids.length
                }
                onClick={() =>
                  void prepare(
                    {
                      action: 'bulk',
                      ids,
                      field: family,
                      target: choice.id,
                      assigned: true,
                      observed: choice.observed,
                    },
                    `Add ${choice.name}`,
                  )
                }
              >
                Add to all
              </button>
              <button
                disabled={locked || !snapshot.data || choice.held || choice.assigned_count === 0}
                onClick={() =>
                  void prepare(
                    {
                      action: 'bulk',
                      ids,
                      field: family,
                      target: choice.id,
                      assigned: false,
                      observed: choice.observed,
                    },
                    `Remove ${choice.name}`,
                  )
                }
              >
                Remove from all
              </button>
            </div>
          ))}
          {after && <button onClick={() => setAfter('')}>First destinations</button>}
          {choices.data?.next_cursor && (
            <button onClick={() => setAfter(choices.data!.next_cursor!)}>More destinations</button>
          )}
        </section>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
      {message && <p role="status">{message}</p>}
      {draft.body.operation && (
        <section aria-label="Bulk change review">
          <h3>{draft.body.label}</h3>
          <p>{targets.length} bundles in this retained review.</p>
          {review.data?.state === 'succeeded' ? (
            <>
              {review.data.result?.changes.some(
                (change) => change.unit.endsWith('/cover_bundle_id') && change.value === 'null',
              ) && <p>This removal also clears collection covers that require this membership.</p>}
              <button disabled={busy || blocked} onClick={() => void apply()}>
                {draft.body.applying ? 'Retry bulk save' : 'Apply bulk change'}
              </button>
            </>
          ) : (
            <>
              <p>{review.data?.error ?? 'The prepared review is not available yet.'}</p>
              <button disabled={busy || blocked} onClick={() => void prepare()}>
                Retry bulk review
              </button>
            </>
          )}
        </section>
      )}
      {draft.body.snapshot && (
        <button
          disabled={busy || Boolean(draft.body.applying)}
          onClick={() => {
            void draft
              .discard()
              .then(() => {
                setError('')
                setMessage('Draft discarded')
              })
              .catch((reason: Error) => setError(reason.message))
          }}
        >
          Discard bulk draft
        </button>
      )}
      {!draft.body.snapshot &&
        draft.copies
          .filter((copy) => copy.body.snapshot)
          .map((copy) => (
            <button key={copy.id} onClick={() => draft.update(copy.body)}>
              Recover bulk review {copy.revision}
            </button>
          ))}
      <button onClick={onReview}>Review metadata and conflicts</button>
    </aside>
  )
}
