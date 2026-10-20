import { useEffect, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { usePopover } from './usePopover'

/** One destination in the picker; `some` marks one only part of a selection has. */
export interface ChipChoice {
  id: string
  name: string
  /** The names from the top level down to this one. */
  path: string[]
  state: 'on' | 'some' | 'off'
  held: boolean
}

const NOUN = { tags: 'tag', collections: 'collection' } as const

/**
 * v0.2.1's tag and collection editor: the assigned ones as chips with ×, and a
 * "+ Tag" picker that searches the whole catalog. Every click saves at once;
 * a choice that waits for conflict review opens Metadata review instead.
 */
export function CatalogChipPicker({
  family,
  chips,
  choices,
  search,
  onSearch,
  onOpenChange,
  onMore,
  loading,
  disabled,
  onToggle,
  onReview,
  onOpenChip,
  onTagMenu,
}: {
  family: 'tags' | 'collections'
  chips: ChipChoice[]
  /** The picker's search results; the caller queries them while it is open. */
  choices: ChipChoice[]
  search: string
  onSearch: (search: string) => void
  /** The picker opened or closed, so the caller can search only while it is open. */
  onOpenChange: (open: boolean) => void
  onMore?: () => void
  loading: boolean
  disabled: boolean
  onToggle: (choice: ChipChoice, assign: boolean) => void
  onReview: () => void
  /** Collections open from their chip. */
  onOpenChip?: (id: string) => void
  onTagMenu?: (chip: ChipChoice, event: MouseEvent) => void
}) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  useEffect(() => onOpenChange(open), [open, onOpenChange])
  const noun = NOUN[family]
  const pick = (choice: ChipChoice) => {
    if (choice.held) onReview()
    else if (!disabled) onToggle(choice, choice.state !== 'on')
  }
  const sorted = [...choices].sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')))
  return (
    <div className="chips">
      {chips.map((chip) => (
        <span
          key={chip.id}
          onContextMenu={onTagMenu ? (event) => onTagMenu(chip, event) : undefined}
          className={`chip${onOpenChip ? ' chip--collection' : ''}${
            chip.state === 'some' ? ' chip--partial' : ''
          }`}
          title={chip.state === 'some' ? `Only some selected bundles have ${chip.name}` : undefined}
        >
          {onOpenChip ? (
            <button
              className="chip__open"
              onClick={() => onOpenChip(chip.id)}
              aria-label={`Open collection ${chip.name}`}
            >
              {chip.name}
            </button>
          ) : onTagMenu ? (
            <button
              className="chip__open"
              aria-label={`Tag actions ${chip.name}`}
              onClick={(event) => onTagMenu(chip, event)}
            >
              {chip.name}
            </button>
          ) : (
            chip.name
          )}
          <button
            className="chip__remove"
            disabled={disabled}
            onClick={() => (chip.held ? onReview() : onToggle(chip, false))}
            aria-label={`Remove ${chip.name}`}
          >
            ×
          </button>
        </span>
      ))}
      <div className="picker" ref={ref}>
        <button
          className="add-btn"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          + {family === 'tags' ? 'Tag' : 'Collection'}
        </button>
        {open &&
          pos &&
          createPortal(
            <div
              className="picker__panel"
              ref={panelRef}
              role="dialog"
              aria-label={`Choose ${family}`}
              style={{
                top: pos.top,
                bottom: pos.bottom,
                right: pos.right,
                maxHeight: pos.maxHeight,
              }}
            >
              <div className="picker__head">
                <input
                  className="edit picker__search"
                  placeholder={`Search ${family}…`}
                  value={search}
                  onChange={(event) => onSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    const exact = sorted.find(
                      (choice) => choice.name.toLowerCase() === search.trim().toLowerCase(),
                    )
                    if (exact && exact.state !== 'on') pick(exact)
                  }}
                  autoFocus
                  aria-label={`Search ${family}`}
                />
              </div>
              {!loading && sorted.length === 0 && (
                <div className="pick-group">No matching {family}</div>
              )}
              {/* Toggle buttons rather than listbox options: each row acts at
                  once, and Tab reaches every one without a roving focus */}
              {sorted.map((choice) => (
                <button
                  key={choice.id}
                  className={`pick-row${choice.state === 'on' ? ' pick-row--on' : ''}`}
                  aria-pressed={
                    choice.state === 'on' ? true : choice.state === 'some' ? 'mixed' : false
                  }
                  disabled={disabled && !choice.held}
                  title={choice.held ? `This ${noun} needs metadata review first.` : undefined}
                  onClick={() => pick(choice)}
                >
                  <span
                    className={`pick-row__box${choice.state === 'on' ? ' pick-row__box--on' : ''}`}
                    aria-hidden="true"
                  >
                    {choice.state === 'on' ? '✓' : choice.state === 'some' ? '–' : ''}
                  </span>
                  <span className="pick-row__name">{choice.name}</span>
                  {choice.path.length > 1 && (
                    <span className="pick-row__parent">{choice.path.at(-2)}</span>
                  )}
                </button>
              ))}
              {onMore && (
                <button className="pick-row pick-row--more" onClick={onMore}>
                  More {family}…
                </button>
              )}
            </div>,
            document.body,
          )}
      </div>
    </div>
  )
}
