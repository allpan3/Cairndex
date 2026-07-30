import {
  type FileBrowserEntry,
  type FileRead,
  fileBrowserContentUrl,
  fileBrowserPreviewUrl,
  fileContentUrl,
  filePreviewUrl,
  fileStreamUrl,
  fileThumbnailUrl,
} from '../../api/client'
import { formatFileType } from '../../lib/format'
import { isBrowserNativeImage } from './imageSupport'
import type { SourceTier } from './imageTransform'

/** One progressively better image source for the zoom/pan stage. */
export interface ViewerImageTier {
  tier: SourceTier
  src: string
}

/**
 * One playable/previewable thing in an open viewer, normalized away from where
 * it came from.
 *
 * The viewer serves two surfaces with genuinely different identity models: a
 * Bundle Browser file is an indexed `AssetFile` row addressed by id, while a
 * File Browser entry is a physical path that need not be indexed at all. Rather
 * than fake an `AssetFile` row for a bare path — which would leak a bogus id
 * into cover-frame mutations, progress writes, and cache keys — both map into
 * this shape, and the fields a bare path genuinely lacks are null.
 */
export interface ViewerItem {
  /** Identity for React keys and per-item viewer state. Unique within a list. */
  key: string
  /** `AssetFile` id when this item is indexed; null for an unindexed path. */
  fileId: string | null
  /** Bundle owning `fileId`. Drives manifest lookup and progress writes. */
  bundleId: string | null
  title: string
  /** "video" | "image" | "audio" | "subtitle" | … or null when unclassified. */
  mediaKind: string | null
  /** The app can preview/play this kind of file in the web viewer. */
  supported: boolean
  /** The bytes are readable — a linked row can point at a vanished path. */
  available: boolean
  /** Ascending-quality image sources; empty for non-images. */
  imageTiers: ViewerImageTier[]
  /**
   * Raw-bytes URL for native progressive playback. For an indexed file this is
   * the range-streaming endpoint; for a bare path it is the path-scoped reader.
   * Only used when no playback decision applies (see `useHlsSession`).
   */
  contentUrl: string
  mimeType: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  duration: number | null
  /** Frames per second, when the file has been probed. Printed on exports. */
  fps: number | null
  /** How the media is encoded, when probed. Printed on exports. */
  videoCodec: string | null
  audioCodec: string | null
  /** Container bitrate (bits/second), HDR signalling, and colour bit depth,
   *  when probed — the rest of what the info panel says about encoding. */
  bitrate: number | null
  hdr: string | null
  bitDepth: number | null
  /** Human-readable type for info and fallback cards. */
  typeLabel: string
  /** Whether the browser can decode this image without a server derivative. */
  nativeImage: boolean
  /** This file's chosen cover-frame offset; null when it has none to reset. */
  coverTime: number | null
  /**
   * Whether the cover-frame affordance applies. A chosen frame is stored on the
   * file's row, so an unindexed path cannot have one.
   */
  canSetCover: boolean
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Normalize an indexed bundle file (Bundle Browser / Media Viewer). */
export function viewerItemFromFile(file: FileRead): ViewerItem {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const nativeImage = isBrowserNativeImage(file.relative_path)
  const imageTiers: ViewerImageTier[] =
    file.media_kind === 'image'
      ? [
          { tier: 'thumbnail', src: fileThumbnailUrl(file.bundle_id, file.id) },
          ...(nativeImage
            ? [{ tier: 'original' as const, src: fileContentUrl(file.id) }]
            : [
                { tier: 'preview1600' as const, src: filePreviewUrl(file, 1600) },
                { tier: 'preview2560' as const, src: filePreviewUrl(file, 2560) },
              ]),
        ]
      : []
  return {
    key: file.id,
    fileId: file.id,
    bundleId: file.bundle_id,
    title: file.display_title,
    mediaKind: file.media_kind,
    supported: file.supported,
    available: file.availability === 'available',
    imageTiers,
    contentUrl: fileStreamUrl(file.id),
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    width: numberOrNull(meta.width),
    height: numberOrNull(meta.height),
    duration: numberOrNull(meta.duration),
    fps: numberOrNull(meta.fps),
    videoCodec: textOrNull(meta.video_codec),
    audioCodec: textOrNull(meta.audio_codec),
    bitrate: numberOrNull(meta.bitrate),
    hdr: textOrNull(meta.hdr),
    bitDepth: numberOrNull(meta.bit_depth),
    typeLabel: formatFileType(file.media_kind, file.original_filename),
    nativeImage,
    coverTime: file.cover_time,
    canSetCover: true,
  }
}

/**
 * Normalize a File Browser entry (a physical path under the library root).
 *
 * A linked entry carries its `file_id`/`bundle_id`, so it can still reach the
 * indexed features — playback decisions, storyboards, subtitles, resume. An
 * unlinked entry has no row, so those stay null and playback falls back to
 * native progressive reads of the path itself. Image tiers skip the thumbnail
 * rank either way: File Browser rows have no cover image to borrow, and the
 * path-scoped preview is the smallest derivative available.
 */
export function viewerItemFromEntry(entry: FileBrowserEntry): ViewerItem {
  const nativeImage = isBrowserNativeImage(entry.relative_path)
  const imageTiers: ViewerImageTier[] =
    entry.media_kind === 'image'
      ? nativeImage
        ? [{ tier: 'original', src: fileBrowserContentUrl(entry.relative_path) }]
        : [
            { tier: 'preview1600', src: fileBrowserPreviewUrl(entry.relative_path, 1600) },
            { tier: 'preview2560', src: fileBrowserPreviewUrl(entry.relative_path, 2560) },
          ]
      : []
  // A listing row can reach us from a partially-populated source (fixtures, an
  // older server); normalize absent to null so the shape matches what it claims.
  return {
    key: entry.relative_path,
    fileId: entry.file_id ?? null,
    bundleId: entry.bundle_id ?? null,
    title: entry.name,
    mediaKind: entry.media_kind ?? null,
    supported: entry.supported,
    // A File Browser listing is a live directory read, so anything it returned
    // exists; a linked row's availability is the scanner's separate concern.
    available: true,
    imageTiers,
    // An indexed path still streams through its file row so range reads, resume,
    // and cache identity match the Media Viewer exactly.
    contentUrl: entry.file_id
      ? fileStreamUrl(entry.file_id)
      : fileBrowserContentUrl(entry.relative_path),
    mimeType: entry.mime_type ?? null,
    sizeBytes: entry.size_bytes ?? null,
    width: null,
    height: null,
    duration: entry.duration ?? null,
    fps: null,
    videoCodec: entry.video_codec ?? null,
    audioCodec: entry.audio_codec ?? null,
    // The browser listing carries only what its cards need; an indexed path
    // still reaches the full facts through its bundle row.
    bitrate: null,
    hdr: null,
    bitDepth: null,
    // An unclassified path has no media kind; 'other' makes the label fall back
    // to the file extension, matching how a bundle file labels the same case.
    typeLabel: formatFileType(entry.media_kind ?? 'other', entry.name),
    nativeImage,
    coverTime: null,
    canSetCover: false,
  }
}
