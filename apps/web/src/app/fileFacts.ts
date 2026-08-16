/**
 * What the file inspector shows, independent of where the file came from.
 *
 * The File Browser holds `FileBrowserEntry` (a path on disk) and a bundle holds
 * `FileRead` (an indexed row). They describe the same thing in different words,
 * which is why the in-bundle view had no inspector at all — there was nothing to
 * hand the existing one. Normalizing here lets both surfaces drive the same
 * component instead of growing a second copy of it (owner, 2026-07-27).
 */

import type { FileBrowserEntry, FileRead } from '../api/client'

export interface FileFacts {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
  extension: string | null
  sizeBytes: number | null
  createdAt: string | null
  modifiedAt: string | null
  mimeType: string | null
  mediaKind: string | null
  supported: boolean
  /** Where this file stands relative to bundling, in the inspector's words. */
  status: string
  /** Probed dimensions and duration, when the file has been through metadata. */
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  /** How the media is encoded, when probed. */
  videoCodec: string | null
  audioCodec: string | null
  videoBitrate: number | null
  audioBitrate: number | null
  audioSampleRate: number | null
  /** Overall container bitrate in bits/second, when probed. */
  bitrate: number | null
  /** HDR signalling (`hdr10`/`hlg`/`dv`), null for ordinary SDR. */
  hdr: string | null
  /** Bits per colour sample; 8 for ordinary video. */
  bitDepth: number | null
}

function metaNumber(meta: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = (meta ?? {})[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metaText(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = (meta ?? {})[key]
  return typeof value === 'string' && value ? value : null
}

/** A path in the File Browser, indexed or not. */
export function factsFromEntry(entry: FileBrowserEntry): FileFacts {
  return {
    name: entry.name,
    relativePath: entry.relative_path,
    kind: entry.kind === 'directory' ? 'directory' : 'file',
    extension: entry.extension ?? null,
    sizeBytes: entry.size_bytes,
    createdAt: entry.created_at ?? null,
    modifiedAt: entry.modified_at ?? null,
    mimeType: entry.mime_type ?? null,
    mediaKind: entry.media_kind ?? null,
    supported: entry.supported,
    status: entryStatus(entry),
    width: entry.width ?? null,
    height: entry.height ?? null,
    duration: entry.duration ?? null,
    fps: entry.fps ?? null,
    videoCodec: entry.video_codec ?? null,
    audioCodec: entry.audio_codec ?? null,
    videoBitrate: entry.video_bitrate ?? null,
    audioBitrate: entry.audio_bitrate ?? null,
    audioSampleRate: entry.audio_sample_rate ?? null,
    // Container bitrate and HDR class are the two the listing still does not
    // carry; they arrive once the file is opened from an indexed row.
    bitrate: null,
    hdr: null,
    bitDepth: entry.bit_depth ?? null,
  }
}

/** An indexed file inside a bundle. */
export function factsFromBundleFile(file: FileRead): FileFacts {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dot = file.relative_path.lastIndexOf('.')
  const slash = file.relative_path.lastIndexOf('/')
  return {
    name: file.relative_path.slice(slash + 1),
    relativePath: file.relative_path,
    kind: 'file',
    extension: dot > slash ? file.relative_path.slice(dot + 1) : null,
    sizeBytes: file.size_bytes,
    createdAt: file.created_at ?? null,
    modifiedAt: null,
    mimeType: file.mime_type ?? null,
    mediaKind: file.media_kind ?? null,
    supported: file.supported,
    // A file reached through a bundle is in one by definition; what matters here
    // is whether its bytes are still where the library expects them.
    status: file.availability === 'available' ? 'In this bundle' : 'Missing',
    width: metaNumber(meta, 'width'),
    height: metaNumber(meta, 'height'),
    duration: metaNumber(meta, 'duration'),
    fps: metaNumber(meta, 'fps'),
    videoCodec: metaText(meta, 'video_codec'),
    audioCodec: metaText(meta, 'audio_codec'),
    videoBitrate: metaNumber(meta, 'video_bitrate'),
    audioBitrate: metaNumber(meta, 'audio_bitrate'),
    audioSampleRate: metaNumber(meta, 'audio_sample_rate'),
    bitrate: metaNumber(meta, 'bitrate'),
    hdr: metaText(meta, 'hdr'),
    bitDepth: metaNumber(meta, 'bit_depth'),
  }
}

function entryStatus(entry: FileBrowserEntry): string {
  if (entry.kind === 'directory') return '—'
  if (!entry.linked) return 'Not indexed'
  if (entry.unbundled) return 'Unbundled'
  return 'In a bundle'
}

/**
 * Which pane the viewer's docked inspector should show for one item.
 *
 * The distinction that matters is *not* "does this file have a bundle id" — a
 * scan stages every new file into a provisional one-file bundle, so an
 * unbundled file has one. Showing the Bundle Inspector for it told the owner
 * their file was in a bundle when it was not (2026-08-16). Only a confirmed
 * bundle gets the bundle pane; everything else describes the file.
 */
export type ViewerInspectorTarget =
  | { kind: 'bundle'; bundleId: string }
  | { kind: 'file'; facts: FileFacts }

/** For a File Browser row, indexed or not. */
export function inspectorTargetForEntry(
  entry: FileBrowserEntry | null,
): ViewerInspectorTarget | null {
  if (!entry) return null
  return entry.bundle_id && !entry.unbundled
    ? { kind: 'bundle', bundleId: entry.bundle_id }
    : { kind: 'file', facts: factsFromEntry(entry) }
}

/**
 * For a file opened from a bundle.
 *
 * Bundle Browser views exclude provisional bundles — but Missing Files does
 * not, so a scan-staged one can be opened here too and must not be named a
 * bundle either.
 */
export function inspectorTargetForBundleFile(
  bundleId: string,
  groupingState: string | null | undefined,
  file: FileRead | null,
): ViewerInspectorTarget | null {
  if (groupingState !== 'provisional') return { kind: 'bundle', bundleId }
  return file ? { kind: 'file', facts: factsFromBundleFile(file) } : null
}
