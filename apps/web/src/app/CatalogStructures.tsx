// Membership, hierarchy and composite fields have explicit domain controls
import { useState } from 'react'
import type { Control, Entity, Field } from '../api/catalog'
import { CatalogFilter } from './CatalogFilter'
import { CatalogReference, CatalogValue } from './CatalogControls'

// Compose raw cell strings without parsing and reserializing their numeric values
const compose = (cells: Record<string, string>) =>
  `{${Object.entries(cells)
    .map(([name, raw]) => `${JSON.stringify(name)}:${raw}`)
    .join(',')}}`

// Ordered rows display in bounded pages and submit a complete background operation preview
export function CatalogArrangement({
  library,
  entity,
  field,
  onPreview,
}: {
  library: string
  entity: Entity
  field: Field
  onPreview: (body: unknown) => void
}) {
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [target, setTarget] = useState('null')
  const items = JSON.parse(field.value ?? '[]') as {
    id: string
    family?: string
    parent_id?: string | null
  }[]
  const forest = field.unit.endsWith('/$forest')
  return (
    <section aria-label={forest ? 'Hierarchy arrangement' : 'Bundle membership'}>
      <p>
        {forest
          ? 'The complete hierarchy and sibling order form one choice.'
          : 'File transfers include the complete source and destination order and dependent metadata.'}
      </p>
      <ol>
        {items.slice(page * 30, (page + 1) * 30).map((item) => (
          <li key={`${item.family}/${item.id}`}>
            {!forest && (
              <input
                type="checkbox"
                aria-label={`Select ${item.id}`}
                checked={selected.includes(`${item.family}/${item.id}`)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, `${item.family}/${item.id}`]
                      : selected.filter((id) => id !== `${item.family}/${item.id}`),
                  )
                }
              />
            )}
            <span>{item.id}</span>
            <button
              onClick={() =>
                onPreview({ action: 'reorder', unit: field.unit, entity: item.id, offset: -1 })
              }
            >
              Move up
            </button>
            <button
              onClick={() =>
                onPreview({ action: 'reorder', unit: field.unit, entity: item.id, offset: 1 })
              }
            >
              Move down
            </button>
            {forest && (
              <CatalogReference
                library={library}
                family={entity.family}
                raw={JSON.stringify(item.parent_id ?? null)}
                label={`Parent of ${item.id}`}
                onChange={(raw) =>
                  onPreview({
                    action: 'reorder',
                    unit: field.unit,
                    entity: item.id,
                    parent: JSON.parse(raw),
                    offset: 0,
                  })
                }
              />
            )}
          </li>
        ))}
      </ol>
      {page > 0 && <button onClick={() => setPage(page - 1)}>Previous members</button>}
      {(page + 1) * 30 < items.length && (
        <button onClick={() => setPage(page + 1)}>More members</button>
      )}
      {!forest && (
        <div>
          <CatalogReference
            library={library}
            family="asset_bundles"
            raw={target}
            label="Transfer destination"
            onChange={setTarget}
          />
          <button
            disabled={!selected.length || target === 'null'}
            onClick={() =>
              onPreview({
                action: 'transfer',
                source: entity.id,
                target: JSON.parse(target),
                members: selected,
              })
            }
          >
            Prepare transfer
          </button>
        </div>
      )}
    </section>
  )
}

// Span/source columns preserve untouched cells exactly while providing reference pickers
export function CatalogComposite({
  library,
  field,
  control,
  raw,
  onChange,
}: {
  library: string
  field: Field
  control: Control
  raw: string
  onChange: (raw: string, observed?: Record<string, string[]>) => void
}) {
  const cells = Object.fromEntries(
    [...raw.matchAll(/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*"|[^,}]*)/g)].map((match) => [
      JSON.parse(match[1]!) as string,
      match[2]!.trim(),
    ]),
  )
  const change = (name: string, next: string, observed?: Record<string, string[]>) => {
    const nextCells = { ...cells, [name]: next }
    onChange(compose(nextCells), observed)
  }
  // The original raw composite is retained until a deliberate component edit
  return (
    <div data-draft-changed={raw !== field.value}>
      {control.columns.map((name) => {
        const reference =
          name === 'bundle_id' ? 'asset_bundles' : name.endsWith('file_id') ? 'asset_files' : null
        const numeric = ['start_s', 'end_s', 'embedded_index', 'filter_version'].includes(name)
        const component: Control = {
          field: name,
          label: name.replaceAll('_', ' '),
          kind: reference ? 'reference' : numeric ? 'number' : 'json',
          nullable: ['end_s', 'video_file_id', 'source_file_id', 'embedded_index'].includes(name),
          choices: [],
          reference_family: reference,
          columns: [],
        }
        return (
          <label key={name}>
            {component.label}
            {name === 'filter_json' ? (
              <CatalogFilter
                library={library}
                raw={cells[name] ?? '"{}"'}
                onChange={(next) => change(name, next)}
              />
            ) : (
              <CatalogValue
                library={library}
                control={component}
                raw={cells[name] ?? 'null'}
                onChange={(next, observed) => change(name, next, observed)}
              />
            )}
          </label>
        )
      })}
    </div>
  )
}
