import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { replicaRequest } from '../../api/replicas'
import { useReplicaStatus } from '../../api/useReplicaStatus'
import { resolveAssetUrl, type FileBrowserEntry } from '../../api/client'
import { getConnectionScopeKey } from '../../api/requestScope'
import type { components } from '../../api/schema'
import { usePersistentState } from '../../state/usePersistentState'
import { DEFAULT_PLAYER_PREFS, type PlayerPrefs } from '../types'
import { playlistFor } from '../bundleRows'
import { ViewerShell } from './ViewerShell'
import { viewerItemFromFile, viewerItemFromEntry, pathPlayable } from './viewerItem'
import { useLibraryHostFiles, type LibraryHostFiles } from '../../desktop/useLibraryHostFiles'
import { Moments } from '../Moments'
import { MomentSourceContext } from '../momentSource'
import { useCatalogMomentSource } from '../useCatalogMomentSource'
import { inspectorTargetForEntry, type ViewerInspectorTarget } from '../fileFacts'
import { useCatalogHistory } from '../useCatalogHistory'

type Playlist = components['schemas']['ReplicaPlaylist']
type LocalMedia = components['schemas']['LocalMediaRead']
type Storyboard = components['schemas']['ReplicaStoryboardRead']
type PathObservation = components['schemas']['PathMediaRead']

export interface ReplicaOpen {
  bundleId?: string
  fileId?: string
  relativePath?: string
  time?: number
}

/** What the viewer hands to the bundle inspector that its workspace builds. */
export interface ReplicaInspectorControls {
  /** The moments section, inside this viewer's moment source and player actions. */
  moments: ReactNode
  /** Show another file of the bundle in this viewer. */
  onOpenFile: (fileId: string) => void
  hostFiles: LibraryHostFiles
}

// Resolve catalog identity first, then reuse the production shell with private media observations
export function ReplicaViewer({
  library,
  target,
  onClose,
  folder,
  renderInspector,
}: {
  folder?: { entries: FileBrowserEntry[]; title: string }
  library: string
  target: ReplicaOpen
  onClose: () => void
  /**
   * The full bundle inspector for the rail, from the workspace that owns the
   * bundle's drafts. Without it the rail shows only the bundle's moments.
   */
  renderInspector?: (bundleId: string, controls: ReplicaInspectorControls) => ReactNode
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const hostFiles = useLibraryHostFiles(library)
  // Capability versions keep export, storyboard and moment requests off older servers
  const status = useReplicaStatus(library)
  const [prefs, setPrefs] = usePersistentState<PlayerPrefs>(
    `cairndex.replica.player.${getConnectionScopeKey()}.${library}`,
    DEFAULT_PLAYER_PREFS,
  )
  const initial = useQuery({
    queryKey: ['replica-media', library, 'initial', target.fileId],
    enabled: !folder && Boolean(target.fileId),
    queryFn: ({ signal }) =>
      replicaRequest<LocalMedia>(
        library,
        `/media/files/${target.fileId}`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
  })
  const bundleId = target.bundleId ?? initial.data?.file.bundle_id
  const pages = useInfiniteQuery({
    queryKey: ['replica-media', library, 'playlist', bundleId],
    enabled: !folder && Boolean(bundleId),
    initialPageParam: { offset: 0, revision: '' },
    queryFn: ({ pageParam, signal }) =>
      replicaRequest<Playlist>(
        library,
        `/media/bundles/${bundleId}?offset=${pageParam.offset}${pageParam.revision ? `&expected_revision=${pageParam.revision}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    getNextPageParam: (last) =>
      last.next_offset == null
        ? undefined
        : { offset: last.next_offset, revision: last.revision ?? '' },
    refetchOnMount: 'always',
    retry: false,
  })
  // A cached cursor belongs to the previous opening. Using it while refetching
  // would select (and write back) the wrong file before the current cursor arrives.
  const currentPages = pages.isFetchedAfterMount ? pages.data : undefined
  const first = currentPages?.pages[0]
  const files = useMemo(
    () => currentPages?.pages.flatMap((page) => page.files) ?? [],
    [currentPages],
  )
  const playlist = useMemo(
    () => playlistFor(files, first?.directories ?? [], target.fileId, initial.data?.file),
    [files, first?.directories, target.fileId, initial.data?.file],
  )
  const sequence = folder
    ? folder.entries.map((file) => file.file_id ?? `path:${file.relative_path}`)
    : playlist.map((file) => file.id)
  const requested =
    picked ?? target.fileId ?? (target.relativePath ? `path:${target.relativePath}` : undefined)
  const preferred = requested ?? first?.cursor
  const waitingForPreferred =
    !pages.isError && preferred && !sequence.includes(preferred ?? '') && pages.hasNextPage
  const selected = waitingForPreferred
    ? undefined
    : ((sequence.includes(preferred ?? '') ? preferred : null) ??
      (requested ? undefined : sequence[0]))
  const index = sequence.indexOf(selected ?? '')
  const selectedEntry = folder?.entries[index]
  const unlinked = Boolean(selectedEntry && !selectedEntry.file_id)
  const pathSupported = status.data?.path_media_version === 1
  // Fetch the next metadata page ahead of the ordered transition; this never reads media bytes
  useEffect(() => {
    if (
      !folder &&
      pages.hasNextPage &&
      !pages.isFetchingNextPage &&
      !pages.isFetchNextPageError &&
      (index >= playlist.length - 3 || (preferred && !sequence.includes(preferred ?? '')))
    ) {
      void pages.fetchNextPage()
    }
  }, [index, playlist, preferred, pages, folder, sequence])
  const local = useQuery({
    queryKey: ['replica-media', library, 'file', selected],
    enabled: Boolean(selected) && !unlinked,
    queryFn: ({ signal }) =>
      replicaRequest<LocalMedia>(library, `/media/files/${selected}`, 'GET', undefined, signal),
    retry: false,
    // Resume and availability belong to this opening, never an inactive cached observation
    gcTime: 0,
  })
  const observation = !unlinked && local.isFetchedAfterMount ? local.data : undefined
  const path = useQuery({
    queryKey: ['replica-media', library, 'path', selectedEntry?.relative_path],
    enabled: unlinked && pathSupported,
    queryFn: ({ signal }) =>
      replicaRequest<PathObservation>(
        library,
        `/media/path?path=${encodeURIComponent(selectedEntry!.relative_path)}`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
    gcTime: 0,
  })
  const pathObservation = unlinked && path.isFetchedAfterMount ? path.data : undefined
  const historyError = useCatalogHistory(
    library,
    folder ? observation?.file.bundle_id : bundleId,
    (status.data?.browse_version ?? 0) >= 11,
  )
  // The server makes the storyboard in the background; poll until it is settled
  const generation = observation?.generation
  const storyboard = useQuery({
    queryKey: ['replica-media', library, 'storyboard', selected, generation],
    enabled:
      status.data?.storyboard_version === 1 &&
      Boolean(selected && generation && observation?.playback),
    queryFn: ({ signal }) =>
      replicaRequest<Storyboard>(
        library,
        `/media/files/${selected}/storyboard`,
        'POST',
        { generation },
        signal,
      ),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.state ?? '') ? 2000 : false,
    retry: false,
  })
  const storyboardUrl = storyboard.data?.url ? resolveAssetUrl(storyboard.data.url) : null
  // Moments belong to the bundle; a folder playlist shows the current file's bundle
  const momentBundle = (folder ? observation?.file.bundle_id : bundleId) ?? null
  const { version: momentsVersion, source: momentSource } = useCatalogMomentSource(
    library,
    momentBundle,
    selected ?? null,
    storyboardUrl,
  )
  const momentsEnabled = momentsVersion >= 1
  const momentFiles = useMemo(
    () => (folder ? (observation ? [observation.file] : []) : files),
    [files, folder, observation],
  )
  const inspectorTarget = useMemo<ViewerInspectorTarget | null>(() => {
    if (pathObservation) return inspectorTargetForEntry(pathObservation.entry)
    const showMoments = momentsEnabled && momentFiles.some((file) => file.media_kind === 'video')
    if (!momentBundle) return null
    if (renderInspector)
      return {
        kind: 'catalog',
        bundleId: momentBundle,
        inspector: renderInspector(momentBundle, {
          moments: showMoments ? <Moments bundleId={momentBundle} files={momentFiles} /> : null,
          onOpenFile: setPicked,
          hostFiles,
        }),
      }
    return showMoments ? { kind: 'moments', bundleId: momentBundle, files: momentFiles } : null
  }, [hostFiles, momentBundle, momentFiles, momentsEnabled, renderInspector, pathObservation])
  useEffect(() => {
    const owner = folder ? observation?.file.bundle_id : bundleId
    if (!owner || !selected || unlinked) return
    void replicaRequest(library, `/media/bundles/${owner}/cursor`, 'PUT', {
      file_id: selected,
    }).catch(() => undefined)
  }, [bundleId, library, selected, folder, observation?.file.bundle_id, unlinked])
  const items = useMemo(
    () =>
      (folder ? folder.entries.map(viewerItemFromEntry) : playlist.map(viewerItemFromFile)).map(
        (baseItem) => {
          const id = baseItem.fileId
          const value = id === observation?.file.id ? observation : null
          const pathValue =
            !id && baseItem.pathTarget === pathObservation?.entry.relative_path
              ? pathObservation
              : null
          const item = value
            ? viewerItemFromFile(value.file)
            : pathValue
              ? viewerItemFromEntry(pathValue.entry)
              : baseItem
          const token = value?.generation ?? pathValue?.generation
          return {
            ...item,
            key: `${id ?? `path:${baseItem.key}`}:${token ?? 'unobserved'}`,
            sourceGeneration: token,
            canSetCover: false,
            contentUrl: token
              ? `${item.contentUrl}${item.contentUrl.includes('?') ? '&' : '?'}source_generation=${token}`
              : item.contentUrl,
            imageTiers: item.imageTiers.map((tier) => ({
              ...tier,
              src: token
                ? `${tier.src}${tier.src.includes('?') ? '&' : '?'}source_generation=${token}`
                : tier.src,
            })),
          }
        },
      ),
    [playlist, observation, pathObservation, folder],
  )
  const playable = useMemo(() => {
    if (pathObservation?.entry.media_kind === 'video') {
      const value = pathPlayable(viewerItemFromEntry(pathObservation.entry))
      return {
        ...value,
        stream_url: `${value.stream_url}&source_generation=${pathObservation.generation}`,
      }
    }
    const value = observation?.playback
    return value
      ? {
          ...value,
          stream_url: resolveAssetUrl(value.stream_url),
          storyboard_url: storyboardUrl,
          subtitles: value.subtitles.map((track) => ({
            ...track,
            src: track.src ? resolveAssetUrl(track.src) : null,
          })),
        }
      : null
  }, [observation?.playback, storyboardUrl, pathObservation])
  const retry = useCallback(async () => {
    if (!folder && !bundleId && target.fileId) await initial.refetch()
    if (!folder) await pages.refetch()
    if (unlinked && pathSupported) await path.refetch()
    else if (selected && !unlinked) await local.refetch()
  }, [
    bundleId,
    initial,
    local,
    pages,
    selected,
    target.fileId,
    folder,
    unlinked,
    pathSupported,
    path,
  ])
  const mediaError =
    local.data?.state === 'available' && local.data.message ? new Error(local.data.message) : null
  const shell = (
    <ViewerShell
      items={items}
      index={index}
      onIndex={(next) => setPicked(sequence[next] ?? null)}
      playable={playable}
      title={folder?.title ?? first?.title ?? 'Local media'}
      artworkUrl=""
      playerPrefs={prefs}
      onPlayerPrefs={setPrefs}
      onClose={onClose}
      loading={
        (!folder && ((!bundleId && initial.isPending) || !pages.isFetchedAfterMount)) ||
        Boolean(waitingForPreferred) ||
        (Boolean(selected) &&
          (unlinked
            ? status.isPending || (pathSupported && !path.isFetchedAfterMount)
            : !local.isFetchedAfterMount))
      }
      error={
        initial.error ??
        pages.error ??
        (unlinked ? path.error : local.error) ??
        (unlinked ? status.error : null) ??
        (unlinked && !status.isPending && !pathSupported
          ? new Error(
              'This server cannot preview unindexed files. Update the server and reopen the file.',
            )
          : null) ??
        mediaError ??
        (requested && !pages.hasNextPage && pages.isSuccess && !sequence.includes(requested)
          ? new Error(
              'Selected file is no longer in this playlist. Close the viewer and reload the album.',
            )
          : null)
      }
      emptyMessage={
        !(folder ? false : pages.isPending) && !sequence.length
          ? 'This bundle has no previewable media outside its folder members. Open a cataloged file to view that folder.'
          : null
      }
      savedMoments={momentsEnabled ? undefined : first?.moments}
      inspectorTarget={inspectorTarget}
      onRetryMedia={retry}
      serverExports={!unlinked && status.data?.export_version === 1}
      hostFiles={hostFiles}
      hostPath={observation?.file.relative_path ?? pathObservation?.entry.relative_path ?? null}
      startAt={
        target.fileId && target.time !== undefined
          ? { fileId: target.fileId, time: target.time }
          : null
      }
    />
  )
  return (
    <>
      {historyError && <p role="alert">{historyError}</p>}
      {momentsEnabled ? (
        <MomentSourceContext value={momentSource}>{shell}</MomentSourceContext>
      ) : (
        shell
      )}
    </>
  )
}
