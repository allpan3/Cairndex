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
    width: null,
    height: null,
    duration: entry.duration ?? null,
    fps: null,
    videoCodec: entry.video_codec ?? null,
    audioCodec: entry.audio_codec ?? null,
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
  }
}

function entryStatus(entry: FileBrowserEntry): string {
  if (entry.kind === 'directory') return '—'
  if (!entry.linked) return 'Not indexed'
  if (entry.unbundled) return 'Unbundled'
  return 'In a bundle'
}
