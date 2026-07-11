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
