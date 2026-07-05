import { useEffect } from 'react'

import type { PlayerController } from './usePlayer'

export interface ShortcutActions {
  close: () => void
  toggleInfo: () => void
  snapshot: () => void
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
    actions.close()
    return true
  }
  if (key.toLowerCase() === 'i') {
    actions.toggleInfo()
    return true
  }
  if (!player) return false

  if (key === ' ' || key.toLowerCase() === 'k') player.playPause()
  else if (key === 'ArrowLeft') player.seekBy(-5)
  else if (key === 'ArrowRight') player.seekBy(5)
  else if (key.toLowerCase() === 'j') player.seekBy(-10)
  else if (key.toLowerCase() === 'l') player.seekBy(10)
  else if (key === 'ArrowUp') player.setVolume(Math.min(1, player.volume + 0.05))
  else if (key === 'ArrowDown') player.setVolume(Math.max(0, player.volume - 0.05))
  else if (key.toLowerCase() === 'm') player.setMuted(!player.muted)
  else if (key.toLowerCase() === 'f') player.toggleFullscreen()
  else if (key.toLowerCase() === 'c') player.toggleSubtitles()
  else if (key.toLowerCase() === 's') actions.snapshot()
  else if (event.shiftKey && key === '<') player.setRate(Math.max(0.25, player.rate - 0.25))
  else if (event.shiftKey && key === '>') player.setRate(Math.min(3, player.rate + 0.25))
  else if (key === ',') player.frameStep(-1)
  else if (key === '.') player.frameStep(1)
  else if (/^[0-9]$/.test(key)) player.seek((player.duration * Number(key)) / 10)
  else return false

  return true
}

/** Attach the M2 keyboard map while the viewer is open. */
export function useShortcuts(player: PlayerController | null, actions: ShortcutActions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!handleViewerShortcut(event, player, actions)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [actions, player])
}
