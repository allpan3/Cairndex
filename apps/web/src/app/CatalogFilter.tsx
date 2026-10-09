// Explicit replacement conditions leave arbitrary existing filter AST text untouched
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import { CatalogReference } from './CatalogControls'
import { FIELDS, OP_LABELS } from './filterModel'

type Condition = { field: string; operator: string; raw: string; descendants: boolean }

// A fresh condition is a replacement draft, never an interpretation of an existing AST
const condition = (field = 'title'): Condition => {
  const definition = FIELDS.find((item) => item.field === field)!
  return {
    field,
    operator: definition.operators[0]!,
    raw:
      definition.kind === 'bool'
        ? 'true'
        : definition.kind === 'number' || definition.kind === 'rating'
          ? '0'
          : '""',
    descendants: false,
  }
}

// Structured replacement shares the allowlist while keeping numeric input as exact text
export function CatalogFilter({
  library,
  raw,
  onChange,
}: {
  library: string
  raw: string
  onChange: (raw: string) => void
}) {
  const preview = useQuery({
    queryKey: ['catalog-filter-preview', library, raw],
    queryFn: () =>
      catalog<{ total: number }>(library, '/bundles/browse', 'POST', {
        filter: JSON.parse(JSON.parse(raw)),
        limit: 1,
      }),
    retry: false,
  })
  const [rows, setRows] = useState<Condition[]>([condition()])
  const [match, setMatch] = useState('and')
  const [building, setBuilding] = useState(false)
  // Serialize only newly authored conditions; original opaque text is never round-tripped
  function replace(next: Condition[], mode = match) {
    setRows(next)
    setMatch(mode)
    const children = next.map((row) => {
      const relation = ['tags', 'collections'].includes(row.field)
      const value = row.operator === 'is_null' ? 'true' : relation ? `[${row.raw}]` : row.raw
      return `{"field":${JSON.stringify(row.field)},"operator":${JSON.stringify(row.operator)},"value":${value},"include_descendants":${row.descendants}}`
    })
    onChange(
      JSON.stringify(
        `{"version":1,"root":${children.length ? `{"op":"${mode}","children":[${children.join(',')}]}` : 'null'}}`,
      ),
    )
  }
  return (
    <section aria-label="Saved filter conditions">
      {preview.isPending && <p role="status">Checking matching bundles…</p>}
      {preview.data && <p role="status">{preview.data.total} matching bundles</p>}
      {preview.error && (
        <p role="alert">
          Filter preview is unavailable. Check the expression. {preview.error.message}
        </p>
      )}
      <label>
        Exact filter AST
        <textarea
          aria-label="Exact filter AST"
          value={JSON.parse(raw) as string}
          onChange={(event) => {
            setBuilding(false)
            onChange(JSON.stringify(event.target.value))
          }}
        />
      </label>
      <button type="button" onClick={() => setBuilding(!building)}>
        Compose replacement conditions
      </button>
      {building && (
        <div>
          <p>
            Changing a condition replaces the complete filter. Existing text stays intact until an
            edit.
          </p>
          <label>
            Match
            <select
              aria-label="Filter match"
              value={match}
              onChange={(event) => replace(rows, event.target.value)}
            >
              <option value="and">All conditions</option>
              <option value="or">Any condition</option>
            </select>
          </label>
          {rows.map((row, index) => {
            const definition = FIELDS.find((item) => item.field === row.field)!
            const numeric =
              ['number', 'rating'].includes(definition.kind) && row.operator !== 'is_null'
            // Every deliberate edit persists the entire replacement in the enclosing durable draft
            const update = (patch: Partial<Condition>) =>
              replace(rows.map((old, i) => (i === index ? { ...old, ...patch } : old)))
            return (
              <fieldset key={index}>
                <legend>Condition {index + 1}</legend>
                <select
                  aria-label={`Condition ${index + 1} field`}
                  value={row.field}
                  onChange={(event) =>
                    replace(
                      rows.map((old, i) => (i === index ? condition(event.target.value) : old)),
                    )
                  }
                >
                  {FIELDS.map((item) => (
                    <option key={item.field} value={item.field}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Condition ${index + 1} operator`}
                  value={row.operator}
                  onChange={(event) => update({ operator: event.target.value })}
                >
                  {definition.operators.map((operator) => (
                    <option key={operator} value={operator}>
                      {OP_LABELS[operator] ?? operator}
                    </option>
                  ))}
                </select>
                {['tags', 'collections'].includes(definition.kind) ? (
                  <>
                    <CatalogReference
                      library={library}
                      family={row.field}
                      raw={row.raw}
                      label={`Condition ${index + 1} reference`}
                      onChange={(value) => update({ raw: value })}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={row.descendants}
                        onChange={(event) => update({ descendants: event.target.checked })}
                      />
                      Include descendants
                    </label>
                  </>
                ) : row.operator === 'is_null' ? (
                  <span>Unrated</span>
                ) : definition.kind === 'bool' ? (
                  <select
                    aria-label={`Condition ${index + 1} value`}
                    value={row.raw}
                    onChange={(event) => update({ raw: event.target.value })}
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    aria-label={`Condition ${index + 1} value`}
                    inputMode={numeric ? 'decimal' : 'text'}
                    value={numeric ? row.raw : (JSON.parse(row.raw) as string)}
                    onChange={(event) =>
                      update({
                        raw: numeric ? event.target.value : JSON.stringify(event.target.value),
                      })
                    }
                  />
                )}
                <button type="button" onClick={() => replace(rows.filter((_, i) => i !== index))}>
                  Remove condition {index + 1}
                </button>
              </fieldset>
            )
          })}
          <button type="button" onClick={() => replace([...rows, condition()])}>
            Add condition
          </button>
        </div>
      )}
    </section>
  )
}
