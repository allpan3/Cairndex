import { useMemo } from 'react'

import { type FileBrowserEntry, type PlayableVideo } from '../api/client'
import { usePlaybackManifest } from '../api/hooks'
import type { PlayerPrefs } from './types'
import { ViewerShell } from './viewer/ViewerShell'
import { type ViewerItem, viewerItemFromEntry } from './viewer/viewerItem'

/**
 * Fullscreen media viewer for the read-only File Browser.
 *
 * This drives the same `ViewerShell` as the Bundle Browser, so a video here gets
 * the app's real player — custom controls, keyboard map, HLS fallback, resume —
 * rather than the browser's native controls. Two things stay specific to this
 * surface:
 *
 * - The playlist is the *folder*, not a bundle. Stepping (chevrons, Cmd+[/]) walks
 *   the openable entries the File Browser is showing, which is why this component
 *   owns the index rather than handing the shell a bundle to derive one from.
 * - An entry need not be indexed. A linked path resolves its real manifest entry
 *   and behaves exactly like the bundle viewer; an unlinked path gets a direct
 *   entry pointing at the path-scoped reader, which plays natively without
 *   subtitles, storyboards, chapters, or saved progress — there is no file row to
 *   hang those on.
 */
export function FileEntryViewer({
  files,
  index,
  onIndex,
  onClose,
  title,
  playerPrefs,
  onPlayerPrefs,
}: {
  files: FileBrowserEntry[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  /** Topbar heading — the folder being browsed. */
  title: string
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
}) {
  const items = useMemo(() => files.map(viewerItemFromEntry), [files])
  const current = items[index] ?? null
  const isVideo = current?.mediaKind === 'video'

  // Only an indexed video has a manifest to read, and only a video needs one.
  const manifestBundleId = isVideo && current?.fileId ? current.bundleId : null
  const { data: manifest, isLoading: manifestLoading } = usePlaybackManifest(manifestBundleId)

  const playable = useMemo<PlayableVideo | null>(() => {
    if (!current || !isVideo) return null
    const indexed = current.fileId
      ? (manifest?.videos.find((video) => video.file_id === current.fileId) ?? null)
      : null
    if (indexed) return indexed
    // Still waiting on the manifest that will supply the real entry.
    if (manifestBundleId && manifestLoading) return null
    return directEntry(current)
  }, [current, isVideo, manifest?.videos, manifestBundleId, manifestLoading])

  return (
    <ViewerShell
      items={items}
      index={index}
      onIndex={onIndex}
      playable={playable}
      title={title}
      // A File Browser row has no cover image to use as MediaSession artwork.
      artworkUrl=""
      playerPrefs={playerPrefs}
      onPlayerPrefs={onPlayerPrefs}
      onClose={onClose}
      errorHeading="Couldn’t load this file."
      emptyMessage={items.length === 0 ? 'Nothing here can be previewed.' : null}
    />
  )
}

/**
 * A direct-play entry for a path with no usable manifest row.
 *
 * Covers both an unindexed path and an indexed one the manifest doesn't list
 * (e.g. never probed). `playable: true` defers the verdict to the media element:
 * if the browser can't decode the container/codec, the stage's error path shows
 * the same "can't play this" card a failed decision would.
 */
function directEntry(item: ViewerItem): PlayableVideo {
  return {
    file_id: item.fileId ?? '',
    display_title: item.title,
    playable: true,
    reason: '',
    mime_type: item.mimeType ?? '',
    stream_url: item.contentUrl,
    width: item.width,
    height: item.height,
    duration: item.duration,
    storyboard_url: null,
    chapters: [],
    progress: null,
    subtitles: [],
  }
}
