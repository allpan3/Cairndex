export interface PlaybackSource {
  src: string
  mimeType: string
}

export type PlaybackEvent =
  | 'loadedmetadata'
  | 'durationchange'
  | 'progress'
  | 'timeupdate'
  | 'play'
  | 'playing'
  | 'pause'
  | 'ended'
  | 'waiting'
  | 'error'
  | 'enterpictureinpicture'
  | 'leavepictureinpicture'

export interface PlaybackEngine {
  load(source: PlaybackSource): void
  on(event: PlaybackEvent, callback: () => void): () => void
  play(): Promise<void>
  pause(): void
  seek(time: number): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setRate(rate: number): void
  destroy(): void
}

/** Native HTML video engine; HLS can implement this same seam in M8. */
export class NativeEngine implements PlaybackEngine {
  private readonly video: HTMLVideoElement

  constructor(video: HTMLVideoElement) {
    this.video = video
  }

  load(source: PlaybackSource): void {
    this.video.src = source.src
    this.video.crossOrigin = 'anonymous'
    this.video.load()
  }

  on(event: PlaybackEvent, callback: () => void): () => void {
    this.video.addEventListener(event, callback)
    return () => this.video.removeEventListener(event, callback)
  }

  play(): Promise<void> {
    return this.video.play()
  }

  pause(): void {
    this.video.pause()
  }

  seek(time: number): void {
    this.video.currentTime = Math.max(0, Math.min(time, this.video.duration || time))
  }

  setVolume(volume: number): void {
    this.video.volume = Math.max(0, Math.min(1, volume))
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted
  }

  setRate(rate: number): void {
    this.video.playbackRate = rate
    this.video.preservesPitch = true
  }

  destroy(): void {
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }
}
