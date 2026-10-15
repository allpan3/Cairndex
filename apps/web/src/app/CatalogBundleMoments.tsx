import { useMemo } from 'react'

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
}: {
  library: string
  bundle: string
  onPlay: (file: string, time: number) => void
}) {
  const { version, source, files } = useCatalogMomentSource(library, bundle)
  const overrides = useMemo(
    () => ({
      onPlayMoment: (_bundle: string, file: string, time: number) => onPlay(file, time),
    }),
    [onPlay],
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
