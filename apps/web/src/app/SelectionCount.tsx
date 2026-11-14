import type { SelectAllProgress } from '../api/catalogSelectAll'

// The toolbar carries the selection count so a first click does not push the listing down.
// A server before `selection_version: 6` takes only loaded rows in Select All; while more
// pages remain there, the tooltip says how many.
export function SelectionCount({
  total,
  selected,
  loaded,
  more,
  everything = false,
  selecting = null,
  noun,
}: {
  total: number
  selected: number
  loaded: number
  more: boolean
  /** Select All takes every matching item, loaded or not. */
  everything?: boolean
  /** Select All is reading the matching items. */
  selecting?: SelectAllProgress | null
  noun: string
}) {
  const note =
    more && !everything
      ? `Select All selects the ${loaded.toLocaleString()} loaded ${noun}`
      : undefined
  return (
    <span className="toolbar__count" title={selected > 1 ? note : undefined}>
      {total.toLocaleString()} items
      {/* Only the selection is live, so a refreshed total is not announced */}
      <span role="status">
        {selecting
          ? ` · Selecting ${selecting.done.toLocaleString()} of ${selecting.total.toLocaleString()}…`
          : selected > 1 && ` · ${selected.toLocaleString()} selected`}
        {!selecting && selected > 1 && note && <span className="visually-hidden">. {note}</span>}
      </span>
    </span>
  )
}
