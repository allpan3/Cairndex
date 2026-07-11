import { useEffect, useRef } from 'react'

import type { PlayerController } from './usePlayer'

export interface ShortcutActions {
  close: () => void
  toggleInfo: () => void
  snapshot: () => void
  previous: () => void
  next: () => void
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
    if (document.fullscreenElement) void document.exitFullscreen()
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

  if (key === ' ' || key.toLowerCase() === 'k') player.playPause()
  else if (key === 'ArrowLeft') player.seekBy(-player.seekStep)
  else if (key === 'ArrowRight') player.seekBy(player.seekStep)
  else if (key.toLowerCase() === 'j') player.seekBy(-10)
  else if (key.toLowerCase() === 'l') player.seekBy(10)
  else if (key === 'ArrowUp') player.setVolume(Math.min(1, player.volume + 0.05))
  else if (key === 'ArrowDown') player.setVolume(Math.max(0, player.volume - 0.05))
  else if (key.toLowerCase() === 'm') player.setMuted(!player.muted)
  else if (key.toLowerCase() === 'f') player.toggleFullscreen()
  else if (key.toLowerCase() === 'c') player.toggleSubtitles()
  else if (key.toLowerCase() === 's') actions.snapshot()
  else if (key === '<') player.frameStep(-1)
  else if (key === '>') player.frameStep(1)
  else if (key === ',') player.setRate(Math.max(0.25, player.rate - 0.25))
  else if (key === '.') player.setRate(Math.min(3, player.rate + 0.25))
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
