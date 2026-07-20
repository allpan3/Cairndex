import { useEffect, useRef } from 'react'

import type { PlayerController } from './usePlayer'

export interface ShortcutActions {
  close: () => void
  toggleInfo: () => void
  snapshot: () => void
  previous: () => void
  next: () => void
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
    // Escape leaves fullscreen before it closes the viewer. In the shell that
    // fullscreen is the native window, so `document.fullscreenElement` is null
    // and the player's own state is the only reliable signal.
    if (document.fullscreenElement) void document.exitFullscreen()
    else if (player?.fullscreen) player.toggleFullscreen()
    else actions.close()
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
            : lower === 'c'
              ? 'toggle-subtitles'
              : lower === 's'
                ? 'snapshot'
                : key === ','
                  ? 'rate-down'
                  : key === '.'
                    ? 'rate-up'
                    : null
  if (command) return runViewerCommand(command, player, actions)

  if (key === 'ArrowLeft') player.seekBy(-player.seekStep)
  else if (key === 'ArrowRight') player.seekBy(player.seekStep)
  else if (key === 'ArrowUp') player.setVolume(Math.min(1, player.volume + 0.05))
  else if (key === 'ArrowDown') player.setVolume(Math.max(0, player.volume - 0.05))
  else if (lower === 'f') player.toggleFullscreen()
  else if (key === '<') player.frameStep(-1)
  else if (key === '>') player.frameStep(1)
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
