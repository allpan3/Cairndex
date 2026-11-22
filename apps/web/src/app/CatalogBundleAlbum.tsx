import { NameEditor } from './FileWriteDialogs'
import { leaf, renameError } from './sourceActions'
import { ContextMenu } from './ContextMenu'
import { useContextMenu } from './useContextMenu'
import { hostFileMenuEntries } from './hostActions'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { CatalogQueryContext, catalogNavigation } from '../api/catalogQuery'
import { FileAnnotationConflictError, useToggleFileStar } from '../api/catalogFiles'
import type { TagRead } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { ContactSheetDialog } from './ContactSheetDialog'
import { useLocalContactSheet } from './useLocalContactSheet'
import type { components } from '../api/schema'
import { fileDragProps } from './dragOut'
import { AlbumItems } from './AlbumItems'
import { AlbumRow, AlbumTile } from './AlbumItem'
import { albumFileAspect } from './layout'
import type { BrowserNavigation } from './Browser'
import { IconStar, IconTag } from './icons'
import { selectionRange, type SelectionModifiers } from './selection'
import { rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import { flattenHierarchy, usePopover } from './usePopover'
import type { LayoutMode, LocatedFile } from './types'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { useCatalogHistory } from './useCatalogHistory'

type Page = components['schemas']['CatalogAlbumPage']
type Item = Page['items'][number]
type AlbumTagFilterItem = { id: string; name: string; parent_id: string | null }
type FileActions = {
  onLocateFile?: (path: string) => void
  onOpenDirectory?: (path: string) => void
  onRename?: (path: string, name: string) => void | Promise<void>
  onSourceAction?: (action: 'copy' | 'move' | 'trash', paths: string[]) => void
}

export function CatalogBundleAlbum(
  props: FileActions & {
    library: string
    bundle: string
    blocked?: boolean
    layout: LayoutMode
    zoom: number
    showCardDetails?: boolean
    onBack: () => void
    onOpen: (file: string) => void
    onSelectFile: (file: string | null) => void
    onReview?: () => void
    onReviewConflict?: (unit: string) => void
    hostFiles?: LibraryHostFiles
    /** A located file to select, at the top level or in the folder member holding it */
    initialFile?: LocatedFile | null
  },
) {
  const [directory, setDirectory] = useState<string | null>(null)
  // The folder opened first carries the located file; leaving it ends the search
  const [locating, setLocating] = useState(props.initialFile ?? null)
  const [starredOnly, setStarredOnly] = useState(false)
  const [selectedTags, setSelectedTags] = useState<AlbumTagFilterItem[]>([])
  const [tagMode, setTagMode] = useState<'any' | 'all'>('any')
  const status = useReplicaStatus(props.library).data
  const historyError = useCatalogHistory(
    props.library,
    props.bundle,
    (status?.browse_version ?? 0) >= 11,
  )
  const filterProps = {
    starredOnly,
    onStarredOnly: setStarredOnly,
    selectedTags,
    onSelectedTags: setSelectedTags,
    tagMode,
    onTagMode: setTagMode,
    onClearFilters: () => {
      setStarredOnly(false)
      setSelectedTags([])
    },
  }
  return (
    <div className="album">
      {historyError && <p role="alert">{historyError}</p>}
      <div hidden={directory !== null} className="catalog-album-page">
        <AlbumPage
          {...props}
          {...filterProps}
          activeView={directory === null}
          directory={null}
          onDirectory={setDirectory}
        />
      </div>
      {directory && (
        <AlbumPage
          {...props}
          {...filterProps}
          key={directory}
          directory={directory}
          onDirectory={setDirectory}
          initialFile={locating}
          onBack={() => {
            setDirectory(null)
            setLocating(null)
            props.onSelectFile(null)
          }}
        />
      )}
    </div>
  )
}

function AlbumPage({
  library,
  bundle,
  blocked = false,
  directory,
  onDirectory,
  layout,
  zoom,
  showCardDetails = true,
  onBack,
  onOpen,
  onSelectFile,
  onReview,
  onReviewConflict,
  activeView = true,
  hostFiles,
  initialFile = null,
  onLocateFile,
  onOpenDirectory,
  onRename,
  onSourceAction,
  starredOnly,
  onStarredOnly,
  selectedTags,
  onSelectedTags,
  tagMode,
  onTagMode,
  onClearFilters,
}: FileActions & {
  library: string
  bundle: string
  blocked?: boolean
  directory: string | null
  activeView?: boolean
  onDirectory: (id: string) => void
  layout: LayoutMode
  zoom: number
  showCardDetails?: boolean
  onBack: () => void
  onOpen: (id: string) => void
  onSelectFile: (id: string | null) => void
  onReview?: () => void
  onReviewConflict?: (unit: string) => void
  hostFiles?: LibraryHostFiles
  initialFile?: LocatedFile | null
  starredOnly: boolean
  onStarredOnly: (value: boolean) => void
  selectedTags: AlbumTagFilterItem[]
  onSelectedTags: (next: AlbumTagFilterItem[]) => void
  tagMode: 'any' | 'all'
  onTagMode: (mode: 'any' | 'all') => void
  onClearFilters: () => void
}) {
  const [generation, setGeneration] = useState(0)
  const replicaStatus = useReplicaStatus(library).data
  const albumFilterEnabled = (replicaStatus?.album_version ?? 0) >= 2
  const fileStarEnabled = (replicaStatus?.inspector_version ?? 0) >= 2
  const exportsEnabled = replicaStatus?.export_version === 1
  const tagIds = selectedTags.map((tag) => tag.id)
  const filterActive = albumFilterEnabled && (starredOnly || tagIds.length > 0)
  const tagKey = tagIds.join(',')
  const pages = useInfiniteQuery({
    queryKey: [
      'catalog-album',
      library,
      bundle,
      directory,
      generation,
      starredOnly,
      tagKey,
      tagMode,
    ],
    initialPageParam: { offset: 0, revision: '' },
    queryFn: ({ pageParam, signal }) => {
      const params = [
        `offset=${pageParam.offset}`,
        'limit=50',
        directory ? `directory_id=${encodeURIComponent(directory)}` : '',
        pageParam.revision ? `expected_revision=${pageParam.revision}` : '',
        filterActive && starredOnly ? 'starred_only=true' : '',
        filterActive && tagIds.length > 0
          ? [
              ...tagIds.map((tagId) => `tag_ids=${encodeURIComponent(tagId)}`),
              'include_descendants=true',
              `tag_mode=${tagMode}`,
            ].join('&')
          : '',
      ].filter(Boolean)
      return replicaRequest<Page>(
        library,
        `/media/bundles/${bundle}/album?${params.join('&')}`,
        'GET',
        undefined,
        signal,
      )
    },
    getNextPageParam: (page) =>
      page.next_offset === null ? undefined : { offset: page.next_offset, revision: page.revision },
    refetchInterval: activeView ? 2000 : false,
    retry: false,
  })
  const catalogLibrary = useContext(CatalogQueryContext)
  const allTagsQuery = useQuery({
    queryKey: ['catalog-navigation', library, 'tags'],
    queryFn: () => catalogNavigation<TagRead>(library, 'tags'),
    enabled: catalogLibrary !== null && albumFilterEnabled,
    refetchInterval: catalogLibrary !== null ? 2000 : false,
  })
  const items = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data])
  const first = pages.data?.pages[0]
  const availableTags = useMemo(() => {
    const libraryById = new Map((allTagsQuery.data ?? []).map((tag) => [tag.id, tag]))
    const selectedById = new Map(selectedTags.map((tag) => [tag.id, tag]))
    const kept = new Set<string>([
      ...Object.keys(first?.tag_names ?? {}),
      ...selectedTags.map((tag) => tag.id),
    ])
    // Surface ancestors of tags present in this bundle so parent tags ("Includes subtags") remain reachable
    for (const id of [...kept]) {
      let current = libraryById.get(id)?.parent_id ?? null
      const seen = new Set<string>([id])
      while (current && !seen.has(current)) {
        seen.add(current)
        kept.add(current)
        current = libraryById.get(current)?.parent_id ?? null
      }
    }
    return [...kept].map((id) => {
      const tag = libraryById.get(id)
      const fallbackName = first?.tag_names?.[id] ?? selectedById.get(id)?.name ?? id
      return {
        id,
        name: tag?.name ?? fallbackName,
        parent_id: tag?.parent_id ?? selectedById.get(id)?.parent_id ?? null,
      }
    })
  }, [allTagsQuery.data, first?.tag_names, selectedTags])
  const [selected, setSelected] = useState(new Set<string>())
  const [active, setActive] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const navigation = useRef<BrowserNavigation>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState('')
  const [starConflict, setStarConflict] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  if (!onRename && renaming) setRenaming(null)
  const menu = useContextMenu()
  const sheet = useLocalContactSheet(library, setNotice)
  const starFile = useToggleFileStar(library)
  function commitStars(fileIds: string[], starred: boolean) {
    setNotice('')
    setStarConflict(null)
    starFile.mutate(
      { ids: fileIds, starred },
      {
        onError: (reason) => {
          if (reason instanceof FileAnnotationConflictError) setStarConflict(reason.unit)
          setNotice((reason as Error).message)
        },
      },
    )
  }
  function select(id: string, modifiers: SelectionModifiers) {
    setSelected((previous) => {
      if (modifiers.shiftKey)
        return selectionRange(
          items.map((item) => item.id),
          anchor.current,
          id,
          modifiers.metaKey || modifiers.ctrlKey ? previous : undefined,
        )
      if (modifiers.metaKey || modifiers.ctrlKey) {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      return new Set([id])
    })
    if (!modifiers.shiftKey) anchor.current = id
    setActive(id)
  }
  // Locate selects its file once a page lists it, or opens the folder member
  // holding it; the search stops at the first answer, so later edits keep theirs
  const seeking = useRef(initialFile)
  useEffect(() => {
    const target = seeking.current
    if (!target || !pages.isSuccess) return
    const found = items.find((item) => item.file?.id === target.id)
    if (found) {
      seeking.current = null
      setSelected(new Set([found.id]))
      setActive(found.id)
      anchor.current = found.id
      requestAnimationFrame(() => navigation.current?.focus(found.id))
    } else if (pages.hasNextPage) {
      if (!pages.isFetchingNextPage) void pages.fetchNextPage()
    } else {
      seeking.current = null
      const folder = directory
        ? undefined
        : items.find(
            (item) => item.directory && target.path.startsWith(`${item.directory.directory_path}/`),
          )
      if (folder) onDirectory(folder.id)
    }
  }, [items, pages, directory, onDirectory])
  const sole = selected.size === 1 ? items.find((item) => selected.has(item.id)) : null
  useEffect(() => {
    if (activeView) onSelectFile(sole?.file?.id ?? null)
  }, [sole, onSelectFile, activeView])
  if (
    pages.isSuccess &&
    !pages.hasNextPage &&
    !pages.isFetching &&
    [...selected].some((id) => !items.some((item) => item.id === id))
  ) {
    setSelected(new Set([...selected].filter((id) => items.some((item) => item.id === id))))
  }

  function open(item: Item) {
    if (item.directory) {
      onSelectFile(null)
      onDirectory(item.id)
    } else if (item.file && ['image', 'video'].includes(item.file.media_kind)) onOpen(item.id)
    else setNotice('This file has no media preview.')
  }
  const pathOf = (item: Item) => item.file?.relative_path ?? item.directory?.directory_path
  function menuEntries(item: Item) {
    const path = pathOf(item)
    const targets = selected.has(item.id)
      ? items.filter((member) => selected.has(member.id))
      : [item]
    const paths = targets.flatMap((member) => (pathOf(member) ? [pathOf(member)!] : []))
    const fileTargets = targets.flatMap((member) => (member.file ? [member.file] : []))
    const allStarred = fileTargets.length > 0 && fileTargets.every((member) => member.starred)
    const anyStarred = fileTargets.some((member) => member.starred)
    return [
      {
        label: 'Open',
        onClick: () => open(item),
        disabled:
          !item.directory && (!item.file || !['image', 'video'].includes(item.file.media_kind)),
      },
      ...(fileStarEnabled && fileTargets.length === 1
        ? [
            {
              label: fileTargets[0]!.starred ? 'Unstar' : 'Star',
              disabled: blocked,
              onClick: () => commitStars([fileTargets[0]!.id], !fileTargets[0]!.starred),
            },
          ]
        : fileStarEnabled && fileTargets.length > 1
          ? [
              ...(!allStarred
                ? [
                    {
                      label: `Star ${fileTargets.length} Files`,
                      disabled: blocked,
                      onClick: () =>
                        commitStars(
                          fileTargets.map((member) => member.id),
                          true,
                        ),
                    },
                  ]
                : []),
              ...(anyStarred
                ? [
                    {
                      label: `Unstar ${fileTargets.length} Files`,
                      disabled: blocked,
                      onClick: () =>
                        commitStars(
                          fileTargets.map((member) => member.id),
                          false,
                        ),
                    },
                  ]
                : []),
            ]
          : []),
      ...(path && (item.directory ? onOpenDirectory : onLocateFile)
        ? [
            {
              label: 'Locate in File Browser',
              onClick: () => (item.directory ? onOpenDirectory?.(path) : onLocateFile?.(path)),
            },
          ]
        : []),
      ...(item.file && hostFiles
        ? hostFileMenuEntries(hostFiles.labels, hostFiles, item.file.relative_path)
        : []),
      ...(onRename && item.file
        ? [null, { label: 'Rename…', onClick: () => setRenaming(item.id) }]
        : []),
      ...(onSourceAction && paths.length
        ? [null, { label: 'Move to Trash', onClick: () => onSourceAction('trash', paths) }]
        : []),
      ...(exportsEnabled && item.file?.media_kind === 'video'
        ? [
            null,
            {
              label: 'Save Contact Sheet…',
              onClick: () => sheet.open(item.file!.id),
            },
          ]
        : []),
    ]
  }
  const { marqueeRect, onMouseDown } = useMarqueeSelect({
    getScrollEl: () => scrollRef.current,
    getWrapperEl: () => gridRef.current,
    isBackgroundTarget: (target) => !target.closest('[data-file-id], button'),
    getBaseSelection: () => selected,
    onChange: (ids) => setSelected(new Set(ids)),
    hitTest: (rect) => {
      const parent = gridRef.current?.getBoundingClientRect()
      if (!parent) return []
      return [...gridRef.current!.querySelectorAll<HTMLElement>('[data-file-id]')]
        .filter((element) => {
          const box = element.getBoundingClientRect()
          return rectsIntersect(rect, {
            left: box.left - parent.left,
            top: box.top - parent.top,
            width: box.width,
            height: box.height,
          })
        })
        .map((element) => element.dataset.fileId!)
    },
  })
  return (
    <div className="catalog-album-page" aria-label="Bundle album">
      <div className="album__bar">
        <button
          className="album__back"
          onClick={onBack}
          aria-label={directory ? 'Back to bundle' : 'Back to library'}
        >
          ‹ {directory ? 'Bundle' : 'Library'}
        </button>
        <span className="album__title">
          {first?.directory_path ?? first?.title ?? 'Bundle contents'}
        </span>
        <span className="album__count">
          {first ? `${items.length} of ${first.total} items` : 'Loading…'}
        </span>
        {albumFilterEnabled && (
          <div className="album__filters">
            <button
              type="button"
              className={`filter-chip${starredOnly ? ' filter-chip--on' : ''}`}
              aria-pressed={starredOnly}
              aria-label="Filter bundle by starred files"
              onClick={() => onStarredOnly(!starredOnly)}
            >
              <span className="filter-chip__icon">
                <IconStar filled={starredOnly} />
              </span>
              Starred
            </button>
            <AlbumTagFilter
              available={availableTags}
              selected={selectedTags}
              mode={tagMode}
              onChange={onSelectedTags}
              onMode={onTagMode}
            />
            {filterActive && (
              <button
                type="button"
                className="filterbar__clear"
                onClick={onClearFilters}
                aria-label="Clear album filters"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
      {notice && (
        <p role={starConflict ? 'alert' : 'status'}>
          <span>{notice}</span>{' '}
          {starConflict && (onReviewConflict || onReview) && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => (onReviewConflict ? onReviewConflict(starConflict) : onReview?.())}
            >
              Review Conflict
            </button>
          )}
        </p>
      )}
      {pages.error && (
        <div role="alert">
          {pages.error.message}
          <button onClick={() => setGeneration((old) => old + 1)}>Reload album</button>
        </div>
      )}
      <div
        className="album__scroll"
        ref={scrollRef}
        onMouseDown={onMouseDown}
        role="list"
        aria-label="Album items"
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            (event.target instanceof Element &&
              event.target.closest('input, textarea, .album-tile__star, .album-row__star')) ||
            document.querySelector('[aria-modal="true"], [role="menu"]')
          )
            return
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault()
            setSelected(new Set(items.map((item) => item.id)))
            setNotice('Selected loaded album items. Load more items to extend the selection.')
            return
          }
          if (event.key === 'F2' && sole?.file && onRename) {
            event.preventDefault()
            setRenaming(sole.id)
            return
          }
          if (
            (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) &&
            onSourceAction &&
            selected.size
          ) {
            event.preventDefault()
            onSourceAction(
              'trash',
              items
                .filter((item) => selected.has(item.id))
                .flatMap((item) => (pathOf(item) ? [pathOf(item)!] : [])),
            )
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            if (selected.size) setSelected(new Set())
            else onBack()
            return
          }
          let next: string | null = null
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
            next =
              navigation.current?.step(active, event.key === 'ArrowDown' ? 'down' : 'up') ?? null
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
            next =
              items[
                Math.max(
                  0,
                  Math.min(
                    items.length - 1,
                    items.findIndex((item) => item.id === active) +
                      (event.key === 'ArrowLeft' ? -1 : 1),
                  ),
                )
              ]?.id ?? null
          if (event.key === 'Home') next = items[0]?.id ?? null
          if (event.key === 'End') next = items.at(-1)?.id ?? null
          if (event.key === 'Enter' && sole) {
            event.preventDefault()
            open(sole)
          }
          if (next) {
            event.preventDefault()
            if (!event.shiftKey && (event.metaKey || event.ctrlKey)) setActive(next)
            else select(next, event)
            navigation.current?.focus(next)
          }
        }}
      >
        <div
          ref={gridRef}
          className={layout === 'list' ? 'album__rows' : 'album__grid'}
          style={{ position: 'relative', display: 'block' }}
        >
          {pages.isPending && <p className="state">Loading files…</p>}
          {first?.total === 0 &&
            (filterActive ? (
              <div className="state">
                <div>No files match these filters.</div>
                <button type="button" className="btn" onClick={onClearFilters}>
                  Clear filters
                </button>
              </div>
            ) : (
              <p className="state">
                {directory
                  ? 'This directory member has no cataloged files.'
                  : 'This bundle has no files or directory members.'}
              </p>
            ))}
          <AlbumItems
            items={items}
            scrollRef={scrollRef}
            layout={layout}
            zoom={zoom}
            showCardDetails={showCardDetails}
            getAspect={(item) => albumFileAspect(item.file)}
            navigationRef={navigation}
            render={(item) => {
              const showMeta = layout === 'grid' && showCardDetails
              const common = {
                selected: selected.has(item.id),
                onSelect: (event: React.MouseEvent | React.KeyboardEvent) => select(item.id, event),
                onOpen: () => open(item),
                onContextMenu: (event: React.MouseEvent) => {
                  event.preventDefault()
                  if (!selected.has(item.id))
                    select(item.id, { shiftKey: false, metaKey: false, ctrlKey: false })
                  menu.open(event, menuEntries(item))
                },
                dragProps: fileDragProps(
                  item.file && renaming !== item.id ? hostFiles?.onStartFileDrag : undefined,
                  () =>
                    (selected.has(item.id)
                      ? items.filter((member) => selected.has(member.id))
                      : [item]
                    ).flatMap((member) => (member.file ? [member.file.relative_path] : [])),
                ),
                catalog: true,
                nameEditor:
                  item.file && renaming === item.id && onRename ? (
                    <NameEditor
                      key={item.file.relative_path}
                      initial={leaf(item.file.relative_path)}
                      label={`Rename ${leaf(item.file.relative_path)}`}
                      validate={renameError}
                      onSubmit={async (name) => {
                        await onRename(item.file!.relative_path, name)
                        setRenaming(null)
                      }}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : undefined,
              }
              if (item.file) {
                const targetFile = item.file
                const starProps = fileStarEnabled
                  ? {
                      onToggleStar: () => commitStars([targetFile.id], !targetFile.starred),
                      starDisabled: blocked,
                    }
                  : {}
                return layout === 'list' ? (
                  <AlbumRow file={targetFile} {...common} {...starProps} />
                ) : (
                  <AlbumTile
                    file={targetFile}
                    showMeta={showMeta}
                    previewDisabled
                    {...common}
                    {...starProps}
                  />
                )
              }
              return (
                <button
                  className={
                    layout === 'list'
                      ? `file-row${selected.has(item.id) ? ' file-row--selected' : ''}`
                      : `album-tile${showMeta ? ' album-tile--framed' : ''}${selected.has(item.id) ? ' album-tile--selected' : ''}`
                  }
                  data-file-id={item.id}
                  title={item.directory?.directory_path}
                  aria-label={!showMeta ? item.directory?.directory_path : undefined}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    if (!selected.has(item.id))
                      select(item.id, { shiftKey: false, metaKey: false, ctrlKey: false })
                    menu.open(event, menuEntries(item))
                  }}
                  aria-pressed={selected.has(item.id)}
                  onClick={(event) => select(item.id, event)}
                  onDoubleClick={() => open(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      open(item)
                    } else if (event.key === ' ') {
                      event.preventDefault()
                      select(item.id, event)
                    }
                  }}
                >
                  <span className={layout === 'list' ? 'file-row__icon' : 'album-tile__thumb'}>
                    ▦
                  </span>
                  {(layout === 'list' || showMeta) && (
                    <>
                      <span className="album-tile__name">{item.directory?.directory_path}</span>
                      <span className="album-tile__sub">Directory member</span>
                    </>
                  )}
                </button>
              )
            }}
          />
          {marqueeRect && (
            <div
              className="marquee"
              style={{ position: 'absolute', ...marqueeRect, pointerEvents: 'none' }}
            />
          )}
        </div>
        {pages.hasNextPage && (
          <button
            disabled={pages.isFetchingNextPage || pages.isError}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage ? 'Loading more items…' : 'Load more album items'}
          </button>
        )}
      </div>
      <ContextMenu state={menu.state} onClose={menu.close} />
      {sheet.target && (
        <ContactSheetDialog
          target={sheet.target}
          onClose={sheet.close}
          onReport={(message) => setNotice(message ?? '')}
        />
      )}
    </div>
  )
}

function AlbumTagFilter({
  available,
  selected,
  mode,
  onChange,
  onMode,
}: {
  available: AlbumTagFilterItem[]
  selected: AlbumTagFilterItem[]
  mode: 'any' | 'all'
  onChange: (next: AlbumTagFilterItem[]) => void
  onMode: (mode: 'any' | 'all') => void
}) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  const selectedIds = new Set(selected.map((tag) => tag.id))
  const needle = search.trim().toLowerCase()
  const shown = useMemo(
    () =>
      flattenHierarchy(
        available.filter((tag) => !needle || tag.name.toLowerCase().includes(needle)),
      ),
    [available, needle],
  )

  function toggle(tag: AlbumTagFilterItem) {
    if (selectedIds.has(tag.id)) onChange(selected.filter((item) => item.id !== tag.id))
    else onChange([...selected, tag])
  }

  return (
    <div className="picker" ref={ref}>
      <button
        type="button"
        className={`filter-chip${selected.length > 0 ? ' filter-chip--on' : ''}`}
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Filter bundle by tags"
      >
        <span className="filter-chip__icon">
          <IconTag />
        </span>
        Tags
        {selected.length > 0 && <span className="filter-chip__badge">{selected.length}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel album-tag-filter"
            role="dialog"
            aria-label="Filter bundle by tags"
            ref={panelRef}
            style={{
              top: pos.top,
              bottom: pos.bottom,
              right: Math.max(8, Math.min(pos.right, Math.max(8, window.innerWidth - 316))),
              maxHeight: pos.maxHeight,
            }}
          >
            <div className="tag-filter__head">
              <div className="seg tag-filter__rules" role="group" aria-label="Tag match mode">
                <button
                  type="button"
                  className={mode === 'any' ? 'is-active' : ''}
                  aria-pressed={mode === 'any'}
                  onClick={() => onMode('any')}
                >
                  Any
                </button>
                <button
                  type="button"
                  className={mode === 'all' ? 'is-active' : ''}
                  aria-pressed={mode === 'all'}
                  onClick={() => onMode('all')}
                >
                  All
                </button>
              </div>
            </div>
            <input
              className="edit picker__search"
              placeholder="Search tags…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search bundle file tags"
              autoFocus
            />
            {shown.length === 0 ? (
              <div className="pick-group">
                {available.length === 0 ? 'No file tags in this bundle' : 'No matching tags'}
              </div>
            ) : (
              shown.map(({ item: tag, depth }) => {
                const on = selectedIds.has(tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={`pick-row${on ? ' pick-row--on' : ''}`}
                    style={{ paddingLeft: 10 + depth * 16 }}
                    onClick={() => toggle(tag)}
                  >
                    <span
                      className={`pick-row__box${on ? ' pick-row__box--on' : ''}`}
                      aria-hidden="true"
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className="pick-row__name">{tag.name}</span>
                  </button>
                )
              })
            )}
            {selected.length > 0 && (
              <div className="tag-filter__foot">
                <span className="tag-filter__hint">Includes subtags</span>
                <button
                  type="button"
                  className="add-btn"
                  onClick={() => onChange([])}
                  aria-label="Clear tag filter"
                >
                  Clear
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
