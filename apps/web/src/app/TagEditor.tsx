import { basisOf, rememberBasis } from '../api/editBasis'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { TagRead } from '../api/client'
import { useBundleTags, useSetBundleTags, useTagMutations, useTags } from '../api/hooks'
import { ContextMenu } from './ContextMenu'
import { PromptDialog } from './PromptDialog'
import { getCopiedTags, setCopiedTags } from './tagClipboard'
import { TagPickerPanel } from './TagPickerPanel'
import { useContextMenu } from './useContextMenu'
import { usePopover } from './usePopover'

/**
 * Everything a tag picker needs to know about *what* it is tagging.
 *
 * The picker itself is the expensive part — search with pinyin, group filters, a
 * foldable hierarchy, the shown Enter target, create-with-`/`, copy/paste — and
 * a moment needs every bit of it (plan 7 §4.4). So the owner of the tags is
 * a parameter rather than a hard-wired bundle, and there is one panel
 * (`TagPickerPanel`) rather than a second copy that diverges by the second week.
 */
export interface TagAssignment {
  /** Tag ids currently assigned; undefined while still unknown. */
  assigned: string[] | undefined
  /** Replace the whole assigned set. */
  onSetTags: (ids: string[]) => void
  /** What the pill's removal entry says, e.g. "Remove from This Bundle". */
  removeLabel: string
}

/** The bundle-bound picker: the inspector's TAGS section. */
export function TagEditor({
  bundleId,
  onFilterByTags,
}: {
  bundleId: string
  /** Filter the library by these tags; undefined greys the menu row out. */
  onFilterByTags?: (tagIds: string[]) => void
}) {
  const { data: bundleTags } = useBundleTags(bundleId)
  const setTags = useSetBundleTags(bundleId)
  return (
    <TagPicker
      addLabel="+ Tag"
      assignment={{
        assigned: bundleTags?.tag_ids,
        onSetTags: (ids) =>
          setTags.mutate(
            rememberBasis({ before: bundleTags?.tag_ids ?? [], ids }, basisOf(bundleTags)),
          ),
        removeLabel: 'Remove from This Bundle',
      }}
      onFilterByTags={onFilterByTags}
    />
  )
}

export function TagPicker({
  assignment,
  label,
  addLabel,
  addAriaLabel,
  maxChips,
  onFilterByTags,
}: {
  assignment: TagAssignment
  /** Field label above the chips; omitted where a heading already says it. */
  label?: string
  /** Text on the button that opens the picker. */
  addLabel: string
  /**
   * What that button is *called*, when its text is a symbol rather than words.
   * Left unset where `addLabel` already reads as a name — overriding a perfectly
   * good visible label with an invisible one only hides it from anything that
   * matches on what the owner can see.
   */
  addAriaLabel?: string
  /**
   * How many pills to draw before collapsing the rest into a `+N` (owner,
   * 2026-08-30).
   *
   * For a one-line row, clipping the tail of a pill against the edge of its
   * region reads as a rendering fault rather than as "there is more". A whole
   * first tag and an honest count does not. Unset means draw them all, which is
   * what a section with room for them wants.
   */
  maxChips?: number
  /** Filter the library by these tags; undefined greys the menu row out. */
  onFilterByTags?: (tagIds: string[]) => void
}) {
  const { assigned: assignedIds, onSetTags, removeLabel } = assignment
  const { data: tags = [] } = useTags()
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const menu = useContextMenu()
  const { rename } = useTagMutations()
  // The tag being renamed. A rendered dialog, because `window.prompt` returns
  // null in the desktop webview — which is why renaming "did not work" there
  // while it worked in the browser (owner, 2026-07-27).
  const [renaming, setRenaming] = useState<TagRead | null>(null)
  // Mirrored into state so the Paste row enables the moment something is
  // copied; the clipboard itself outlives this component.
  const [clipboard, setClipboard] = useState<string[]>(getCopiedTags)
  const assigned = new Set(assignedIds ?? [])
  const byId = new Map(tags.map((t) => [t.id, t]))

  const assignedTags = () => [...assigned].map((id) => byId.get(id)).filter((t) => t !== undefined)

  // What the chips row draws, and what a `+N` stands in for behind it.
  const allAssigned = assignedTags()
  const shownTags = maxChips === undefined ? allAssigned : allAssigned.slice(0, maxChips)
  const hiddenTags = allAssigned.slice(shownTags.length)
  const hiddenCount = hiddenTags.length
  const hiddenNames = hiddenTags.map((t) => t.name).join(', ')

  const commitRename = (next: string) => {
    const tag = renaming
    setRenaming(null)
    if (!tag || next === tag.name) return
    rename.mutate({ id: tag.id, name: next, version: tag.version })
  }

  const pasteTags = () => {
    // Union, not replace: pasting adds what was copied and keeps what is here.
    const next = new Set([...assigned, ...clipboard])
    onSetTags([...next])
  }

  const copyTags = (ids: string[]) => {
    setCopiedTags(ids)
    setClipboard(ids)
  }

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSetTags([...next])
  }

  return (
    <>
      {label !== undefined && <label className="field-label">{label}</label>}
      <ContextMenu state={menu.state} onClose={menu.close} />
      {renaming && (
        <PromptDialog
          title="Rename Tag"
          label="Tag name"
          initial={renaming.name}
          onCancel={() => setRenaming(null)}
          onConfirm={commitRename}
        />
      )}
      <div className="chips">
        {shownTags.map((t) => (
          <span
            className="chip"
            key={t.id}
            // The actions the owner expects on a tag pill (2026-07-27).
            // "Filter" is the one that needs the shell — the rest act here.
            onContextMenu={(event) => {
              const chosen = assignedTags()
              menu.open(event, [
                {
                  // The clicked tag only. There is no way to select several
                  // pills, so filtering by every tag on the owner described
                  // the owner rather than anything worth browsing (owner,
                  // 2026-07-27).
                  label: `Filter Items with “${t.name}”`,
                  disabled: !onFilterByTags,
                  onClick: () => onFilterByTags?.([t.id]),
                },
                null,
                { label: 'Rename Tag…', onClick: () => setRenaming(t) },
                { label: 'Copy Tags', onClick: () => copyTags(chosen.map((tag) => tag.id)) },
                {
                  label: 'Paste Tags',
                  disabled: clipboard.length === 0,
                  onClick: () => pasteTags(),
                },
                null,
                {
                  label: removeLabel,
                  onClick: () => toggle(t.id),
                },
              ])
            }}
          >
            {t.name}
            <button onClick={() => toggle(t.id)} aria-label={`Remove ${t.name}`}>
              ×
            </button>
          </span>
        ))}
        {hiddenCount > 0 && (
          // Not a pill of its own business: pressing it opens the picker, which
          // is where the tags it stands for can be read and changed.
          <button
            className="chip chip--more"
            onClick={() => setOpen((o) => !o)}
            title={hiddenNames}
            aria-label={`${hiddenCount} more ${hiddenCount === 1 ? 'tag' : 'tags'}: ${hiddenNames}`}
          >
            +{hiddenCount}
          </button>
        )}
        <div className="picker" ref={ref}>
          <button
            className="add-btn"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={addAriaLabel}
            title="Add a tag"
          >
            {addLabel}
          </button>
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
                <TagPickerPanel
                  assigned={assigned}
                  onToggle={(id) => toggle(id)}
                  onCreated={(created) => onSetTags([...assigned, created.id])}
                />
              </div>,
              document.body,
            )}
        </div>
      </div>
    </>
  )
}
