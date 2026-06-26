import { useMemo } from 'react'

import { useFolders, useTags } from '../api/hooks'
import {
  type Condition,
  type FieldDef,
  FIELDS,
  type FilterDraft,
  OP_LABELS,
  defaultValue,
  fieldDef,
  newCondition,
} from './filterModel'
import { flattenHierarchy, usePopover } from './usePopover'

// --- Component ---------------------------------------------------------------
export function FilterBuilder({
  draft,
  onChange,
}: {
  draft: FilterDraft
  onChange: (d: FilterDraft) => void
}) {
  const setRow = (i: number, patch: Partial<Condition>) =>
    onChange({ ...draft, rows: draft.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })

  const changeField = (i: number, field: string) => {
    const def = fieldDef(field)
    setRow(i, {
      field,
      operator: def.operators[0]!,
      value: defaultValue(def.kind),
      include_descendants: false,
    })
  }

  const addRow = () => onChange({ ...draft, rows: [...draft.rows, newCondition()] })
  const removeRow = (i: number) =>
    onChange({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })

  return (
    <div className="filter-builder">
      <div className="filter-builder__head">
        Match
        <select
          className="edit"
          value={draft.match}
          onChange={(e) => onChange({ ...draft, match: e.target.value as 'all' | 'any' })}
          aria-label="Match mode"
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of the following:
      </div>

      {draft.rows.map((row, i) => {
        const def = fieldDef(row.field)
        return (
          <div className="filter-row" key={i}>
            <select
              className="edit"
              value={row.field}
              onChange={(e) => changeField(i, e.target.value)}
              aria-label="Field"
            >
              {FIELDS.map((f) => (
                <option key={f.field} value={f.field}>
                  {f.label}
                </option>
              ))}
            </select>

            <select
              className="edit"
              value={row.operator}
              onChange={(e) => setRow(i, { operator: e.target.value })}
              aria-label="Operator"
            >
              {def.operators.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o] ?? o}
                </option>
              ))}
            </select>

            <ValueEditor row={row} def={def} onChange={(patch) => setRow(i, patch)} />

            <button
              className="filter-row__rm"
              onClick={() => removeRow(i)}
              aria-label="Remove condition"
              disabled={draft.rows.length === 1}
            >
              ×
            </button>
          </div>
        )
      })}

      <button className="add-btn" onClick={addRow}>
        + Add condition
      </button>
    </div>
  )
}

function ValueEditor({
  row,
  def,
  onChange,
}: {
  row: Condition
  def: FieldDef
  onChange: (patch: Partial<Condition>) => void
}) {
  if (def.kind === 'tags' || def.kind === 'folders') {
    return (
      <span className="filter-row__val">
        <HierPicker
          kind={def.kind}
          selected={(row.value as string[]) ?? []}
          onChange={(ids) => onChange({ value: ids })}
        />
        <label className="filter-row__desc">
          <input
            type="checkbox"
            checked={row.include_descendants}
            onChange={(e) => onChange({ include_descendants: e.target.checked })}
          />
          + sub
        </label>
      </span>
    )
  }
  if (def.kind === 'bool') {
    return (
      <select
        className="edit filter-row__val"
        value={String(row.value)}
        onChange={(e) => onChange({ value: e.target.value === 'true' })}
        aria-label="Value"
      >
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    )
  }
  if (def.kind === 'number') {
    return (
      <input
        className="edit filter-row__val"
        type="number"
        value={Number(row.value)}
        onChange={(e) => onChange({ value: e.target.value === '' ? 0 : Number(e.target.value) })}
        aria-label="Value"
      />
    )
  }
  if (def.kind === 'date') {
    return (
      <input
        className="edit filter-row__val"
        type="date"
        value={String(row.value)}
        onChange={(e) => onChange({ value: e.target.value })}
        aria-label="Value"
      />
    )
  }
  return (
    <input
      className="edit filter-row__val"
      value={String(row.value)}
      placeholder="value"
      onChange={(e) => onChange({ value: e.target.value })}
      aria-label="Value"
    />
  )
}

function HierPicker({
  kind,
  selected,
  onChange,
}: {
  kind: 'tags' | 'folders'
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const tags = useTags()
  const folders = useFolders()
  const items = useMemo(
    () => (kind === 'tags' ? tags.data : folders.data) ?? [],
    [kind, tags.data, folders.data],
  )
  const { open, setOpen, ref } = usePopover()
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const rows = flattenHierarchy(items)

  const toggle = (id: string) => {
    const set = new Set(selected)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    onChange([...set])
  }

  return (
    <span className="picker filter-row__picker" ref={ref}>
      <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {selected.length === 0
          ? `Choose ${kind}…`
          : selected
              .map((id) => byId.get(id)?.name)
              .filter(Boolean)
              .join(', ')}
      </button>
      {open && (
        <div className="picker__panel">
          {rows.length === 0 && <div className="pick-group">No {kind}</div>}
          {rows.map(({ item, depth }) => (
            <div
              key={item.id}
              className={`pick-row${selected.includes(item.id) ? ' pick-row--on' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => toggle(item.id)}
              role="option"
              aria-selected={selected.includes(item.id)}
            >
              <span className="pick-row__check">{selected.includes(item.id) ? '✓' : ''}</span>
              <span>{item.name}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
