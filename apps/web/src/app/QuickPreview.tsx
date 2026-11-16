import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { thumbnailUrl } from '../api/client'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { playlistFor } from './bundleRows'
import type { BundleCardItem } from './BundleCard'
import { viewerItemFromFile } from './viewer/viewerItem'

type Playlist = components['schemas']['ReplicaPlaylist']

/**
 * A light look at one bundle inside the window, as Eagle's Space preview: its
 * current file, an image at viewing size or a video playing at once, with the
 * bundle's place in the whole result set. Space or Escape closes it, the
 * arrows step through the results and Enter opens the full viewer.
 *
 * A look is not an opening: it reads the bundle's file list and streams the
 * file, but moves no cursor and records no Date Opened.
 */
export function QuickPreview({
  library,
  item,
  position,
  total,
  onStep,
  onOpen,
  onClose,
}: {
  library: string
  item: BundleCardItem
  /** The bundle's 0-based place in the complete result set */
  position: number
  total: number
  onStep: (delta: number) => void
  onOpen: () => void
  onClose: () => void
}) {
  // Read once per bundle: a step back reuses what an earlier look read
  const playlist = useQuery({
    queryKey: ['quick-preview', library, item.id],
    queryFn: ({ signal }) =>
      replicaRequest<Playlist>(
        library,
        `/media/bundles/${item.id}?offset=0`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
    staleTime: 30_000,
  })
  const page = playlist.data
  const files = page ? playlistFor(page.files, page.directories) : []
  const file = files.find((candidate) => candidate.id === page?.cursor) ?? files[0] ?? null
  const media = file ? viewerItemFromFile(file) : null
  const cover = item.has_cover ? thumbnailUrl(item.id, item.cover_key) : null
  const image =
    media?.mediaKind === 'image'
      ? (media.imageTiers.find((tier) => tier.tier === 'original' || tier.tier === 'preview1600')
          ?.src ?? null)
      : null
  const [failed, setFailed] = useState<string | null>(null)
  const actions = useRef({ onStep, onOpen, onClose })
  useLayoutEffect(() => {
    actions.current = { onStep, onOpen, onClose }
  })
  // Ahead of every other handler: the grid's own Space, arrows and Escape, and
  // a focused video's native Space, must not also act
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
      if (step === undefined && ![' ', 'Escape', 'Enter'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat && step === undefined) return
      if (step !== undefined) actions.current.onStep(step)
      else if (event.key === 'Enter') actions.current.onOpen()
      else actions.current.onClose()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [])
  const video = useRef<HTMLVideoElement | null>(null)
  const videoSource = media?.mediaKind === 'video' ? media.contentUrl : null
  // With sound when the platform allows it, else muted rather than not at all
  useEffect(() => {
    const element = video.current
    if (!element || !videoSource) return
    element.play().catch(() => {
      element.muted = true
      void element.play().catch(() => undefined)
    })
  }, [videoSource])
  // Nothing to preview or open: say so rather than point at the viewer
  const empty = playlist.isSuccess && files.length === 0
  const unavailable =
    playlist.isError ||
    (playlist.isSuccess && !media) ||
    (failed !== null && failed === (videoSource ?? image))
  return (
    <div
      className="quick-preview"
      role="dialog"
      aria-modal="true"
      aria-label="Quick preview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="quick-preview__bar">
        <span className="quick-preview__title">{item.title ?? 'Untitled'}</span>
        <span className="quick-preview__count" aria-label="Position in results">
          {position + 1} / {total}
        </span>
        <button className="btn btn--sm" onClick={onOpen}>
          Open
        </button>
        <button className="quick-preview__close" aria-label="Close preview" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className="quick-preview__stage"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {cover && (!videoSource || unavailable) && (
          <img className="quick-preview__media quick-preview__cover" src={cover} alt="" />
        )}
        {image && !unavailable && (
          <img
            key={image}
            className="quick-preview__media"
            src={image}
            alt={item.title ?? 'Bundle image'}
            decoding="async"
            draggable={false}
            onError={() => setFailed(image)}
          />
        )}
        {videoSource && !unavailable && (
          <video
            key={videoSource}
            ref={video}
            className="quick-preview__media"
            src={videoSource}
            poster={cover ?? undefined}
            controls
            playsInline
            onError={() => setFailed(videoSource)}
          />
        )}
        {unavailable && (
          <p className="quick-preview__note">
            {empty
              ? 'This bundle has no files.'
              : 'This file has no quick preview here. Press Enter to open it in the viewer.'}
          </p>
        )}
      </div>
      <button
        className="quick-preview__step quick-preview__step--back"
        aria-label="Previous"
        disabled={position === 0}
        onClick={() => onStep(-1)}
      >
        ‹
      </button>
      <button
        className="quick-preview__step quick-preview__step--next"
        aria-label="Next"
        disabled={position >= total - 1}
        onClick={() => onStep(1)}
      >
        ›
      </button>
    </div>
  )
}
