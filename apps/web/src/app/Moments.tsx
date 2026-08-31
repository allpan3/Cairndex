import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  fileStoryboardUrl,
  fileStreamUrl,
  momentClipUrl,
  momentPosterUrl,
  type FileRead,
  type Moment,
} from '../api/client'
import { useMomentMutations, useMoments } from '../api/hooks'
import { useBundleInspectorActions } from './bundleInspectorActions'
import { InspectorSection } from './InspectorSection'
import { clearCapturedMoment, useJustSavedMoment } from './momentCapture'
import { ContextMenu } from './ContextMenu'
import { IconMore, IconPlay, IconPlus, IconRepeat } from './icons'
import { TagPicker } from './TagEditor'
import { useContextMenu, type MenuEntry } from './useContextMenu'
import { cueForTime, type StoryboardCue } from './viewer/player/storyboardVtt'
import { formatClock } from '../lib/format'
import { StoryboardTile } from './viewer/player/StoryboardPreview'
import { useStoryboardCues } from './viewer/player/useStoryboardCues'

/**
 * The instants and spans the owner marked inside this bundle's videos (plan 7).
 *
 * One line per moment when it has nothing else to say; it grows only for the
 * tags and the comment it actually has. A range moment is a loop, so its
 * row can arm the range loop directly — which is the whole of "saved loops".
 *
 * The section is rendered on both inspector surfaces, but the three abilities
 * that need a playhead (capture, arm, update-to-marks) come from
 * `BundleInspectorActions.moments`, which only the viewer supplies. So the
 * shell's rail reads moments back and edits them, but does not offer to mark
 * one — and when there are none to read, it shows nothing at all.
 */
export function Moments({ bundleId, files }: { bundleId: string; files: FileRead[] }) {
  const { data: moments = [] } = useMoments(bundleId)
  const { onPlayMoment, onFilterByTags, moments: player } = useBundleInspectorActions()
  const mutations = useMomentMutations(bundleId)
  const menu = useContextMenu()
  // The moment saved by the most recent capture, so its row opens straight into
  // its comment box (owner, 2026-08-29): the thing you want to write down is
  // freshest at the instant you mark it, and hunting for the new row first is
  // what loses it.
  //
  // Only in the rail that has a player. Both rails are mounted while the viewer
  // is up, and the capture came from the player — so this is the rail the owner
  // is looking at, and it also keeps the store to one consumer, which is what
  // lets a row clear it on the way in without racing the other rail for it.
  const captured = useJustSavedMoment(bundleId)
  const justSaved = player ? captured : null

  const videos = useMemo(() => files.filter((file) => file.media_kind === 'video'), [files])
  // Grouped by file, in the bundle's own file order, with each group still in
  // time order — `files` arrives sequence-ordered and the moments arrive
  // start-ordered, so neither needs re-sorting here.
  const groups = useMemo(() => {
    const byFile = new Map<string, Moment[]>()
    for (const moment of moments) {
      const list = byFile.get(moment.file_id)
      if (list) list.push(moment)
      else byFile.set(moment.file_id, [moment])
    }
    return videos
      .filter((file) => byFile.has(file.id))
      .map((file) => ({ file, moments: byFile.get(file.id) ?? [] }))
  }, [moments, videos])

  // What the groups above will actually draw, which is not always every moment
  // the bundle holds: a *trashed* video keeps its moments (so Put back restores
  // them with it) but drops out of the rail's file list. The header counts what
  // is on screen rather than what is stored, so the number and the rows agree.
  const shown = groups.reduce((total, group) => total + group.moments.length, 0)

  // A bundle with no video has nothing this section could describe.
  if (videos.length === 0) return null
  // Nothing to show, and no playhead to mark something with: the section is
  // absent rather than an empty heading with a hint nobody in this pane can act
  // on. The shell's rail would otherwise carry the invitation — and its height —
  // permanently, on every video bundle, which is the opposite of compact.
  if (shown === 0 && !player) return null

  return (
    <>
      <InspectorSection
        id="moments"
        title={<>Moments{shown > 0 && <span className="moment-count">{shown}</span>}</>}
        actions={
          player && (
            <button
              className="moment-add"
              onClick={player.capture}
              aria-label="Mark a moment at the playhead"
              title="Mark a moment at the playhead (B)"
            >
              <IconPlus />
            </button>
          )
        }
      >
        <ContextMenu state={menu.state} onClose={menu.close} />
        {shown === 0 ? (
          <p className="moment-empty">
            Press <kbd>B</kbd> to mark this frame, or mark a range and save that.
          </p>
        ) : (
          <div className="moment-list">
            {groups.map(({ file, moments: rows }) => (
              <section className="moment-group" key={file.id}>
                {/* Only when there is more than one video to tell apart. */}
                {groups.length > 1 && (
                  <div className="moment-group__file" title={file.relative_path}>
                    {file.display_title}
                  </div>
                )}
                {rows.map((moment) => (
                  <MomentRow
                    key={moment.id}
                    bundleId={bundleId}
                    moment={moment}
                    playable={file.supported === true}
                    startEditing={moment.id === justSaved}
                    mutations={mutations}
                    onPlay={onPlayMoment}
                    onFilterByTags={onFilterByTags}
                    player={player}
                    onMenu={menu.open}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </InspectorSection>
    </>
  )
}

type Mutations = ReturnType<typeof useMomentMutations>

/** How far the hover preview sits off the row it belongs to. */
const PREVIEW_GAP = 6

/**
 * Where a moment starts, and how long it runs when it is a range.
 *
 * Seconds, not the range bar's `M:SS.mmm` (owner, 2026-08-29): milliseconds are
 * what *placing* an edge needs, and a list you scan to find a moment reads
 * better without three digits of noise on every row. The stored value keeps its
 * precision — only the label rounds.
 *
 * A range shows its start and its length, not both ends: the second end is the
 * sum of the two, so printing it spends the row's width saying the same thing
 * twice (owner, 2026-08-30).
 */
function describeMoment(moment: Moment): { time: string; length: string | null } {
  const start = formatClock(moment.start_s)
  if (moment.end_s === null) return { time: start, length: null }
  return { time: start, length: `${(moment.end_s - moment.start_s).toFixed(1)}s` }
}

function MomentRow({
  bundleId,
  moment,
  playable,
  startEditing,
  mutations,
  onPlay,
  onFilterByTags,
  player,
  onMenu,
}: {
  bundleId: string
  moment: Moment
  /** The browser can decode this moment's file, so its span can play on hover. */
  playable: boolean
  /** This row was just captured: open its comment box without being asked. */
  startEditing: boolean
  mutations: Mutations
  onPlay: ((bundleId: string, fileId: string, at: number) => void) | undefined
  onFilterByTags: ((tagIds: string[]) => void) | undefined
  player: ReturnType<typeof useBundleInspectorActions>['moments']
  onMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void
}) {
  const [editingComment, setEditingComment] = useState(startEditing)
  // The row's box while the pointer is over it, for placing the preview.
  const [hover, setHover] = useState<DOMRect | null>(null)
  // Consumed: coming back to this bundle later must not reopen the editor.
  useEffect(() => {
    if (startEditing) clearCapturedMoment(moment.id)
  }, [moment.id, startEditing])
  const { time, length } = describeMoment(moment)
  const isRange = moment.end_s !== null
  const range = isRange ? { start: moment.start_s, end: moment.end_s as number } : null
  // A range on a file the browser can decode plays itself on hover. `supported`
  // is the same flag the grid's card preview gates on: anything needing the
  // player's remux keeps the still tile rather than dragging that machinery into
  // a hover.
  const playableSpan =
    range && playable
      ? {
          clipUrl: momentClipUrl(moment.bundle_id, moment.id, moment.version),
          streamUrl: fileStreamUrl(moment.file_id),
          ...range,
        }
      : null

  // The thumbnail is a storyboard tile — the sheet already exists for every
  // scanned video, and the crop is the same one the seek-bar tooltip does. No
  // endpoint, no cache, no ffmpeg on the request path (plan 7 §4.3). Not
  // treated as immutable: the URL is versioned by a constant rather than by the
  // file's fingerprint, so a video whose storyboard is generated later picks its
  // tile up on the next refetch instead of never.
  const storyboardUrl = fileStoryboardUrl(moment.file_id)
  const { data: cues } = useStoryboardCues(storyboardUrl, true, false)
  const cue = useMemo(() => cueForTime(cues, moment.start_s)?.cue ?? null, [cues, moment.start_s])

  const openMenu = (event: React.MouseEvent) => {
    // Two entries, deliberately. "Update to Range Marks" was here to move a
    // saved span without losing its tags and comment, and the owner's answer was
    // the right one: re-marking *is* the gesture, and a moment cheap enough to
    // delete and re-make does not need an edit path of its own (2026-08-30).
    onMenu(event, [
      {
        label: moment.comment ? 'Edit Comment…' : 'Add Comment…',
        onClick: () => setEditingComment(true),
      },
      null,
      {
        label: 'Delete Moment',
        danger: true,
        onClick: () => mutations.remove.mutate(moment.id),
      },
    ])
  }

  return (
    <div
      className="moment-row"
      role="listitem"
      onContextMenu={openMenu}
      // The frame is a hover tooltip rather than a column of thumbnails: at 48px
      // a row, a stack of them made the rail bulky for a picture you only want
      // while deciding which moment this is (owner, 2026-08-29). Nothing here
      // costs layout until the pointer asks.
      onPointerEnter={(event) => setHover(event.currentTarget.getBoundingClientRect())}
      onPointerLeave={() => setHover(null)}
    >
      {hover && (
        // Always something to show now: every moment has a poster of its own,
        // where this used to need a storyboard cue, a playable span, or a comment.
        <MomentPreview
          anchor={hover}
          // A span deserves to move, so a range plays itself; a frame rests on
          // its poster (owner, 2026-08-29 and 2026-08-30).
          span={playableSpan}
          posterUrl={momentPosterUrl(moment.bundle_id, moment.id, moment.version)}
          storyboardUrl={storyboardUrl}
          cue={cue}
          comment={moment.comment}
        />
      )}
      <div className="moment-row__body">
        <div className="moment-row__line">
          <span className="moment-row__time">{time}</span>
          {length && <span className="moment-row__length">{length}</span>}
          {/* Tags share the first line: there is usually one, and a line of its
              own for one pill made every moment three rows tall (owner,
              2026-08-30). The region is width-capped and clips rather than
              wrapping, so a moment with many tags costs the same height as one
              with a single tag — the full set is still in the picker. */}
          <div className="moment-row__tags">
            <TagPicker
              addLabel="+"
              addAriaLabel="Add tag"
              // One tag in full and a count for the rest: a pill clipped against
              // the edge of the region read as a rendering fault rather than as
              // "there is more" (owner, 2026-08-30).
              maxChips={1}
              assignment={{
                assigned: moment.tag_ids,
                onSetTags: (ids) => mutations.setTags.mutate({ momentId: moment.id, ids }),
                removeLabel: 'Remove from This Moment',
              }}
              onFilterByTags={onFilterByTags}
            />
          </div>
          <button
            className="moment-row__act"
            onClick={() => onPlay?.(bundleId, moment.file_id, moment.start_s)}
            disabled={!onPlay}
            aria-label={`Play from ${time}`}
            title="Play from here"
          >
            <IconPlay />
          </button>
          {range && (
            <button
              className="moment-row__act"
              onClick={() => player?.loop(moment.file_id, range)}
              disabled={!player}
              aria-label={`Range loop from ${time}`}
              title={
                player
                  ? 'Range loop: keep playback inside this span'
                  : 'A range loop needs the player — open this bundle to loop a span'
              }
            >
              <IconRepeat />
            </button>
          )}
          <button
            className="moment-row__act"
            onClick={(event) => openMenu(event)}
            aria-label={`Moment actions for ${time}`}
            title="More"
          >
            <IconMore />
          </button>
        </div>
        {editingComment ? (
          <CommentBox
            value={moment.comment ?? ''}
            onCancel={() => setEditingComment(false)}
            onCommit={(next) => {
              setEditingComment(false)
              if (next === (moment.comment ?? '')) return
              mutations.update.mutate({
                momentId: moment.id,
                patch: { comment: next },
                version: moment.version,
              })
            }}
          />
        ) : (
          moment.comment && (
            <button
              className="moment-row__comment"
              onClick={() => setEditingComment(true)}
              // The row clamps a comment to one line; the hover preview above
              // shows it in full, and this is the same text for a pointer that
              // rests on the line itself (owner, 2026-08-30).
              title={moment.comment}
            >
              {moment.comment}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/**
 * How long the pointer must rest on a row before its span starts playing. The
 * still frame is there immediately; this only delays the *video*, so sweeping
 * down the list does not open a stream per row.
 *
 * It is deliberately short, because it is paid *before* the network work rather
 * than alongside it: nothing loads until it elapses, so every millisecond here
 * lands directly on the wait before the span moves. Measured on a 1080p/30fps
 * h264 file (2026-08-30), hover to first moving frame broke down as 220ms here,
 * ~20ms for the header, 14-123ms to seek, then the fade — so this constant alone
 * was over half of it. A sweep crosses a 48px row well inside 100ms, which is
 * all the filtering it has to do.
 */
const PREVIEW_PLAY_DELAY_MS = 100

/**
 * The frame for the row under the pointer, drawn directly above it.
 *
 * Above and the row's own width (owner, 2026-08-30), which also means it never
 * has to guess how much room is off to one side — the rail is against the right
 * edge of the window, and a preview beside it had nowhere to go on a narrow
 * one. It flips below only when the row is too near the top of the screen.
 *
 * Portalled to the body and fixed-positioned, because the rail scrolls and
 * clips: a preview that scrolled away with its row, or was cut off by the rail's
 * edge, would be worse than none. That is also why it is a *fixed* size derived
 * from the row rather than from the image — the picture letterboxes inside it,
 * so a storyboard that has not loaded cannot resize the box under the pointer.
 */
function MomentPreview({
  anchor,
  span,
  posterUrl,
  storyboardUrl,
  cue,
  comment,
}: {
  anchor: DOMRect
  /**
   * The span to play, for a range on a file the browser can decode. Null for a
   * frame, or a source that needs the player's remux — both show the still tile.
   */
  span: { clipUrl: string; streamUrl: string; start: number; end: number } | null
  /** The frame this moment marks, decoded server-side. The honest still. */
  posterUrl: string
  storyboardUrl: string
  cue: StoryboardCue | null
  /** The moment's comment in full, which the row itself can only clamp. */
  comment: string | null
}) {
  const width = anchor.width
  const height = Math.round((width * 9) / 16)
  // Anchored by the edge nearest the row, so the box grows *away* from it and a
  // comment of any length can never reach back over the row it belongs to. The
  // comment used to hang below the picture and cover the row's own controls
  // (owner, 2026-08-30). Placed above unless the row is too near the top to fit
  // the picture, in which case it grows downward instead.
  const fitsAbove = anchor.top - height - PREVIEW_GAP >= PREVIEW_GAP
  const placement = fitsAbove
    ? { bottom: window.innerHeight - anchor.top + PREVIEW_GAP }
    : { top: anchor.bottom + PREVIEW_GAP }
  return createPortal(
    <div
      className="moment-preview"
      data-testid="moment-preview"
      style={{ ...placement, left: anchor.left, width }}
      aria-hidden="true"
    >
      <div className="moment-preview__frame" style={{ height }}>
        {/* Three layers, each replacing the one under it as it arrives.
            
            The storyboard tile is the bottom and the least accurate: it is
            already in memory, so there is a picture from the first frame the
            pointer rests, but the sheet is sampled every 2 to 30 seconds and
            holds the frame at the *start* of the interval containing the mark —
            up to half a minute before the moment on a long video. That is what
            the owner kept seeing (2026-08-30, twice: "the initial frame is not
            part of the range").

            The poster is the same picture done properly: one frame decoded at
            the marked instant, queued when the moment was saved, so normally it
            is simply there. It covers a frame moment, which has no third layer.

            The clip is the third, for a span, and its own first frame is the
            in-point too — so once the poster is in place nothing in this stack
            shows the wrong frame at any point. */}
        {cue && (
          <StoryboardTile
            storyboardUrl={storyboardUrl}
            cue={cue}
            fill
            fillClassName="moment-preview__tile"
          />
        )}
        <MomentPoster url={posterUrl} />
        {span && <SpanPlayback span={span} />}
      </div>
      {comment && <p className="moment-preview__comment">{comment}</p>}
    </div>,
    document.body,
  )
}

/**
 * The frame a moment marks, over whatever the storyboard could guess at.
 *
 * Hidden until it has actually loaded, so a 404 — which is what the server says
 * while the frame is still being decoded — leaves the tile underneath visible
 * rather than punching a hole in the preview.
 */
function MomentPoster({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      className={`moment-preview__poster${loaded ? ' is-ready' : ''}`}
      data-testid="moment-preview-poster"
      src={url}
      alt=""
      onLoad={() => setLoaded(true)}
      onError={() => setLoaded(false)}
    />
  )
}

/**
 * The span itself, playing on loop over the still tile.
 *
 * Two sources, in order of preference. The first is a **pre-cut clip** of just
 * this span, built once in the background and cached: it plays from byte 0, so
 * there is no header round trip, no seek, and no decoding forward from the
 * preceding keyframe — and its first frame is the marked in-point rather than
 * the nearest storyboard tile, which is sampled on a 2-to-30 second grid and so
 * is usually from *before* the range (owner-reported, 2026-08-30: "the first
 * frame shown in the preview is not even part of the range"). `loop` is free
 * for the same reason, where seeking back to the in-point paid the decode again
 * on every repeat.
 *
 * The second is the original, streamed and seeked — what this did on its own
 * before, and now the fallback. The clip route answers 404 until the cut lands,
 * and the request is what queues it, so the first hover of a moment looks
 * exactly like it used to and every hover after it is fast. That is also why
 * the cache is disposable: emptying `.cairndex/cache/` costs the wait it started
 * with, not the feature.
 *
 * Held back by `PREVIEW_PLAY_DELAY_MS` so sweeping the list does not fetch per
 * row, and mounted *over* the tile so the swap has no black frame. A source the
 * browser cannot decode never mounts one at all — that is the player's remux
 * path, far too much machinery for a hover.
 */
function SpanPlayback({
  span,
}: {
  span: { clipUrl: string; streamUrl: string; start: number; end: number }
}) {
  const [ready, setReady] = useState(false)
  const [armed, setArmed] = useState(false)
  // The clip is tried first and demoted on error, which is the 404 it answers
  // while the cut is still queued. Keyed by span so a different row starts
  // hopeful again rather than inheriting this one's verdict.
  const [source, setSource] = useState<'clip' | 'stream'>('clip')
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), PREVIEW_PLAY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  if (!armed) return null

  const shared = {
    className: `moment-preview__video${ready ? ' is-ready' : ''}`,
    'data-testid': 'moment-preview-video',
    muted: true,
    playsInline: true,
    // Only shown once it has a frame, so the tile underneath is never replaced
    // by a black box mid-load.
    onPlaying: () => setReady(true),
  } as const

  if (source === 'clip') {
    return (
      <video
        {...shared}
        data-source="clip"
        src={span.clipUrl}
        // Small, faststart, and starting where it should: nothing to arrange
        // before playing, and looping needs no seek.
        autoPlay
        loop
        preload="auto"
        onError={() => {
          setReady(false)
          setSource('stream')
        }}
      />
    )
  }

  return (
    <video
      {...shared}
      data-source="stream"
      src={span.streamUrl}
      preload="metadata"
      // Start at the in-point rather than at the file's, and keep to the span:
      // `loop` would replay the whole video, which is not what was marked.
      //
      // Playing is asked for on `canplay`, not here: setting `currentTime`
      // starts a seek, and a `play()` issued into that seek is cancelled by it —
      // the element sat at the in-point, paused, with the data already buffered.
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = span.start
      }}
      onCanPlay={(event) => void event.currentTarget.play().catch(() => undefined)}
      onTimeUpdate={(event) => {
        if (event.currentTarget.currentTime < span.end) return
        event.currentTarget.currentTime = span.start
      }}
      onError={() => setReady(false)}
    />
  )
}

/** One moment's comment, edited in place. Auto-grows from a single line, commits
 *  on blur, and abandons the edit on Escape — the same contract as a note box,
 *  without the drag grip and saved height a stack of them needs. */
function CommentBox({
  value,
  onCommit,
  onCancel,
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)

  /**
   * Take focus on open, and hand it back on close.
   *
   * Taking it is the point: a capture opens this box so the note can be typed
   * straight away. Handing it back is what keeps the player usable afterwards —
   * the viewer's keyboard map is bound to the viewer element, so a focus left on
   * `body` after the box closed made every shortcut dead until the owner clicked
   * the video again. Focused here rather than with `autoFocus` so the element
   * that had focus is read *before* this one takes it.
   *
   * The hand-back hangs off the close paths, deliberately **not** off this
   * effect's cleanup. StrictMode double-invokes mount effects, so a cleanup that
   * moved focus blurred the box it had just focused — and a blur commits and
   * closes it, so the editor vanished the instant it opened.
   */
  const returnTo = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    if (previous instanceof HTMLElement && previous !== ref.current) returnTo.current = previous
    ref.current?.focus()
  }, [])
  const handBackFocus = () => {
    const back = returnTo.current
    if (back?.isConnected) back.focus()
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    const border = element.offsetHeight - element.clientHeight
    element.style.height = `${element.scrollHeight + border}px`
  }, [draft])

  return (
    <textarea
      ref={ref}
      className="edit moment-row__edit"
      rows={1}
      value={draft}
      placeholder="Comment"
      aria-label="Moment comment"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        onCommit(draft)
        handBackFocus()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
          handBackFocus()
          return
        }
        // Enter commits, as the title box does; Shift+Enter keeps a line break,
        // because a comment about a moment is allowed to be two sentences.
        if (event.key !== 'Enter' || event.shiftKey) return
        event.preventDefault()
        event.currentTarget.blur()
      }}
    />
  )
}
