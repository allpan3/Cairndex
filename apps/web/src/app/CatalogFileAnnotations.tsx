import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import {
  FileAnnotationConflictError,
  invalidateFileAnnotations,
  useFileStar,
  useFileTagChoices,
  useSetFileTag,
  useToggleFileStar,
  type FileTagChoice,
} from '../api/catalogFiles'
import { rename } from '../api/catalogOrganize'
import { CatalogQueryContext } from '../api/catalogQuery'
import { captureRequestScope } from '../api/requestScope'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { CatalogChipPicker, type ChipChoice } from './CatalogChipPicker'
import { TargetContextMenu } from './ContextMenu'
import { InspectorSection } from './InspectorSection'
import { PromptDialog } from './PromptDialog'
import { TagPickerPanel } from './TagPickerPanel'
import { IconStar } from './icons'
import { useCatalogFileDraft } from './useCatalogFileDraft'
import { useContextMenu, type MenuEntry } from './useContextMenu'

/**
 * Compact header star button placed inline beside the filename in File Inspector.
 */
export function CatalogFileStarButton({
  library,
  file,
  blocked,
  fallbackStarred,
  onConflict,
  onErrorChange,
}: {
  library: string
  file: string
  blocked: boolean
  fallbackStarred?: boolean
  onConflict?: (unit: string | null) => void
  onErrorChange?: (error: Error | null) => void
}) {
  const starQuery = useFileStar(library, file, true)
  const toggleStar = useToggleFileStar(library)
  const starred =
    starQuery.data !== undefined ? Boolean(starQuery.data.starred) : Boolean(fallbackStarred)
  const starHeld = Boolean(starQuery.data?.held)
  const waitingWithoutFallback =
    fallbackStarred === undefined &&
    (starQuery.isPending || (starQuery.isStale && starQuery.isFetching))

  return (
    <button
      type="button"
      className={`tip inspector__star-btn${starred ? ' inspector__star-btn--on' : ''}`}
      data-tip={starred ? 'Unstar file' : 'Star file'}
      aria-label={starred ? 'Unstar file' : 'Star file'}
      aria-pressed={starred}
      disabled={blocked || starHeld || waitingWithoutFallback}
      onClick={() => {
        onConflict?.(null)
        onErrorChange?.(null)
        toggleStar.mutate(
          {
            ids: [file],
            starred: !starred,
            observed: starQuery.isFetching ? undefined : starQuery.data?.observed,
          },
          {
            onError: (reason) => {
              const err = reason as Error
              onErrorChange?.(err)
              if (reason instanceof FileAnnotationConflictError) onConflict?.(reason.unit)
            },
          },
        )
      }}
    >
      <IconStar filled={starred} />
    </button>
  )
}

/**
 * Portable per-file annotations shown inside File Inspector across all surfaces:
 * boolean Star, File Tags (with one-way propagation to confirmed bundles on add),
 * optional File Moments, and causal File Note + Source fields.
 */
export function CatalogFileAnnotations({
  library,
  file,
  editor,
  blocked,
  showStarButton = true,
  externalStarConflict = null,
  externalStarError = null,
  moments,
  onReview,
  onReviewConflict,
  onFilterTag,
}: {
  library: string
  file: string
  editor: string
  blocked: boolean
  /** False when the parent FileInspector already renders `CatalogFileStarButton` in its title row. */
  showStarButton?: boolean
  externalStarConflict?: string | null
  externalStarError?: Error | null
  moments?: ReactNode
  onReview?: () => void
  onReviewConflict?: (unit: string) => void
  onFilterTag?: (id: string) => void
}) {
  const client = useQueryClient()
  const status = useReplicaStatus(library).data
  const tree = (status?.selection_version ?? 0) >= 2
  const starQuery = useFileStar(library, file, true)
  const [starConflict, setStarConflict] = useState<string | null>(null)
  const [starActionError, setStarActionError] = useState<Error | null>(null)
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState(false)
  const [renaming, setRenaming] = useState<ChipChoice | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [tagError, setTagError] = useState('')
  const [tagConflict, setTagConflict] = useState<string | null>(null)
  const [menuChip, setMenuChip] = useState<string | null>(null)
  const menu = useContextMenu()

  const assignedQuery = useFileTagChoices(library, file, '', true, true)
  const foundQuery = useFileTagChoices(library, file, search.trim(), false, picking && !tree)
  const setFileTag = useSetFileTag(library)
  const detailQuery = useQuery({
    queryKey: ['catalog-detail', library, 'asset_files', file],
    queryFn: () => catalog<Entity>(library, `/entities/asset_files/${file}`),
    refetchInterval: 2000,
  })

  const starred = Boolean(starQuery.data?.starred)
  const starHeld = Boolean(starQuery.data?.held)
  const reviewUnit = (unit: string) => {
    if (onReviewConflict) onReviewConflict(unit)
    else onReview?.()
  }

  const toChoice = (item: FileTagChoice): ChipChoice => ({
    id: item.id,
    name: item.name,
    path: item.path,
    state: item.assigned ? 'on' : 'off',
    held: item.held,
  })
  const assignedItems = assignedQuery.data?.items ?? []
  const foundItems = foundQuery.data?.items ?? []
  const chips = assignedItems.map(toChoice)
  const choices = foundItems.map(toChoice)
  const heldTag = assignedItems.find((item) => item.held) ?? null
  const heldTagUnit = heldTag ? `asset_file_tags/${file}~${heldTag.id}/$alive` : null
  const activeTagConflictUnit = tagConflict ?? heldTagUnit

  function handleToggleChoice(choice: ChipChoice, assign: boolean) {
    const read = [...assignedItems, ...foundItems].find((item) => item.id === choice.id)
    if (!read) {
      handlePickTarget(choice.id, assign)
      return
    }
    setTagError('')
    setTagConflict(null)
    setFileTag.mutate(
      { fileId: file, choice: read, assigned: assign },
      {
        onError: (reason) => {
          if (reason instanceof FileAnnotationConflictError) setTagConflict(reason.unit)
          setTagError((reason as Error).message)
        },
      },
    )
  }

  function handlePickTarget(target: string, assign: boolean) {
    setTagError('')
    setTagConflict(null)
    setFileTag.mutate(
      { fileId: file, target, assigned: assign },
      {
        onError: (reason) => {
          if (reason instanceof FileAnnotationConflictError) setTagConflict(reason.unit)
          setTagError((reason as Error).message)
        },
      },
    )
  }

  function tagEntries(chip: ChipChoice): MenuEntry[] {
    return [
      {
        label: `Filter Items with “${chip.name}”`,
        disabled: !onFilterTag,
        onClick: () => onFilterTag?.(chip.id),
      },
      null,
      {
        label: 'Rename Tag…',
        disabled: blocked || setFileTag.isPending || renameBusy || chip.held,
        onClick: () => setRenaming(chip),
      },
      null,
      {
        label: 'Remove from This File',
        disabled: blocked || setFileTag.isPending,
        onClick: () => handleToggleChoice(chip, false),
      },
    ]
  }

  const activeStarConflict = externalStarConflict ?? starConflict
  const activeStarError = externalStarError ?? starActionError ?? starQuery.error
  const starConflictUnit = starHeld
    ? `asset_file_stars/${file}/$alive`
    : (activeStarConflict ??
      (activeStarError instanceof FileAnnotationConflictError ? activeStarError.unit : null))

  return (
    <div className={`file-annotations${starred ? ' file-annotations--starred' : ''}`}>
      {showStarButton && (
        <div className="file-annotations__inline-star">
          <CatalogFileStarButton
            library={library}
            file={file}
            blocked={blocked}
            onConflict={setStarConflict}
            onErrorChange={setStarActionError}
          />
        </div>
      )}
      {(starHeld || activeStarError) && (
        <p className="catalog-inspector-conflict" role="alert">
          <span>
            {starHeld
              ? 'This file star has conflicting edits.'
              : (activeStarError?.message ?? 'File star is unavailable.')}
          </span>{' '}
          {starConflictUnit && (onReviewConflict || onReview) && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => reviewUnit(starConflictUnit)}
            >
              Review Conflict
            </button>
          )}
        </p>
      )}

      <InspectorSection id="file-tags" title="Tags">
        <CatalogQueryContext value={library}>
          <CatalogChipPicker
            family="tags"
            chips={chips}
            choices={choices}
            search={search}
            onSearch={setSearch}
            onOpenChange={setPicking}
            loading={foundQuery.isPending}
            disabled={blocked || setFileTag.isPending}
            onToggle={handleToggleChoice}
            onReview={() => reviewUnit(activeTagConflictUnit ?? `asset_file_tags/${file}`)}
            panel={
              tree ? (
                <TagPickerPanel
                  assigned={new Set(chips.map((chip) => chip.id))}
                  disabled={blocked || setFileTag.isPending}
                  onToggle={handlePickTarget}
                  onCreated={(created) => handlePickTarget(created.id, true)}
                />
              ) : undefined
            }
            onTagMenu={(chip, event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMenuChip(chip.id)
              menu.open(
                event,
                tagEntries(chip),
                event.clientX || event.clientY ? undefined : { x: rect.left, y: rect.bottom },
              )
            }}
          />
        </CatalogQueryContext>
        <TargetContextMenu
          state={menu.state}
          target={menu.state ? chips.find((chip) => chip.id === menuChip) : undefined}
          entries={tagEntries}
          onClose={menu.close}
        />
        {renaming && (
          <PromptDialog
            title="Rename Tag"
            label="Tag name"
            initial={renaming.name}
            pending={renameBusy}
            error={renameError || null}
            onCancel={() => {
              setRenaming(null)
              setRenameError('')
            }}
            onConfirm={(name) => {
              const current = captureRequestScope()
              setRenameBusy(true)
              setRenameError('')
              void rename(library, 'tags', renaming.id, name)
                .then(async () => {
                  current()
                  setRenaming(null)
                  await invalidateFileAnnotations(client, library)
                })
                .catch((reason: Error) => {
                  try {
                    current()
                    setRenameError(reason.message)
                  } catch {
                    /* The prior library owns this reply. */
                  }
                })
                .finally(() => setRenameBusy(false))
            }}
          />
        )}
        {assignedQuery.data?.next_cursor && (
          <p className="catalog-chips-more">More tags than shown.</p>
        )}
        {(tagError || assignedQuery.error || heldTag) && (
          <p className="catalog-inspector-conflict" role="alert">
            <span>
              {tagError ||
                (heldTag
                  ? `Tag “${heldTag.name}” has conflicting edits.`
                  : 'File tags are unavailable.')}
            </span>{' '}
            {activeTagConflictUnit && (onReviewConflict || onReview) && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => reviewUnit(activeTagConflictUnit)}
              >
                Review Conflict
              </button>
            )}
          </p>
        )}
      </InspectorSection>

      {moments}

      {detailQuery.error && <p role="alert">File metadata is unavailable.</p>}
      {detailQuery.data && detailQuery.data.fields.$alive?.value === 'true' && (
        <InspectorSection id="file-notes" title="Note">
          <CatalogFileFields
            key={`${library}/${file}/${editor}`}
            library={library}
            entity={detailQuery.data}
            editor={editor}
            blocked={blocked}
            onReview={onReview}
            onReviewConflict={onReviewConflict}
            refresh={() => {
              void detailQuery.refetch()
              void invalidateFileAnnotations(client, library)
            }}
          />
        </InspectorSection>
      )}
    </div>
  )
}

function CatalogFileFields({
  library,
  entity,
  editor,
  blocked,
  refresh,
  onReview,
  onReviewConflict,
}: {
  library: string
  entity: Entity
  editor: string
  blocked: boolean
  refresh: () => void
  onReview?: () => void
  onReviewConflict?: (unit: string) => void
}) {
  const draft = useCatalogFileDraft(library, entity, editor, refresh, blocked)
  const noteHeld = Boolean(entity.fields.note?.held)
  const sourceHeld = Boolean(entity.fields.source?.held)
  const aliveHeld = Boolean(entity.fields.$alive?.held)
  const hasConflict = Boolean(entity.has_conflicts || noteHeld || sourceHeld || aliveHeld)
  const conflictUnit = entity.fields.note?.held
    ? entity.fields.note.unit
    : entity.fields.source?.held
      ? entity.fields.source.unit
      : (entity.fields.$alive?.unit ?? `asset_files/${entity.id}/note`)

  const note = (JSON.parse(draft.read('note')) as string | null) ?? ''
  const source = (JSON.parse(draft.read('source')) as string | null) ?? ''

  return (
    <div className="file-annotations__fields">
      {hasConflict && (
        <p className="catalog-inspector-conflict" role="alert">
          <span>This file has conflicting edits.</span>{' '}
          {(onReviewConflict || onReview) && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => (onReviewConflict ? onReviewConflict(conflictUnit) : onReview?.())}
            >
              Review Conflicts
            </button>
          )}
        </p>
      )}
      {draft.error && (
        <p role="alert">
          Changes could not be saved. {draft.error}
          {draft.draft.pending && ' Retrying automatically.'}
        </p>
      )}
      <span className="field-label">Note</span>
      <textarea
        className="edit edit--note"
        aria-label="File note"
        placeholder="Add a file note…"
        value={note}
        disabled={blocked || noteHeld || aliveHeld}
        onChange={(event) => draft.change('note', JSON.stringify(event.target.value || null))}
        onBlur={() => void draft.save()}
      />
      <span className="field-label">Source</span>
      <input
        type="text"
        className="edit"
        aria-label="File source"
        placeholder="https://…"
        value={source}
        disabled={blocked || sourceHeld || aliveHeld}
        onChange={(event) => draft.change('source', JSON.stringify(event.target.value || null))}
        onBlur={() => void draft.save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void draft.save()
        }}
      />
      {draft.message && (
        <p className="catalog-inspector-save" role="status">
          {draft.message}
        </p>
      )}
    </div>
  )
}
