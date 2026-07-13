import type Hls from 'hls.js'
import type { ErrorData } from 'hls.js'

export interface PlaybackSource {
  src: string
  mimeType: string
  /**
   * Delivery kind: 'native' is a plain progressive `<video src>` (direct play);
   * 'hls' is an HLS playlist (remux/transcode session). Absent = 'native'.
   */
  kind?: 'native' | 'hls'
  /**
   * For 'hls' sources: play the m3u8 natively (Safari/WKWebView feed it straight
   * to `video.src`); otherwise attach hls.js over MediaSource.
   */
  nativeHls?: boolean
  /**
   * Seek here once metadata loads instead of applying resume progress — set when
   * switching quality/audio or transparently re-attaching a fresh session so the
   * new stream picks up at the current playhead.
   */
  startAt?: number
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
  setPreservesPitch(enabled: boolean): void
  destroy(): void
}

/**
 * Shared `<video>`-delegating command/event plumbing. Both engines drive the
 * same media element, so play/pause/seek/volume/rate/events are identical; only
 * how bytes reach the element (`load`) and how they are released (`destroy`)
 * differ per engine.
 */
abstract class BaseVideoEngine implements PlaybackEngine {
  protected readonly video: HTMLVideoElement

  constructor(video: HTMLVideoElement) {
    this.video = video
  }

  abstract load(source: PlaybackSource): void
  abstract destroy(): void

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
  }

  setPreservesPitch(enabled: boolean): void {
    this.video.preservesPitch = enabled
  }
}

/** Native HTML video engine: direct progressive play and native (Safari) HLS. */
export class NativeEngine extends BaseVideoEngine {
  load(source: PlaybackSource): void {
    this.video.src = source.src
    this.video.crossOrigin = 'anonymous'
    this.video.load()
  }

  destroy(): void {
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }
}

/**
 * hls.js engine for remux/transcode sessions on browsers without native HLS.
 * hls.js is lazy-loaded (`import()`) so its ~157 kB gz only ships when a source
 * actually needs it, keeping the main bundle flat. Media commands and playback
 * events flow through the same `<video>` element as {@link NativeEngine} (see
 * {@link BaseVideoEngine}), so the player state machine is engine-agnostic.
 * hls.js swallows its own errors, so fatal ones are surfaced by dispatching a
 * synthetic `error` on the video — the same event the fallback/re-attach path
 * already listens for.
 */
export class HlsEngine extends BaseVideoEngine {
  private hls: Hls | null = null
  private destroyed = false
  private recoveredMedia = false

  load(source: PlaybackSource): void {
    this.video.crossOrigin = 'anonymous'
    void this.attach(source.src)
  }

  private async attach(url: string): Promise<void> {
    let Hls: typeof import('hls.js').default
    try {
      Hls = (await import('hls.js')).default
    } catch {
      this.fail()
      return
    }
    if (this.destroyed) return
    if (!Hls.isSupported()) {
      this.fail()
      return
    }
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false })
    this.hls = hls
    hls.on(Hls.Events.ERROR, (_event, data) => this.onHlsError(Hls, hls, data))
    hls.loadSource(url)
    hls.attachMedia(this.video)
  }

  // Recover in-engine where hls.js can (a transient media decode glitch), but
  // surface network-fatal errors (e.g. a reaped session's segments now 404) and
  // truly unrecoverable ones so the player can re-attach a fresh session or fall
  // back to the unplayable card.
  private onHlsError(HlsCtor: typeof import('hls.js').default, hls: Hls, data: ErrorData): void {
    if (!data.fatal || this.destroyed) return
    if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && !this.recoveredMedia) {
      this.recoveredMedia = true
      hls.recoverMediaError()
      return
    }
    this.fail()
  }

  private fail(): void {
    if (this.destroyed) return
    this.video.dispatchEvent(new Event('error'))
  }

  destroy(): void {
    this.destroyed = true
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }
}

/** Choose the engine for a source: hls.js only for MSE-delivered HLS. */
export function createEngine(video: HTMLVideoElement, source: PlaybackSource): PlaybackEngine {
  if (source.kind === 'hls' && !source.nativeHls) return new HlsEngine(video)
  return new NativeEngine(video)
}
