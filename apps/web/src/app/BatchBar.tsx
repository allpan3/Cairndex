import { useState } from 'react'

import { useBatchUpdate, useFolderCounts, useFolders, useTagCounts, useTags } from '../api/hooks'
import { flattenHierarchy, usePopover } from './usePopover'

interface AddPickerProps {
  label: string
  rows: { item: { id: string; name: string }; depth: number }[]
  counts: Record<string, number>
  onPick: (id: string) => void
}

function AddPicker({ label, rows, counts, onPick }: AddPickerProps) {
  const { open, setOpen, ref } = usePopover()
  const [search, setSearch] = useState('')
  const visible = rows.filter(
    ({ item }) => !search || item.name.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <div className="picker" ref={ref}>
      <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="picker__panel">
          <input
            className="edit picker__search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            aria-label={label}
          />
          {visible.length === 0 && <div className="pick-group">No matches</div>}
          {visible.map(({ item, depth }) => (
            <div
              key={item.id}
              className="pick-row"
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => {
                onPick(item.id)
                setOpen(false)
              }}
            >
              <span>{item.name}</span>
              <span className="pick-row__count">{counts[item.id] ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function BatchBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const batch = useBatchUpdate()
  const { data: tags = [] } = useTags()
  const { data: tagCounts = {} } = useTagCounts()
  const { data: folders = [] } = useFolders()
  const { data: folderCounts = {} } = useFolderCounts()

  return (
    <div className="batchbar">
      <span className="batchbar__count">{ids.length} selected</span>
      <AddPicker
        label="+ Tag"
        rows={flattenHierarchy(tags)}
        counts={tagCounts}
        onPick={(tagId) => batch.mutate({ bundle_ids: ids, add_tag_ids: [tagId] })}
      />
      <AddPicker
        label="+ Folder"
        rows={flattenHierarchy(folders)}
        counts={folderCounts}
        onPick={(folderId) => batch.mutate({ bundle_ids: ids, add_folder_ids: [folderId] })}
      />
      <span className="toolbar__spacer" />
      <button className="add-btn" onClick={onClear}>
        Clear
      </button>
    </div>
  )
}
