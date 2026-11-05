import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { Moment } from '../api/client'
import { useMomentTagChoices, useSetMomentTag, type MomentTagChoice } from '../api/catalogMoments'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { CatalogQueryContext } from '../api/catalogQuery'
import { TagPickerPanel } from './TagPickerPanel'
import { usePopover } from './usePopover'

/**
 * A portable moment's tags: the first tag in full, a count for the rest, and a
 * shared hierarchical chooser. Older servers keep their paged tag search until
 * they support reading the bases of a single tree choice (moments version 5).
 *
 * Each choice is saved at once, like the other moment gestures in the viewer.
 * An added tag is also added to the bundle (ADR-0025); a removed one stays there.
 */
export function CatalogMomentTags({
  library,
  moment,
  names,
}: {
  library: string
  moment: Moment
  /** Names of the tags on the bundle's moments, from the moment list. */
  names: Record<string, string>
}) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  // Reopening the chooser starts from a clean search
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setSearch('')
  }
  const query = search.trim()
  const tree = (useReplicaStatus(library).data?.moments_version ?? 0) >= 5
  const assigned = useMomentTagChoices(library, moment.id, '', true, open && !tree)
  const found = useMomentTagChoices(library, moment.id, query, false, open && !tree)
  const setTag = useSetMomentTag(library, moment.bundle_id)
  const labels = (moment.tag_ids ?? []).map((id) => names[id] ?? 'Tag')
  const [first, ...rest] = labels

  const row = (choice: MomentTagChoice) => (
    <div
      key={choice.id}
      className={`pick-row${choice.assigned ? ' pick-row--on' : ''}`}
      role="option"
      aria-selected={choice.assigned}
      aria-disabled={choice.held || setTag.isPending}
      title={choice.held ? 'This tag needs conflict review in the bundle inspector' : undefined}
      onClick={() => {
        if (choice.held || setTag.isPending) return
        setTag.mutate({ momentId: moment.id, choice })
      }}
    >
      <span className={`pick-row__box${choice.assigned ? ' pick-row__box--on' : ''}`}>
        {choice.assigned ? '✓' : ''}
      </span>
      <span className="pick-row__name">{choice.path.join('/')}</span>
    </div>
  )
  const others = (found.data?.items ?? []).filter((choice) => !choice.assigned)

  return (
    <div className="chips">
      {first !== undefined && <span className="chip">{first}</span>}
      {rest.length > 0 && (
        <button
          className="chip chip--more"
          onClick={() => setOpen((value) => !value)}
          title={rest.join(', ')}
          aria-label={`${rest.length} more ${rest.length === 1 ? 'tag' : 'tags'}: ${rest.join(', ')}`}
        >
          +{rest.length}
        </button>
      )}
      <div className="picker" ref={ref}>
        <button
          className="add-btn"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label="Add tag"
          title="Add a tag"
        >
          +
        </button>
        {open &&
          pos &&
          createPortal(
            <div
              className="picker__panel"
              ref={panelRef}
              role={tree ? 'dialog' : 'listbox'}
              aria-label="Moment tags"
              style={{
                top: pos.top,
                bottom: pos.bottom,
                right: pos.right,
                maxHeight: pos.maxHeight,
              }}
            >
              {tree ? (
                <CatalogQueryContext value={library}>
                  <TagPickerPanel
                    assigned={new Set(moment.tag_ids)}
                    disabled={setTag.isPending}
                    onToggle={(target, assign) =>
                      setTag.mutate({ momentId: moment.id, target, assigned: assign })
                    }
                    onCreated={(tag) =>
                      setTag.mutate({ momentId: moment.id, target: tag.id, assigned: true })
                    }
                  />
                </CatalogQueryContext>
              ) : (
                <>
                  <input
                    className="edit picker__search"
                    placeholder="Search tags…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    autoFocus
                    aria-label="Search tags"
                  />
                  {(assigned.data?.items.length ?? 0) > 0 && (
                    <>
                      <div className="pick-group">Selected</div>
                      {assigned.data?.items.map(row)}
                    </>
                  )}
                  {found.data && others.length === 0 && (
                    <div className="pick-group">No matching tags</div>
                  )}
                  {others.map(row)}
                  {found.data?.next_cursor && (
                    <div className="pick-group">Type to find more tags</div>
                  )}
                </>
              )}
              {(assigned.error || found.error || setTag.error) && (
                <p role="alert" className="pick-group">
                  {(setTag.error ?? assigned.error ?? found.error)?.message}
                </p>
              )}
            </div>,
            document.body,
          )}
      </div>
    </div>
  )
}
