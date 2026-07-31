/**
 * Saving a contact sheet, from wherever the user asked for one.
 *
 * The viewer had this inline first, but the owner wants it on a video in the
 * File Browser, inside a bundle, and in the bundle inspector too (2026-07-27) —
 * so the work lives here and each surface only supplies the file and a way to
 * report progress. Generation is not instant (a few seconds for a long video),
 * hence the "building…" message before the result rather than a silent pause.
 */

import { fileContactSheetUrl } from '../api/client'
import { composeContactSheet, type ContactSheetRow } from './viewer/contactSheet'
import {
  formatBitrate,
  formatBytes,
  formatCodec,
  formatDuration,
  formatSampleRate,
} from '../lib/format'
import { getHostPlatform, isDesktopHost } from '../platform'

/** The grids offered. Square, and within the server's bounds. */
export const CONTACT_SHEET_GRIDS = [4, 5, 6] as const
export type ContactSheetGrid = (typeof CONTACT_SHEET_GRIDS)[number]

/** Sheet widths the server accepts (`contact_sheets.SHEET_WIDTHS`). */
export const CONTACT_SHEET_WIDTHS = [1600, 2048, 2560] as const
export type ContactSheetWidth = (typeof CONTACT_SHEET_WIDTHS)[number]

export interface ContactSheetTarget {
  fileId: string
  title: string
  sizeBytes?: number | null
  duration?: number | null
  width?: number | null
  height?: number | null
  fps?: number | null
  mimeType?: string | null
  videoCodec?: string | null
  audioCodec?: string | null
  videoBitrate?: number | null
  audioBitrate?: number | null
  audioSampleRate?: number | null
}

/** One codec paired with its own stream bitrate. */
function codecSummary(
  codec: string | null | undefined,
  bitrate: number | null | undefined,
): string {
  const parts = [codec ? formatCodec(codec) : null, bitrate ? formatBitrate(bitrate) : null].filter(
    (part): part is string => part !== null,
  )
  return parts.join(' / ') || '—'
}

/** Primary audio encoding, bitrate, and sampling frequency. */
function audioCodecSummary(target: ContactSheetTarget): string {
  const parts = [
    target.audioCodec ? formatCodec(target.audioCodec) : null,
    target.audioBitrate ? formatBitrate(target.audioBitrate) : null,
    target.audioSampleRate ? formatSampleRate(target.audioSampleRate) : null,
  ].filter((part): part is string => part !== null)
  return parts.join(' / ') || '—'
}

/** The three metadata rows printed above every exported grid. */
export function contactSheetRows(target: ContactSheetTarget): ContactSheetRow[] {
  const dimensions = target.width && target.height ? `${target.width}×${target.height}` : '—'
  const frameRate = target.fps ? `${Math.round(target.fps * 100) / 100} fps` : '—'
  return [
    { label: 'File Name', value: target.title || '—' },
    {
      label: 'Details',
      value: `${formatBytes(target.sizeBytes)} · ${formatDuration(target.duration)} · ${dimensions} / ${frameRate}`,
    },
    {
      label: 'Codec',
      value: `${codecSummary(target.videoCodec, target.videoBitrate)} · ${audioCodecSummary(target)}`,
    },
  ]
}

/** Strip what a filename cannot hold, keeping the title readable. */
function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'contact sheet'
}

/**
 * Build and save one contact sheet.
 *
 * `report` receives a message; one ending in an ellipsis means work is still in
 * flight, which is how the shell decides whether to leave it on screen.
 */
export async function saveContactSheet(
  target: ContactSheetTarget,
  grid: ContactSheetGrid,
  width: ContactSheetWidth,
  report: (message: string | null) => void,
): Promise<void> {
  report('Building contact sheet…')
  try {
    const blob = await composeContactSheet({
      sheetUrl: fileContactSheetUrl(target.fileId, grid, grid, width),
      metadataRows: contactSheetRows(target),
      cols: grid,
      rows: grid,
    })
    const name = `${safeName(target.title)} — contact sheet.jpg`
    if (isDesktopHost()) {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const saved = await getHostPlatform().saveExport(name, bytes)
      report(saved ? 'Contact sheet saved.' : null)
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
    report('Contact sheet saved.')
  } catch (error) {
    report(error instanceof Error ? error.message : 'The contact sheet failed.')
  }
}

/**
 * The "Save Contact Sheet" row, opening the options dialog.
 *
 * Returned as data so each surface can splice it into its own menu without
 * knowing anything about how a sheet is built.
 */
export function contactSheetMenuItem(
  target: ContactSheetTarget,
  onOpenDialog: (target: ContactSheetTarget) => void,
): { label: string; onClick: () => void } {
  return { label: 'Save Contact Sheet…', onClick: () => onOpenDialog(target) }
}
