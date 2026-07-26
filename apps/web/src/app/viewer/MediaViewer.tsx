import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { thumbnailUrl } from '../../api/client'
import {
  useBundle,
  useBundleCursor,
  useBundleFiles,
  useFileMutations,
  usePlaybackManifest,
} from '../../api/hooks'
import type { PlayerPrefs } from '../types'
import { ViewerShell, type ShellCoverActions } from './ViewerShell'
import { viewerItemFromFile } from './viewerItem'

interface MediaViewerProps {
  bundleId: string
  initialFileId?: string | null
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onClose: () => void
}

/**
 * Bundle media lightbox: resolves a bundle's playlist, playback manifest, and
 * bundle-scoped affordances, then hands them to the shared `ViewerShell`. The
 * File Browser drives the same shell from a directory listing instead — see
 * `FileEntryViewer`.
 */
export function MediaViewer({
  bundleId,
  initialFileId,
  playerPrefs,
  onPlayerPrefs,
  onClose,
}: MediaViewerProps) {
  const qc = useQueryClient()
  const fileMutations = useFileMutations(bundleId)
  const { mutate: rememberCursor } = useBundleCursor(bundleId)
  const rememberedCursorRef = useRef<string | null>(null)
  const { data: bundle, isLoading: bundleLoading, error: bundleError } = useBundle(bundleId)
  const { data: files = [], isLoading: filesLoading, error: filesError } = useBundleFiles(bundleId)
  const {
    data: manifest,
    isLoading: playbackLoading,
    error: playbackError,
  } = usePlaybackManifest(bundleId)
  const hasMissingFiles = files.some((file) => file.availability !== 'available')
  const [pickedId, setPickedId] = useState<string | null>(null)

  const playlistFiles = useMemo(
    () =>
      files.filter(
        (file) => file.supported && (file.media_kind === 'image' || file.media_kind === 'video'),
      ),
    [files],
  )
  const items = useMemo(() => playlistFiles.map(viewerItemFromFile), [playlistFiles])
  const preferredId = bundle
    ? ((initialFileId && playlistFiles.some((file) => file.id === initialFileId)
        ? initialFileId
        : null) ??
      (bundle.resume_file_id && playlistFiles.some((file) => file.id === bundle.resume_file_id)
        ? bundle.resume_file_id
        : null) ??
      playlistFiles.find((file) => file.availability === 'available')?.id ??
      playlistFiles[0]?.id ??
      null)
    : null
  const selectedId =
    pickedId && playlistFiles.some((file) => file.id === pickedId) ? pickedId : preferredId
  const currentIndex = selectedId ? playlistFiles.findIndex((file) => file.id === selectedId) : -1
  const current = currentIndex >= 0 ? playlistFiles[currentIndex] : null
  const currentId = current?.id ?? null

  useEffect(() => {
    rememberedCursorRef.current = null
  }, [bundleId])
  useEffect(() => {
    if (
      !currentId ||
      current?.availability !== 'available' ||
      rememberedCursorRef.current === currentId
    )
      return
    rememberedCursorRef.current = currentId
    rememberCursor(currentId)
  }, [current?.availability, currentId, rememberCursor])

  const playable = useMemo(
    () => manifest?.videos.find((video) => video.file_id === currentId) ?? null,
    [currentId, manifest?.videos],
  )

  // Bundle reads can persist a newly missing path, so refresh its library views
  useEffect(() => {
    if (!hasMissingFiles) return
    qc.invalidateQueries({ queryKey: ['view-counts'] })
    qc.invalidateQueries({ queryKey: ['browse'] })
  }, [hasMissingFiles, qc])

  const onIndex = useCallback(
    (index: number) => setPickedId(playlistFiles[index]?.id ?? null),
    [playlistFiles],
  )

  const cover = useMemo<ShellCoverActions | null>(() => {
    if (!currentId) return null
    return {
      onUseFrame: (time: number) => fileMutations.setCoverFrame.mutate({ fileId: currentId, time }),
      onClear: () => fileMutations.clearCoverFrame.mutate(currentId),
    }
  }, [currentId, fileMutations.clearCoverFrame, fileMutations.setCoverFrame])

  const loading =
    bundleLoading || filesLoading || (current?.media_kind === 'video' && playbackLoading)
  const error =
    bundleError ?? filesError ?? (current?.media_kind === 'video' ? playbackError : null)
  const emptyMessage =
    files.length === 0
      ? 'This bundle has no files.'
      : items.length === 0
        ? 'This bundle has no previewable media.'
        : null

  return (
    <ViewerShell
      items={items}
      index={currentIndex}
      onIndex={onIndex}
      playable={playable}
      title={bundle?.title ?? current?.display_title ?? 'Media'}
      artworkUrl={thumbnailUrl(bundleId, bundle?.updated_at ?? null)}
      playerPrefs={playerPrefs}
      onPlayerPrefs={onPlayerPrefs}
      onClose={onClose}
      loading={loading}
      error={error}
      errorHeading="Couldn’t load this bundle."
      emptyMessage={emptyMessage}
      cover={cover}
    />
  )
}
