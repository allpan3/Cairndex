import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { fileDragProps } from './dragOut'
import { AlbumItems } from './AlbumItems'
import { AlbumRow, AlbumTile } from './AlbumItem'
import type { BrowserNavigation } from './Browser'
import { selectionRange, type SelectionModifiers } from './selection'
import { rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import type { LayoutMode } from './types'

type Page = components['schemas']['CatalogAlbumPage']
type Item = Page['items'][number]

export function CatalogBundleAlbum(props: {
  library: string
  bundle: string
  layout: LayoutMode
  zoom: number
  onBack: () => void
  onOpen: (file: string) => void
  onSelectFile: (file: string | null) => void
}) {
  const [directory, setDirectory] = useState<string | null>(null)
  return (
    <div className="album">
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
          onBack={() => {
            setDirectory(null)
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
}: {
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
            document.querySelector('[aria-modal="true"], [role="menu"]')
          )
            return
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault()
            setSelected(new Set(items.map((item) => item.id)))
            setNotice('Selected loaded album items. Load more items to extend the selection.')
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
                  select(item.id, event)
                  setNotice('Use the bundle inspector for metadata changes.')
                },
                dragProps: fileDragProps(undefined, () => []),
                catalog: true,
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
    </div>
  )
}
