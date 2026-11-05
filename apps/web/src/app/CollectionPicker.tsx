import { basisOf, rememberBasis } from '../api/editBasis'
import { createPortal } from 'react-dom'

import { useBundleCollections, useCollections, useSetBundleCollections } from '../api/hooks'
import { useBundleInspectorActions } from './bundleInspectorActions'
import { CollectionPickerPanel } from './CollectionPickerPanel'
import { usePopover } from './usePopover'

export function CollectionPicker({ bundleId }: { bundleId: string }) {
  const { onOpenCollection } = useBundleInspectorActions()
  const { data: bundleCollections } = useBundleCollections(bundleId)
  const { data: collections = [] } = useCollections()
  const setCollections = useSetBundleCollections(bundleId)
  const { open, setOpen, ref, panelRef, pos } = usePopover()

  const assigned = new Set(bundleCollections?.collection_ids ?? [])
  const byId = new Map(collections.map((c) => [c.id, c]))

  const save = (ids: string[]) =>
    setCollections.mutate(rememberBasis({ before: [...assigned], ids }, basisOf(bundleCollections)))
  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save([...next])
  }

  return (
    <>
      <div className="chips">
        {[...assigned]
          .map((id) => byId.get(id))
          .filter((c) => c !== undefined)
          .map((c) => (
            <span className="chip" key={c.id}>
              <button
                className="chip__open"
                onClick={() => onOpenCollection?.(c.id)}
                disabled={!onOpenCollection}
                aria-label={`Open collection ${c.name}`}
                title={`Open ${c.name}`}
              >
                {c.name}
              </button>
              <button
                className="chip__remove"
                onClick={() => toggle(c.id)}
                aria-label={`Remove from ${c.name}`}
              >
                ×
              </button>
            </span>
          ))}
        <div className="picker" ref={ref}>
          <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            + Collection
          </button>
          {/* Mounted only while open: the panel walks and sorts every collection, and
              the viewer docks this inspector beside a playing video (2026-07-27) */}
          {open &&
            pos &&
            createPortal(
              <div
                className="picker__panel"
                ref={panelRef}
                style={{
                  top: pos.top,
                  bottom: pos.bottom,
                  right: pos.right,
                  maxHeight: pos.maxHeight,
                }}
              >
                <CollectionPickerPanel
                  assigned={assigned}
                  onToggle={(id) => toggle(id)}
                  onCreated={(created) => save([...assigned, created.id])}
                />
              </div>,
              document.body,
            )}
        </div>
      </div>
    </>
  )
}
