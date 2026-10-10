// Accessible authored-value controls preserve exact JSON cells and numeric text
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, entityLabel, type Control, type Page } from '../api/catalog'

// References browse complete server pages and return the chosen object's observed lifetime
export function CatalogReference({
  library,
  family,
  raw,
  label,
  onChange,
}: {
  library: string
  family: string
  raw: string
  label: string
  onChange: (raw: string, observed?: Record<string, string[]>) => void
}) {
  const [after, setAfter] = useState('')
  const page = useQuery({
    queryKey: ['catalog-reference', library, family, after],
    queryFn: () => catalog<Page>(library, `/entities/${family}?after=${encodeURIComponent(after)}`),
  })
  const selected = raw === 'null' ? '' : (JSON.parse(raw) as string)
  return (
    <div>
      <select
        aria-label={label}
        value={selected}
        onChange={(event) => {
          const item = page.data?.items.find((candidate) => candidate.id === event.target.value)
          onChange(event.target.value ? JSON.stringify(event.target.value) : 'null', item?.observed)
        }}
      >
        <option value="">Not set</option>
        {selected && !page.data?.items.some((item) => item.id === selected) && (
          <option value={selected}>{selected}</option>
        )}
        {page.data?.items.map((item) => (
          <option value={item.id} key={item.id}>
            {entityLabel(item)}
          </option>
        ))}
      </select>
      {page.isPending && <span>Loading choices…</span>}
      {page.error && <p role="alert">{page.error.message}</p>}
      {page.data?.next_cursor && (
        <button type="button" onClick={() => setAfter(page.data!.next_cursor!)}>
          More choices
        </button>
      )}
      {after && (
        <button type="button" onClick={() => setAfter('')}>
          First choices
        </button>
      )}
    </div>
  )
}

// Notes remain a complete ordered list, preserving duplicate and empty entries
function Notes({ raw, onChange }: { raw: string; onChange: (raw: string) => void }) {
  const sqlNull = raw === 'null'
  const jsonText = sqlNull ? null : (JSON.parse(raw) as string)
  const notes = jsonText === null || jsonText === 'null' ? null : (JSON.parse(jsonText) as string[])
  const update = (next: string[]) => onChange(JSON.stringify(JSON.stringify(next)))
  return (
    <div>
      <select
        aria-label="Notes value"
        value={sqlNull ? 'sql-null' : notes === null ? 'json-null' : 'list'}
        onChange={(event) =>
          onChange(
            event.target.value === 'sql-null'
              ? 'null'
              : JSON.stringify(event.target.value === 'json-null' ? 'null' : '[]'),
          )
        }
      >
        <option value="sql-null">Not set</option>
        <option value="json-null">JSON null</option>
        <option value="list">Ordered notes</option>
      </select>
      {notes?.map((note, index) => (
        <div key={index}>
          <textarea
            aria-label={`Note ${index + 1}`}
            value={note}
            onChange={(event) =>
              update(notes.map((old, i) => (i === index ? event.target.value : old)))
            }
          />
          <button type="button" onClick={() => update(notes.filter((_, i) => i !== index))}>
            Remove note {index + 1}
          </button>
          {index > 0 && (
            <button
              type="button"
              onClick={() => {
                const next = [...notes]
                ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
                update(next)
              }}
            >
              Move note {index + 1} up
            </button>
          )}
        </div>
      ))}
      {notes && (
        <button type="button" onClick={() => update([...notes, ''])}>
          Add note
        </button>
      )}
    </div>
  )
}

// Numeric inputs pass through as text and are validated by the background save job
export function CatalogValue({
  library,
  control,
  raw,
  onChange,
}: {
  library: string
  control: Control
  raw: string
  onChange: (raw: string, observed?: Record<string, string[]>) => void
}) {
  if (control.field === 'notes') return <Notes raw={raw} onChange={onChange} />
  if (control.kind === 'reference' && control.reference_family)
    return (
      <CatalogReference
        library={library}
        family={control.reference_family}
        raw={raw}
        label={control.label}
        onChange={onChange}
      />
    )
  const empty = raw === 'null'
  const text = empty
    ? ''
    : control.kind === 'number' || control.kind === 'boolean'
      ? raw
      : (JSON.parse(raw) as string)
  return (
    <div>
      {control.nullable && (
        <label>
          <input
            type="checkbox"
            checked={empty}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? 'null'
                  : control.kind === 'number'
                    ? '0'
                    : JSON.stringify(''),
              )
            }
          />
          Not set
        </label>
      )}
      {control.kind === 'enum' || control.kind === 'boolean' ? (
        <select
          aria-label={control.label}
          disabled={empty}
          value={text}
          onChange={(event) =>
            onChange(
              control.kind === 'boolean' ? event.target.value : JSON.stringify(event.target.value),
            )
          }
        >
          {(control.kind === 'boolean' ? ['0', '1'] : control.choices).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : control.kind === 'number' ? (
        <input
          aria-label={control.label}
          inputMode="decimal"
          disabled={empty}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <textarea
          aria-label={control.label}
          disabled={empty}
          value={text}
          onChange={(event) => onChange(JSON.stringify(event.target.value))}
        />
      )}
      {control.kind === 'json' && (
        <small>Exact metadata text is preserved, including numeric precision.</small>
      )}
    </div>
  )
}
