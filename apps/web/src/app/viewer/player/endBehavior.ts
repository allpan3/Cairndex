import type { PlayerController } from './usePlayer'

/** Apply the end-of-file precedence: file loop owns the event before advance. */
export function handlePlaybackEnded(
  fileLoop: boolean,
  player: Pick<PlayerController, 'seek' | 'play'>,
  advance: () => void,
) {
  if (fileLoop) {
    player.seek(0)
    player.play()
  } else {
    advance()
  }
}

/** Consume one ended transition until playback leaves the ended state. */
export function consumeEndedTransition(
  status: PlayerController['status'],
  handled: { current: boolean },
  onEnded: () => void,
) {
  if (status !== 'ended') {
    handled.current = false
    return
  }
  if (handled.current) return
  handled.current = true
  onEnded()
}
