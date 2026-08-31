import { useEffect, useRef } from 'react'

import type { PlayerController } from './usePlayer'

export interface ShortcutActions {
  close: () => void
  toggleInfo: () => void
  snapshot: () => void
  previous: () => void
  next: () => void
  /**
   * Mark an end of the clip range at the playhead (`[` / `]`, reserved for
   * this in plan 1 §2). Absent when the source cannot be clipped.
   */
  markClipEdge?: (edge: 'start' | 'end') => void
  /**
   * Play the marked span (`\\`, beside the `[` and `]` that mark its ends).
   * Absent when the source cannot be clipped; a no-op when nothing is marked.
   */
  playClipRange?: () => void
  /**
   * Save a moment (`b`, for bookmark — plan 7). With a range marked it saves
   * the range; otherwise it saves the frame at the playhead. Absent when the
   * file cannot hold one.
   */
  saveMoment?: () => void
  /**
   * Whether the viewer is currently fullscreen. Supplied by the viewer rather than
   * read from the player, because an image bundle has no `PlayerController` yet can
   * still be fullscreen via the View menu.
   */
  isFullscreen: () => boolean
  exitFullscreen: () => void
}

/**
 * The viewer commands the native Playback menu can invoke (plan 3 §7). These ids
 * are exactly the `requires: "viewer"` entries in `platform/keymap.json`; a test
 * pins the two lists together so a menu item can never lose its handler.
 */
export type ViewerCommand =
  | 'play-pause'
  | 'previous-file'
  | 'next-file'
  | 'seek-back'
  | 'seek-forward'
  | 'rate-down'
  | 'rate-up'
  | 'toggle-mute'
  | 'toggle-subtitles'
  | 'snapshot'

/**
 * Single dispatcher for viewer commands, shared by the keyboard map below and by
 * the native Playback menu, so a native menu item and its key binding can never
 * drift apart. Returns whether the command applied.
 */
export function runViewerCommand(
  command: ViewerCommand,
  player: PlayerController | null,
  actions: ShortcutActions,
): boolean {
  // File navigation works for images too, so it must not require a player.
  if (command === 'previous-file') {
    actions.previous()
    return true
  }
  if (command === 'next-file') {
    actions.next()
    return true
  }
  if (!player) return false
  switch (command) {
    case 'play-pause':
      player.playPause()
      return true
    case 'seek-back':
      player.seekBy(-10)
      return true
    case 'seek-forward':
      player.seekBy(10)
      return true
    case 'rate-down':
      player.setRate(Math.max(0.25, player.rate - 0.25))
      return true
    case 'rate-up':
      player.setRate(Math.min(3, player.rate + 0.25))
      return true
    case 'toggle-mute':
      player.setMuted(!player.muted)
      return true
    case 'toggle-subtitles':
      player.toggleSubtitles()
      return true
    case 'snapshot':
      actions.snapshot()
      return true
  }
}

/** True when a keyboard event is meant for editable text, not the viewer. */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

/** Dispatch one M2 viewer/player shortcut, returning whether it was handled. */
export function handleViewerShortcut(
  event: KeyboardEvent,
  player: PlayerController | null,
  actions: ShortcutActions,
): boolean {
  if (isEditingTarget(event.target)) return false
  const key = event.key
  if (key === 'Escape') {
    // Escape closes the viewer, fullscreen or not — the owner expects one press
    // to put the player away rather than two (2026-07-27). Fullscreen is dropped
    // first because leaving the viewer inside it would strand the shell there;
    // `f` remains the way to leave fullscreen and keep watching.
    if (document.fullscreenElement) void document.exitFullscreen()
    else if (actions.isFullscreen()) actions.exitFullscreen()
    actions.close()
    return true
  }
  if (key.toLowerCase() === 'i') {
    actions.toggleInfo()
    return true
  }
  if (!player) {
    if (key === 'ArrowLeft') actions.previous()
    else if (key === 'ArrowRight') actions.next()
    else return false
    return true
  }

  // Keys that mirror a native Playback menu item go through the shared dispatcher
  // so the two surfaces cannot diverge; the rest are viewer-only bindings.
  // Owner remap (2026-07-27): `,`/`.` step frames (the video-editor convention),
  // and speed moved to z/x/c — z resets to 1×, x slower, c faster. `c` used to
  // toggle subtitles; that moved to `v` (mpv's binding).
  const lower = key.toLowerCase()
  const command: ViewerCommand | null =
    key === ' ' || lower === 'k'
      ? 'play-pause'
      : lower === 'j'
        ? 'seek-back'
        : lower === 'l'
          ? 'seek-forward'
          : lower === 'm'
            ? 'toggle-mute'
            : lower === 'v'
              ? 'toggle-subtitles'
              : lower === 's'
                ? 'snapshot'
                : lower === 'x'
                  ? 'rate-down'
                  : lower === 'c'
                    ? 'rate-up'
                    : null
  if (command) return runViewerCommand(command, player, actions)

  if (key === 'ArrowLeft') player.seekBy(-player.seekStep)
  else if (key === 'ArrowRight') player.seekBy(player.seekStep)
  else if (key === 'ArrowUp') player.setVolume(Math.min(1, player.volume + 0.05))
  else if (key === 'ArrowDown') player.setVolume(Math.max(0, player.volume - 0.05))
  else if (lower === 'f') player.toggleFullscreen()
  else if (key === ',' || key === '<') player.frameStep(-1)
  else if (key === '.' || key === '>') player.frameStep(1)
  else if (lower === 'z') player.setRate(1)
  // `[`/`]` mark the clip range's ends at the playhead. Unhandled — and so
  // left to the browser — on a source that cannot be clipped.
  else if (key === '[' && actions.markClipEdge) actions.markClipEdge('start')
  else if (key === ']' && actions.markClipEdge) actions.markClipEdge('end')
  // `\\` sits next to them, and plays what they marked. Ordinary play stays
  // Space: the span is something you ask for, not a redefinition of play.
  else if (key === '\\' && actions.playClipRange) actions.playClipRange()
  // `b` for bookmark: the frame at the playhead, or the marked range if there is
  // one. Unhandled — and so left to the browser — on a file with no row to hang
  // a moment on.
  else if (lower === 'b' && actions.saveMoment) actions.saveMoment()
  else if (/^[0-9]$/.test(key)) player.seek((player.duration * Number(key)) / 10)
  else return false

  return true
}

/** Attach the M2 keyboard map to the focused viewer root while it is open. */
export function useShortcuts(
  rootRef: React.RefObject<HTMLElement | null>,
  player: PlayerController | null,
  actions: ShortcutActions,
) {
  const playerRef = useRef(player)
  const actionsRef = useRef(actions)

  useEffect(() => {
    playerRef.current = player
    actionsRef.current = actions
  }, [actions, player])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!handleViewerShortcut(event, playerRef.current, actionsRef.current)) return
      event.preventDefault()
      event.stopPropagation()
    }
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [rootRef])
}
