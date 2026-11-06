import { NameEditor } from './FileWriteDialogs'
import { leaf, renameError } from './sourceActions'
import { ContextMenu } from './ContextMenu'
import { useContextMenu } from './useContextMenu'
import { hostFileMenuEntries } from './hostActions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { replicaRequest } from '../api/replicas'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { ContactSheetDialog } from './ContactSheetDialog'
import { useLocalContactSheet } from './useLocalContactSheet'
import type { components } from '../api/schema'
import { fileDragProps } from './dragOut'
import { AlbumItems } from './AlbumItems'
import { AlbumRow, AlbumTile } from './AlbumItem'
import type { BrowserNavigation } from './Browser'
import { selectionRange, type SelectionModifiers } from './selection'
import { rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import type { LayoutMode, LocatedFile } from './types'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { useCatalogHistory } from './useCatalogHistory'

type Page = components['schemas']['CatalogAlbumPage']
type Item = Page['items'][number]
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
    layout: LayoutMode
    zoom: number
    onBack: () => void
    onOpen: (file: string) => void
    onSelectFile: (file: string | null) => void
    hostFiles?: LibraryHostFiles
    /** A located file to select, at the top level or in the folder member holding it */
    initialFile?: LocatedFile | null
  },
) {
  const [directory, setDirectory] = useState<string | null>(null)
  // The folder opened first carries the located file; leaving it ends the search
  const [locating, setLocating] = useState(props.initialFile ?? null)
  const status = useReplicaStatus(props.library).data
  const historyError = useCatalogHistory(
    props.library,
    props.bundle,
    (status?.browse_version ?? 0) >= 11,
  )
  return (
    <div className="album">
      {historyError && <p role="alert">{historyError}</p>}
      <div hidden={directory !== null} className="catalog-album-page">
        <AlbumPage
          {...props}
          activeView={directory === null}
          directory={null}
          onDirectory={setDirectory}
        />
      </div>
      {directory && (
        <AlbumPage
          {...props}
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
  directory,
  onDirectory,
  layout,
  zoom,
  onBack,
  onOpen,
  onSelectFile,
  activeView = true,
  hostFiles,
  initialFile = null,
  onLocateFile,
  onOpenDirectory,
  onRename,
  onSourceAction,
}: FileActions & {
  library: string
  bundle: string
  directory: string | null
  activeView?: boolean
  onDirectory: (id: string) => void
  layout: LayoutMode
  zoom: number
  onBack: () => void
  onOpen: (id: string) => void
  onSelectFile: (id: string | null) => void
  hostFiles?: LibraryHostFiles
  initialFile?: LocatedFile | null
}) {
  const [generation, setGeneration] = useState(0)
  const pages = useInfiniteQuery({
    queryKey: ['catalog-album', library, bundle, directory, generation],
    initialPageParam: { offset: 0, revision: '' },
    queryFn: ({ pageParam, signal }) =>
      replicaRequest<Page>(
        library,
        `/media/bundles/${bundle}/album?offset=${pageParam.offset}&limit=50${directory ? `&directory_id=${encodeURIComponent(directory)}` : ''}${pageParam.revision ? `&expected_revision=${pageParam.revision}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    getNextPageParam: (page) =>
      page.next_offset === null ? undefined : { offset: page.next_offset, revision: page.revision },
    refetchInterval: activeView ? 2000 : false,
    retry: false,
  })
  const items = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data])
  const first = pages.data?.pages[0]
  const [selected, setSelected] = useState(new Set<string>())
  const [active, setActive] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const navigation = useRef<BrowserNavigation>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  if (!onRename && renaming) setRenaming(null)
  const menu = useContextMenu()
  const exportsEnabled = useReplicaStatus(library).data?.export_version === 1
  const sheet = useLocalContactSheet(library, setNotice)
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
    return [
      {
        label: 'Open',
        onClick: () => open(item),
        disabled:
          !item.directory && (!item.file || !['image', 'video'].includes(item.file.media_kind)),
      },
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
      </div>
      {notice && <p role="status">{notice}</p>}
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
            (event.target instanceof Element && event.target.closest('input, textarea')) ||
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
          {first?.total === 0 && (
            <p className="state">
              {directory
                ? 'This directory member has no cataloged files.'
                : 'This bundle has no files or directory members.'}
            </p>
          )}
          <AlbumItems
            items={items}
            scrollRef={scrollRef}
            layout={layout}
            zoom={zoom}
            navigationRef={navigation}
            render={(item) => {
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
              if (item.file)
                return layout === 'list' ? (
                  <AlbumRow file={item.file} {...common} />
                ) : (
                  <AlbumTile file={item.file} previewDisabled {...common} />
                )
              return (
                <button
                  className={
                    layout === 'list'
                      ? `file-row${selected.has(item.id) ? ' file-row--selected' : ''}`
                      : `album-tile${selected.has(item.id) ? ' album-tile--selected' : ''}`
                  }
                  data-file-id={item.id}
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
                  <span className="album-tile__name">{item.directory?.directory_path}</span>
                  <span className="album-tile__sub">Directory member</span>
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
