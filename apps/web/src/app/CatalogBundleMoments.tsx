import { useMemo } from 'react'

import type { FileRead } from '../api/client'
import {
  BundleInspectorActionsContext,
  useMergedBundleInspectorActions,
} from './bundleInspectorActions'
import { Moments } from './Moments'
import { MomentSourceContext } from './momentSource'
import { useCatalogMomentSource } from './useCatalogMomentSource'

/**
 * The browser inspector's moments: the viewer rail's list without a playhead.
 *
 * Play from opens the viewer at the moment. Moments are catalog rows of their
 * own, so a comment, tag or delete here never touches the bundle draft that
 * this inspector owns.
 */
export function CatalogBundleMoments({
  library,
  bundle,
  onPlay,
  onLoop,
}: {
  library: string
  bundle: string
  onPlay: (file: string, time: number) => void
  onLoop?: (file: string, range: { start: number; end: number }) => void
}) {
  const { version, source, files } = useCatalogMomentSource(library, bundle)
  const overrides = useMemo(
    () => ({
      onPlayMoment: (_bundle: string, file: string, time: number) => onPlay(file, time),
      ...(onLoop
        ? {
            onLoopMoment: (_bundle: string, file: string, range: { start: number; end: number }) =>
              onLoop(file, range),
          }
        : {}),
    }),
    [onLoop, onPlay],
  )
  const actions = useMergedBundleInspectorActions(overrides)
  if (version < 4) return null
  return (
    <MomentSourceContext value={source}>
      <BundleInspectorActionsContext value={actions}>
        <Moments bundleId={bundle} files={files} />
      </BundleInspectorActionsContext>
    </MomentSourceContext>
  )
}

/**
 * Moments scoped to one inspected video file in the File Inspector sidebar.
 * Renders nothing when the file is not a video or has no saved moments.
 */
export function CatalogFileMoments({
  library,
  bundle,
  file,
  onPlay,
  onLoop,
  onFilterTag,
}: {
  library: string
  bundle: string
  file: FileRead
  onPlay?: (bundleId: string, fileId: string, time: number) => void
  onLoop?: (bundleId: string, fileId: string, range: { start: number; end: number }) => void
  onFilterTag?: (tagId: string) => void
}) {
  const { version, source } = useCatalogMomentSource(
    library,
    file.media_kind === 'video' ? bundle : null,
  )
  const files = useMemo(() => [file], [file])
  const overrides = useMemo(
    () => ({
      ...(onPlay ? { onPlayMoment: onPlay } : {}),
      ...(onLoop ? { onLoopMoment: onLoop } : {}),
      ...(onFilterTag
        ? {
            onFilterByTags: (tagIds: string[]) => {
              if (tagIds[0]) onFilterTag(tagIds[0])
            },
          }
        : {}),
    }),
    [onPlay, onLoop, onFilterTag],
  )
  const actions = useMergedBundleInspectorActions(overrides)
  if (version < 1 || file.media_kind !== 'video') return null
  return (
    <MomentSourceContext value={source}>
      <BundleInspectorActionsContext value={actions}>
        <Moments bundleId={bundle} files={files} />
      </BundleInspectorActionsContext>
    </MomentSourceContext>
  )
}
