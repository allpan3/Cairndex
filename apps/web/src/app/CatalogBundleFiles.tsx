import { useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import { replicaRequest } from '../api/replicas'
import { captureRequestScope } from '../api/requestScope'
import type { components } from '../api/schema'
import { useReplicaStatus } from '../api/useReplicaStatus'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import type { BundleMemberChange } from '../api/catalogBundleMembers'
import { collapsePrefixLengths } from './distinctNames'
import { IconChevron, IconFolder, IconGrip } from './icons'
import { InspectorSection } from './InspectorSection'
import { CatalogFileDetails } from './CatalogFileDetails'
import { CatalogBundleFileRow } from './CatalogBundleFileRow'
import { useCatalogBundleMembers } from './useCatalogBundleMembers'
import { ContextMenu } from './ContextMenu'
import { useContextMenu, type MenuEntry, type MenuState } from './useContextMenu'
import { hostFileMenuEntries } from './hostActions'
import { useLocalContactSheet } from './useLocalContactSheet'
import { ContactSheetDialog } from './ContactSheetDialog'

const PAGE = 30
type Page = components['schemas']['CatalogAlbumPage']
type Item = Page['items'][number]
type Props = {
  library: string
  bundle: string
  cover: string | null
  blocked: boolean
  fileCount?: number
  onCover: (file: string | null, reference?: Entity) => void
  onOpen: (file: string) => void
  onAddFiles?: () => void
  onReview?: () => void
  onLocateFile?: (path: string) => void
  onOpenDirectory?: (path: string) => void
  hostFiles?: LibraryHostFiles
  onSelectHostFile?: (file: string | null) => void
}

/** Paged directory rows share the viewer's order, without observing source bytes. */
export function CatalogBundleFiles(props: Props) {
  const changes = useCatalogBundleMembers(props.library, props.bundle)
  const enabled = (useReplicaStatus(props.library).data?.browse_version ?? 0) >= 16
  return (
    <InspectorSection
      id="files"
      className="files catalog-files"
      title={`Files in bundle${props.fileCount != null ? ` (${props.fileCount})` : ''}`}
      actions={
        props.onAddFiles && (
          <button
            className="sidebar__add"
            onClick={props.onAddFiles}
            title="Add unbundled files to this bundle"
            aria-label="Add files to this bundle"
          >
            +
          </button>
        )
      }
    >
      {changes.pending && (
        <p role="status">
          A file change is retained.
          <button
            className="btn"
            disabled={props.blocked || changes.busy}
            onClick={() => void changes.apply()}
          >
            Retry file change
          </button>
        </p>
      )}
      {changes.copies.map((copy) => (
        <button
          key={copy.id}
          className="btn"
          disabled={props.blocked || changes.busy || Boolean(changes.pending)}
          onClick={() => changes.recover(copy.body.data)}
        >
          Recover retained file change
        </button>
      ))}
      {changes.error && <p role="alert">{changes.error}</p>}
      <FilePage {...props} directory={null} enabled={enabled} changes={changes} />
    </InspectorSection>
  )
}

function FilePage(
  props: Props & {
    directory: string | null
    enabled: boolean
    changes: ReturnType<typeof useCatalogBundleMembers>
  },
) {
  const { library, bundle, directory, changes } = props
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState(new Set<string>())
  const [coverBusy, setCoverBusy] = useState(false)
  const [error, setError] = useState('')
  const sheet = useLocalContactSheet(library, setError)
  const exportEnabled = useReplicaStatus(library).data?.export_version === 1
  const menu = useContextMenu()
  const [menuRow, setMenuRow] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    id: string
    x: number
    y: number
    active: boolean
    before: string | null | undefined
  } | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const [dragging, setDragging] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const moveRunning = useRef(false)
  const pendingFocus = useRef<{ id: string; origin: Element | null } | null>(null)
  const page = useQuery({
    queryKey: ['catalog-inspector-files', library, bundle, directory, offset],
    queryFn: () =>
      replicaRequest<Page>(
        library,
        `/media/bundles/${bundle}/album?offset=${offset}&limit=${PAGE}${directory ? `&directory_id=${encodeURIComponent(directory)}` : ''}`,
      ),
    refetchInterval: 2000,
  })
  const items = page.data?.items ?? []
  const files = items.flatMap((item) => (item.file ? [item.file] : []))
  const cuts = collapsePrefixLengths(files.map((file) => file.display_title))
  const disabled =
    props.blocked || moving || changes.busy || Boolean(changes.pending) || !page.data?.editable
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    if (document.activeElement !== pending.origin && document.activeElement !== document.body) {
      pendingFocus.current = null
      return
    }
    const target = root.current?.querySelector<HTMLElement>(`[data-member-id="${pending.id}"]`)
    if (target) {
      pendingFocus.current = null
      target.focus()
    }
  })
  async function change(intent: BundleMemberChange) {
    if (disabled) return
    if (await changes.apply(intent, page.data?.observed ?? {})) {
      setSelected(null)
      props.onSelectHostFile?.(null)
    }
  }
  async function toggleCover(id: string) {
    if (props.cover === id) {
      props.onCover(null)
      return
    }
    setCoverBusy(true)
    setError('')
    try {
      props.onCover(id, await catalog<Entity>(library, `/entities/asset_files/${id}`))
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setCoverBusy(false)
    }
  }
  async function move(item: Item, destination: number) {
    const current = page.data
    if (
      disabled ||
      moveRunning.current ||
      !current ||
      destination < 0 ||
      destination >= current.total
    )
      return
    const from = offset + items.findIndex((row) => row.id === item.id)
    if (destination === from) return
    moveRunning.current = true
    setMoving(true)
    setError('')
    const assertScope = captureRequestScope()
    const origin = document.activeElement
    try {
      const beforeIndex = destination > from ? destination + 1 : destination
      let before: string | null = null
      if (beforeIndex < current.total) {
        const local = items[beforeIndex - offset]
        if (local) before = local.id
        else {
          const neighbor = await replicaRequest<Page>(
            library,
            `/media/bundles/${bundle}/album?offset=${beforeIndex}&limit=1`,
          )
          assertScope()
          if (
            JSON.stringify(neighbor.observed) !== JSON.stringify(current.observed) ||
            !neighbor.items[0]
          )
            throw new Error('Bundle files changed; refresh the file list before trying again')
          before = neighbor.items[0].id
        }
      }
      assertScope()
      if (
        await changes.apply({ change: 'move', entity: item.id, before }, current.observed ?? {})
      ) {
        const nextOffset = Math.floor(destination / PAGE) * PAGE
        if (nextOffset !== offset) pendingFocus.current = { id: item.id, origin }
        setOffset(nextOffset)
      }
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      moveRunning.current = false
      setMoving(false)
    }
  }
  function entries(item: Item): MenuEntry[] {
    const result: MenuEntry[] = []
    if (!directory)
      result.push(
        {
          label: 'Move Up',
          disabled: disabled || (offset === 0 && items[0]?.id === item.id),
          onClick: () => void move(item, offset + items.findIndex((row) => row.id === item.id) - 1),
        },
        {
          label: 'Move Down',
          disabled: disabled || (page.data?.next_offset === null && items.at(-1)?.id === item.id),
          onClick: () => void move(item, offset + items.findIndex((row) => row.id === item.id) + 1),
        },
        {
          label: 'Move to Beginning',
          disabled: disabled || (offset === 0 && items[0]?.id === item.id),
          onClick: () => void move(item, 0),
        },
        {
          label: 'Move to End',
          disabled: disabled || (page.data?.next_offset === null && items.at(-1)?.id === item.id),
          onClick: () => void move(item, (page.data?.total ?? 1) - 1),
        },
      )
    if (item.file) {
      if (props.onLocateFile)
        result.push({
          label: 'Locate in File Browser',
          onClick: () => props.onLocateFile?.(item.file!.relative_path),
        })
      if (props.hostFiles)
        result.push(
          ...hostFileMenuEntries(props.hostFiles.labels, props.hostFiles, item.file.relative_path),
        )
      if (exportEnabled && item.file.media_kind === 'video')
        result.push({ label: 'Export Contact Sheet…', onClick: () => sheet.open(item.id) })
      result.push({
        label: 'Remove from Bundle',
        disabled,
        onClick: () => void change({ change: 'remove', entity: item.id }),
      })
      const parent = item.file.relative_path.split('/').slice(0, -1).join('/')
      if (parent && !directory)
        result.push({
          label: `Collapse “${parent.split('/').at(-1)}” into One Row`,
          disabled,
          onClick: () => void change({ change: 'collapse', entity: item.id, directory: parent }),
        })
    } else {
      if (props.onOpenDirectory)
        result.push({
          label: 'Open in File Browser',
          onClick: () => props.onOpenDirectory?.(item.directory!.directory_path),
        })
      result.push({
        label: 'Expand Folder into Files',
        disabled,
        onClick: () => void change({ change: 'expand', entity: item.id }),
      })
    }
    return result
  }
  function openMenu(event: React.MouseEvent, item: Item) {
    setMenuRow(item.id)
    menu.open(event, entries(item))
  }
  return (
    <div ref={root} className="catalog-member-page">
      {page.isPending && <p role="status">Loading files…</p>}
      {page.error && (
        <p role="alert">
          Files are unavailable.
          <button className="btn btn--sm" onClick={() => void page.refetch()}>
            Try Again
          </button>
        </p>
      )}
      {page.data && items.length === 0 && (
        <p>No files in this {directory ? 'folder' : 'bundle'}.</p>
      )}
      {props.enabled && page.data && !page.data.editable && (
        <p role="alert">
          The file arrangement needs metadata review before it can be changed.
          {props.onReview && (
            <button className="btn" onClick={props.onReview}>
              Open metadata review
            </button>
          )}
        </p>
      )}
      <div
        className="files__list"
        role="list"
        aria-label={directory ? 'Files in folder' : 'Files in bundle'}
      >
        {items.map((item, index) => (
          <div key={item.id}>
            <div
              className={`file-row${selected === item.id ? ' file-row--selected' : ''}${dragging === item.id ? ' file-row--dragging' : ''}`}
              role="listitem"
              data-member-id={item.id}
              data-drop={
                dropBefore === item.id
                  ? 'before'
                  : dropBefore === null && index === items.length - 1
                    ? 'after'
                    : undefined
              }
              tabIndex={0}
              onContextMenu={props.enabled ? (event) => openMenu(event, item) : undefined}
              onKeyDown={(event) => {
                if (
                  !props.enabled ||
                  directory ||
                  !event.altKey ||
                  !['ArrowUp', 'ArrowDown'].includes(event.key)
                )
                  return
                event.preventDefault()
                void move(item, offset + index + (event.key === 'ArrowUp' ? -1 : 1))
              }}
            >
              {props.enabled && !directory && (
                <button
                  className="catalog-file-grip"
                  aria-label={`Reorder ${item.file?.relative_path ?? item.directory?.directory_path}`}
                  title="Drag to reorder · Alt+Arrow to move"
                  disabled={disabled}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    event.preventDefault()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    drag.current = {
                      id: item.id,
                      x: event.clientX,
                      y: event.clientY,
                      active: false,
                      before: undefined,
                    }
                  }}
                  onPointerMove={(event) => {
                    const pointer = drag.current
                    if (!pointer) return
                    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) {
                      pointer.active = true
                      setDragging(pointer.id)
                    }
                    if (!pointer.active) return
                    const target = document
                      .elementFromPoint(event.clientX, event.clientY)
                      ?.closest<HTMLElement>('[data-member-id]')
                    const index = items.findIndex((row) => row.id === target?.dataset.memberId)
                    if (
                      !target ||
                      index < 0 ||
                      target.closest('.catalog-member-page') !== root.current ||
                      target.dataset.memberId === item.id
                    ) {
                      pointer.before = undefined
                      setDropBefore(undefined)
                      return
                    }
                    const rect = target.getBoundingClientRect()
                    const before =
                      event.clientY < rect.top + rect.height / 2
                        ? items[index]!.id
                        : (items[index + 1]?.id ??
                          (page.data?.next_offset === null ? null : undefined))
                    pointer.before = before
                    setDropBefore(before)
                  }}
                  onPointerUp={() => {
                    const pointer = drag.current
                    drag.current = null
                    setDragging(null)
                    setDropBefore(undefined)
                    if (pointer?.active && pointer.before !== undefined)
                      void change({ change: 'move', entity: pointer.id, before: pointer.before })
                  }}
                  onPointerCancel={() => {
                    drag.current = null
                    setDragging(null)
                    setDropBefore(undefined)
                  }}
                >
                  <IconGrip />
                </button>
              )}
              {item.file ? (
                <CatalogBundleFileRow
                  file={item.file}
                  selected={selected === item.id}
                  blocked={props.blocked}
                  busy={coverBusy}
                  cover={props.cover}
                  hostFiles={props.hostFiles}
                  cut={cuts[files.findIndex((file) => file.id === item.id)] ?? 0}
                  onPick={() => {
                    const next = selected === item.id ? null : item.id
                    setSelected(next)
                    props.onSelectHostFile?.(next)
                  }}
                  onCover={() => void toggleCover(item.id)}
                  onOpen={() => props.onOpen(item.id)}
                />
              ) : (
                <button
                  className="file-row__main"
                  aria-expanded={open.has(item.id)}
                  aria-label={`${open.has(item.id) ? 'Hide' : 'Show'} files in ${item.directory?.directory_path}`}
                  onDoubleClick={() =>
                    item.directory && props.onOpenDirectory?.(item.directory.directory_path)
                  }
                  onClick={() =>
                    setOpen((prior) => {
                      const next = new Set(prior)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })
                  }
                >
                  <IconChevron open={open.has(item.id)} />
                  <IconFolder />
                  <span className="file-row__title">{item.directory?.name}</span>
                  <span className="file-row__role">{item.directory?.file_count} files</span>
                </button>
              )}
              {props.enabled && (
                <button
                  className="btn btn--compact"
                  aria-label={`Actions for ${item.file?.relative_path ?? item.directory?.directory_path}`}
                  onClick={(event) => openMenu(event, item)}
                >
                  …
                </button>
              )}
            </div>
            {item.kind === 'directory' && open.has(item.id) && (
              <FilePage {...props} key={item.id} directory={item.id} />
            )}
          </div>
        ))}
      </div>
      {selected && files.some((file) => file.id === selected) && (
        <CatalogFileDetails
          key={selected}
          library={library}
          file={selected}
          hostFiles={props.hostFiles}
        />
      )}
      {(offset > 0 || page.data?.next_offset != null) && (
        <div className="catalog-files__pages">
          {offset > 0 && (
            <button className="btn btn--sm" onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous files
            </button>
          )}
          {page.data?.next_offset != null && (
            <button className="btn btn--sm" onClick={() => setOffset(page.data!.next_offset!)}>
              More files
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <FileMenu
        state={menu.state}
        item={menu.state ? items.find((row) => row.id === menuRow) : undefined}
        entries={entries}
        onClose={menu.close}
      />
      {sheet.target && (
        <ContactSheetDialog
          target={sheet.target}
          onClose={sheet.close}
          onReport={(message) => setError(message ?? '')}
        />
      )}
    </div>
  )
}

/**
 * The open menu follows its row, so a save that settles while it is open enables
 * its actions against the arrangement now shown. The opening snapshot remains
 * only when a refresh takes the row off this page.
 *
 * FileMenu, not FilePage, rebuilds the entries while rendering. A move reads a
 * ref, and the compiler must assume that any call FilePage makes while rendering
 * may run the moves the entries capture. Building the entries only creates their
 * click handlers, and only those handlers run a move.
 */
function FileMenu(props: {
  state: MenuState | null
  item: Item | undefined
  entries: (item: Item) => MenuEntry[]
  onClose: () => void
}) {
  const { state, item } = props
  return (
    <ContextMenu
      state={state && item ? { ...state, items: props.entries(item) } : state}
      onClose={props.onClose}
    />
  )
}
