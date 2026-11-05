// The toolbar carries the selection count so a first click does not push the listing down.
// Select All takes only loaded rows; while more pages remain, the tooltip says how many.
export function SelectionCount({
  total,
  selected,
  loaded,
  more,
  noun,
}: {
  total: number
  selected: number
  loaded: number
  more: boolean
  noun: string
}) {
  const note = more ? `Select All selects the ${loaded.toLocaleString()} loaded ${noun}` : undefined
  return (
    <span className="toolbar__count" title={selected > 1 ? note : undefined}>
      {total.toLocaleString()} items
      {/* Only the selection is live, so a refreshed total is not announced */}
      <span role="status">
        {selected > 1 && ` · ${selected.toLocaleString()} selected`}
        {selected > 1 && note && <span className="visually-hidden">. {note}</span>}
      </span>
    </span>
  )
}
