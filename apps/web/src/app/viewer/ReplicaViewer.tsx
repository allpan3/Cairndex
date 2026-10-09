import { useCallback, useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { replicaRequest } from '../../api/replicas'
import { resolveAssetUrl, type FileBrowserEntry } from '../../api/client'
import { getConnectionScopeKey } from '../../api/requestScope'
import type { components } from '../../api/schema'
import { usePersistentState } from '../../state/usePersistentState'
import { DEFAULT_PLAYER_PREFS, type PlayerPrefs } from '../types'
import { playlistFor } from '../bundleRows'
import { ViewerShell } from './ViewerShell'
import { viewerItemFromFile, viewerItemFromEntry } from './viewerItem'

type Playlist = components['schemas']['ReplicaPlaylist']
type LocalMedia = components['schemas']['LocalMediaRead']

export interface ReplicaOpen {
  bundleId?: string
  fileId?: string
  time?: number
}

// Resolve catalog identity first, then reuse the production shell with private media observations
export function ReplicaViewer({
  library,
  target,
  onClose,
  folder,
}: {
  folder?: { entries: FileBrowserEntry[]; title: string }
  library: string
  target: ReplicaOpen
  onClose: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
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
    retry: false,
  })
  const first = pages.data?.pages[0]
  const files = useMemo(() => pages.data?.pages.flatMap((page) => page.files) ?? [], [pages.data])
  const playlist = useMemo(
    () => playlistFor(files, first?.directories ?? [], target.fileId, initial.data?.file),
    [files, first?.directories, target.fileId, initial.data?.file],
  )
  const sequence = folder
    ? folder.entries.map((file) => file.file_id!)
    : playlist.map((file) => file.id)
  const requested = picked ?? target.fileId
  const preferred = requested ?? first?.cursor
  const waitingForPreferred =
    !pages.isError && preferred && !sequence.includes(preferred ?? '') && pages.hasNextPage
  const selected = waitingForPreferred
    ? undefined
    : ((sequence.includes(preferred ?? '') ? preferred : null) ??
      (requested ? undefined : sequence[0]))
  const index = sequence.indexOf(selected ?? '')
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
    enabled: Boolean(selected),
    queryFn: ({ signal }) =>
      replicaRequest<LocalMedia>(library, `/media/files/${selected}`, 'GET', undefined, signal),
    retry: false,
    // Resume and availability belong to this opening, never an inactive cached observation
    gcTime: 0,
  })
  const observation = local.isFetchedAfterMount ? local.data : undefined
  useEffect(() => {
    const owner = folder ? observation?.file.bundle_id : bundleId
    if (!owner || !selected) return
    void replicaRequest(library, `/media/bundles/${owner}/cursor`, 'PUT', {
      file_id: selected,
    }).catch(() => undefined)
  }, [bundleId, library, selected, folder, observation?.file.bundle_id])
  const items = useMemo(
    () =>
      (folder ? folder.entries.map(viewerItemFromEntry) : playlist.map(viewerItemFromFile)).map(
        (baseItem) => {
          const id = baseItem.fileId
          const value = id === observation?.file.id ? observation : null
          const item = value ? viewerItemFromFile(value.file) : baseItem
          const token = value?.generation
          return {
            ...item,
            key: `${id}:${token ?? 'unobserved'}`,
            sourceGeneration: token,
            canSetCover: false,
            contentUrl: token ? `${item.contentUrl}?source_generation=${token}` : item.contentUrl,
            imageTiers: item.imageTiers.map((tier) => ({
              ...tier,
              src: token
                ? `${tier.src}${tier.src.includes('?') ? '&' : '?'}source_generation=${token}`
                : tier.src,
            })),
          }
        },
      ),
    [playlist, observation, folder],
  )
  const playable = useMemo(() => {
    const value = observation?.playback
    return value
      ? {
          ...value,
          stream_url: resolveAssetUrl(value.stream_url),
          subtitles: value.subtitles.map((track) => ({
            ...track,
            src: track.src ? resolveAssetUrl(track.src) : null,
          })),
        }
      : null
  }, [observation?.playback])
  const retry = useCallback(async () => {
    if (!folder && !bundleId && target.fileId) await initial.refetch()
    if (!folder) await pages.refetch()
    if (selected) await local.refetch()
  }, [bundleId, initial, local, pages, selected, target.fileId, folder])
  const mediaError =
    local.data?.state === 'available' && local.data.message ? new Error(local.data.message) : null
  return (
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
        (!folder && ((!bundleId && initial.isPending) || pages.isPending)) ||
        Boolean(waitingForPreferred) ||
        (Boolean(selected) && !local.isFetchedAfterMount)
      }
      error={
        initial.error ??
        pages.error ??
        local.error ??
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
      savedMoments={first?.moments}
      onRetryMedia={retry}
      serverExports={false}
      startAt={
        target.fileId && target.time !== undefined
          ? { fileId: target.fileId, time: target.time }
          : null
      }
    />
  )
}
