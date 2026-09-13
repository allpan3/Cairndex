import { useCallback, useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { replicaRequest } from '../../api/replicas'
import { resolveAssetUrl } from '../../api/client'
import { getConnectionScopeKey } from '../../api/requestScope'
import type { components } from '../../api/schema'
import { usePersistentState } from '../../state/usePersistentState'
import { DEFAULT_PLAYER_PREFS, type PlayerPrefs } from '../types'
import { playlistFor } from '../bundleRows'
import { ViewerShell } from './ViewerShell'
import { viewerItemFromFile } from './viewerItem'

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
}: {
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
    enabled: Boolean(target.fileId),
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
    enabled: Boolean(bundleId),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      replicaRequest<Playlist>(
        library,
        `/media/bundles/${bundleId}?offset=${pageParam}`,
        'GET',
        undefined,
        signal,
      ),
    getNextPageParam: (last) => last.next_offset ?? undefined,
    retry: false,
  })
  const first = pages.data?.pages[0]
  const files = useMemo(() => pages.data?.pages.flatMap((page) => page.files) ?? [], [pages.data])
  const playlist = useMemo(
    () => playlistFor(files, first?.directories ?? [], target.fileId),
    [files, first?.directories, target.fileId],
  )
  const preferred = target.fileId ?? first?.cursor
  const waitingForPreferred =
    !picked && preferred && !playlist.some((file) => file.id === preferred) && pages.hasNextPage
  const selected = waitingForPreferred
    ? undefined
    : (picked ??
      (playlist.some((file) => file.id === preferred) ? preferred : null) ??
      playlist[0]?.id)
  const index = playlist.findIndex((file) => file.id === selected)
  // Fetch the next metadata page ahead of the ordered transition; this never reads media bytes
  useEffect(() => {
    if (
      pages.hasNextPage &&
      !pages.isFetchingNextPage &&
      !pages.isFetchNextPageError &&
      (index >= playlist.length - 3 ||
        (preferred && !playlist.some((file) => file.id === preferred)))
    ) {
      void pages.fetchNextPage()
    }
  }, [index, playlist, preferred, pages])
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
    if (!bundleId || !selected) return
    void replicaRequest(library, `/media/bundles/${bundleId}/cursor`, 'PUT', {
      file_id: selected,
    }).catch(() => undefined)
  }, [bundleId, library, selected])
  const items = useMemo(
    () =>
      playlist.map((file) => {
        const value = file.id === observation?.file.id ? observation : null
        const item = viewerItemFromFile(value?.file ?? file)
        const token = value?.generation
        return {
          ...item,
          key: `${file.id}:${token ?? 'unobserved'}`,
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
      }),
    [playlist, observation],
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
    if (!bundleId && target.fileId) await initial.refetch()
    await pages.refetch()
    if (selected) await local.refetch()
  }, [bundleId, initial, local, pages, selected, target.fileId])
  const mediaError =
    local.data?.state === 'available' && local.data.message ? new Error(local.data.message) : null
  return (
    <ViewerShell
      items={items}
      index={index}
      onIndex={(next) => setPicked(playlist[next]?.id ?? null)}
      playable={playable}
      title={first?.title ?? 'Local replica media'}
      artworkUrl=""
      playerPrefs={prefs}
      onPlayerPrefs={setPrefs}
      onClose={onClose}
      loading={
        (!bundleId && initial.isPending) ||
        pages.isPending ||
        Boolean(waitingForPreferred) ||
        (Boolean(selected) && !local.isFetchedAfterMount)
      }
      error={initial.error ?? pages.error ?? local.error ?? mediaError}
      emptyMessage={
        !pages.isPending && !playlist.length
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
