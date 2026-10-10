// Complete structural choices and historical recovery retain every rejected alternative
import { useState } from 'react'
import { useCatalogDraft } from './useCatalogDraft'
import { useQuery } from '@tanstack/react-query'
import { catalog, displayCell, type Entity, type Field } from '../api/catalog'

// Show the entire affected scope before preparing a causally based resolution
export function CatalogReview({
  library,
  editor,
  unit,
  onPreview,
  onClose,
}: {
  library: string
  editor: string
  unit: string
  onPreview: (body: unknown, action?: string) => void
  onClose: () => void
}) {
  const draft = useCatalogDraft(library, `review/${unit}`, editor, {
    choices: {} as Record<string, string>,
    recover: false,
    observed: {} as Record<string, string>,
  })
  const { choices, recover } = draft.body
  // Each selection keeps its exact value text in a private review draft
  const bases = () =>
    Object.keys(draft.body.observed).length
      ? draft.body.observed
      : Object.fromEntries(
          review.data?.map((field) => [field.unit, JSON.stringify(field.basis)]) ?? [],
        )
  const setChoices = (next: Record<string, string>) =>
    draft.update({ choices: next, recover, observed: bases() })
  const setRecover = (next: boolean) => draft.update({ choices, recover: next, observed: bases() })
  const review = useQuery({
    queryKey: ['catalog-review', library, unit],
    queryFn: async () => {
      const history = await catalog<{ scope: string[] }>(
        library,
        `/history?unit=${encodeURIComponent(unit)}`,
      )
      const owners = [
        ...new Set(history.scope.map((item) => item.split('/').slice(0, 2).join('/'))),
      ]
      const entities = await Promise.all(
        owners.map((owner) => catalog<Entity>(library, `/entities/${owner}`)),
      )
      return history.scope.map(
        (item) =>
          entities.find((entity) => item.startsWith(`${entity.family}/${entity.id}/`))!.fields[
            item.split('/')[2]!
          ]!,
      )
    },
  })
  const selected = (field: Field) =>
    choices[field.unit] ?? (field.candidates.length === 1 ? (field.value ?? undefined) : undefined)
  return (
    <section aria-label="Complete conflict review">
      <h3>Review affected metadata</h3>
      {draft.error && <p role="alert">{draft.error}</p>}
      {draft.copies.map((copy) => (
        <button key={copy.id} onClick={() => draft.update(copy.body)}>
          Recover conflict review draft {copy.revision}
        </button>
      ))}
      <p>
        This choice covers every relationship and order shown below. Rejected versions remain in
        history.
      </p>
      {review.error && <p role="alert">{review.error.message}</p>}
      {review.isPending && <p>Loading alternatives…</p>}
      {review.data?.map((field) => (
        <fieldset key={field.unit}>
          <legend>{field.unit.split('/').slice(1).join(' · ')}</legend>
          {[
            ...new Set([
              ...(field.value === null ? [] : [field.value]),
              ...field.candidates.map((candidate) => candidate.value),
            ]),
          ].map((raw, index) => (
            <label key={raw}>
              <input
                type="radio"
                name={field.unit}
                checked={selected(field) === raw}
                onChange={() => setChoices({ ...choices, [field.unit]: raw })}
              />
              {index === 0 && raw === field.value ? 'Current local view: ' : 'Alternative: '}
              <span className="catalog-exact">{displayCell(raw)}</span>
            </label>
          ))}
          <details>
            <summary>Compose a replacement</summary>
            <label>
              Complete value as JSON
              <textarea
                aria-label={`Replacement for ${field.unit}`}
                value={choices[field.unit] ?? ''}
                onChange={(event) => setChoices({ ...choices, [field.unit]: event.target.value })}
              />
            </label>
          </details>
        </fieldset>
      ))}
      <label>
        <input
          type="checkbox"
          checked={recover}
          onChange={(event) => setRecover(event.target.checked)}
        />
        Explicitly restore a deleted identity and its reviewed relationships
      </label>
      <button
        disabled={!review.data || review.data.some((field) => selected(field) === undefined)}
        onClick={() =>
          onPreview({
            action: 'choose',
            unit,
            recover,
            choices: Object.fromEntries(review.data!.map((field) => [field.unit, selected(field)])),
            observed: Object.fromEntries(
              Object.entries(bases()).map(([target, raw]) => [target, JSON.parse(raw) as string[]]),
            ),
          })
        }
      >
        Prepare choice
      </button>
      <button onClick={() => void draft.discard().then(() => review.refetch())}>
        Start a fresh review
      </button>
      <button onClick={onClose}>Close review</button>
    </section>
  )
}

// Scalar restoration uses a new field save; complete branch recovery is a separately named action
export function CatalogHistory({
  library,
  entity,
  field,
  onUse,
  onPreview,
  onClose,
}: {
  library: string
  entity: Entity
  field: Field
  onUse: (raw: string) => void
  onPreview: (body: unknown, action?: string) => void
  onClose: () => void
}) {
  const [after, setAfter] = useState('')
  const history = useQuery({
    queryKey: ['catalog-history', library, field.unit, after],
    queryFn: () =>
      catalog<{
        items: { event: string; value: string; active: number }[]
        next_cursor: string | null
      }>(library, `/history?unit=${encodeURIComponent(field.unit)}&after=${after}`),
  })
  return (
    <section aria-label="Retained metadata history">
      <h3>Retained versions</h3>
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.items.map((item) => (
        <div key={item.event} className="catalog-history-value">
          <p className="catalog-exact">{displayCell(item.value)}</p>
          <button onClick={() => onUse(item.value)}>Use this value</button>
          <button
            onClick={() =>
              onPreview({ event: item.event, family: entity.family, entity: entity.id }, 'recover')
            }
          >
            Recover object from this branch
          </button>
        </div>
      ))}
      <p>
        Recovering an object prepares its retained version and necessary relationships for review.
      </p>
      {history.data?.next_cursor && (
        <button onClick={() => setAfter(history.data!.next_cursor!)}>More retained versions</button>
      )}
      <button onClick={onClose}>Close history</button>
    </section>
  )
}
