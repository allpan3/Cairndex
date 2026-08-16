/**
 * The mark stamped onto an exported snapshot, GIF, or contact sheet.
 *
 * **Drawn here for all three, including the GIF.** Snapshots and contact sheets
 * are composed on a canvas in the browser already, so they could each have
 * drawn their own; the GIF is encoded by ffmpeg on the server, which cannot
 * render text at all — the builds Cairndex runs against have no `drawtext`
 * (it needs freetype and font discovery, the same reason the contact sheet's
 * header is composed client-side). So the GIF path renders the mark *here* to a
 * transparent PNG and has ffmpeg `overlay` it.
 *
 * One renderer rather than one per surface is the point: the alternative was
 * the server drawing the GIF's mark with Pillow, which would have made the same
 * setting look different on a GIF than on a snapshot of the same frame. It is
 * also what made the image mark cost nothing on the server — a rendered string
 * and a chosen picture leave here as the same transparent PNG, so ffmpeg never
 * learns which one it composited.
 */

import type { ExportPrefs } from '../state/exportPrefs'
import { loadImage } from './watermarkImage'

/** Which corner the mark sits in. */
export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * A mark ready to draw: the words, or a decoded picture.
 *
 * Resolved from the preferences by `resolveWatermark` so that everything after
 * that point — sizing, placement, painting — treats the two the same and cannot
 * drift apart.
 */
export type WatermarkMark =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: CanvasImageSource; naturalWidth: number; naturalHeight: number }

/**
 * Cap height as a fraction of the export's width, so the mark reads the same
 * size on a 480px GIF as on a 3840px snapshot rather than growing with pixels.
 */
const SIZE_RATIO = 1 / 52
/** Never below this: past it the mark is unreadable at any resolution. */
const MIN_FONT_SIZE = 11
/**
 * The gap between the mark and the edges it is tucked into, in text units.
 *
 * This is the inset on a *frame* — the bottom-right mark on a snapshot or a
 * GIF. Tightened from 0.9 on 2026-08-16 because at that value the mark read as
 * floating in the corner rather than sitting in it. At `1/52` cap height this
 * works out near 1% of the export's width, which is a corner inset rather than
 * a margin. The contact-sheet header does not use it: a band with a padding of
 * its own passes that instead, so the mark lines up with the text beside it.
 */
const MARGIN_RATIO = 0.55

/**
 * How tall a picture mark stands, again as a fraction of the export's width.
 *
 * Roughly three times the text's cap height, which is what makes a logo read as
 * the same weight of mark as a word rather than as a stamp on top of the frame.
 */
const IMAGE_HEIGHT_RATIO = 1 / 18
/**
 * ...but never wider than this fraction of the export.
 *
 * A picture mark is fitted inside *both* bounds rather than scaled by height
 * alone, because the two shapes people actually use pull in opposite
 * directions: a square badge scaled to a fixed width becomes enormously tall,
 * and a long wordmark scaled to a fixed height runs off the frame.
 */
const IMAGE_MAX_WIDTH_RATIO = 0.28

/**
 * White, over a dark outline and a soft shadow.
 *
 * A frame is arbitrary — a snapshot can be of a snowfield or of a night sky —
 * so neither a light nor a dark mark reads on its own. A shadow alone was tried
 * first and is enough on dark and mid tones, but against pure white it leaves
 * the mark barely there; the outline is what makes it hold, and the shadow
 * still softens the join so the outline does not read as a sticker.
 *
 * Preferred to the opaque plate the contact sheet's timestamps use: a plate
 * looks like chrome that belongs to the app, where a watermark should look like
 * it belongs to the image.
 */
const TEXT_FILL = 'rgba(255, 255, 255, 0.92)'
const OUTLINE_COLOR = 'rgba(0, 0, 0, 0.55)'
const SHADOW_COLOR = 'rgba(0, 0, 0, 0.55)'
/**
 * A picture arrives already designed, so it is composited nearly as given —
 * only the same shadow the text gets, which is what stops a white logo
 * disappearing into a white frame.
 */
const IMAGE_ALPHA = 0.92

/** The type face, matching the contact sheet header's. */
function watermarkFont(fontSize: number): string {
  return `700 ${fontSize}px system-ui, sans-serif`
}

/** The mark's cap height for an export this wide. */
export function watermarkFontSize(width: number): number {
  return Math.max(MIN_FONT_SIZE, Math.round(width * SIZE_RATIO))
}

/** The inset between the mark and the edges of the box holding it. */
export function watermarkMargin(fontSize: number): number {
  return Math.round(fontSize * MARGIN_RATIO)
}

/**
 * The size a picture mark is drawn at, fitted inside both bounds.
 *
 * Null when the image reports no dimensions — an image element that has not
 * decoded, which must not be drawn as a zero-sized nothing.
 */
export function imageMarkSize(
  naturalWidth: number,
  naturalHeight: number,
  scaleWidth: number,
): { width: number; height: number } | null {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null
  const targetHeight = Math.max(12, Math.round(scaleWidth * IMAGE_HEIGHT_RATIO))
  const maxWidth = Math.max(12, Math.round(scaleWidth * IMAGE_MAX_WIDTH_RATIO))
  let height = targetHeight
  let width = Math.round(naturalWidth * (height / naturalHeight))
  if (width > maxWidth) {
    width = maxWidth
    height = Math.round(naturalHeight * (width / naturalWidth))
  }
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

export interface WatermarkBox {
  /** The region the mark is placed inside, in canvas coordinates. */
  left: number
  top: number
  width: number
  height: number
  corner: WatermarkCorner
  /**
   * The width the mark is *sized* against, when that differs from the box —
   * the contact sheet tucks the mark into a header band a fraction of the
   * sheet's height, but wants it scaled to the sheet.
   */
  scaleWidth?: number
  /**
   * The inset from the box's edges, when the box has padding of its own.
   *
   * Defaults to `watermarkMargin`, which is derived from the mark's size and
   * suits a mark tucked into the corner of a frame. The contact-sheet header is
   * not a frame: it has a padding of its own that its metadata rows observe, so
   * it passes that and the mark lines up with the text beside it rather than
   * being inset by an unrelated amount (owner, 2026-08-16).
   */
  margin?: number
}

/**
 * The mark's drawn size, in the units the box is measured in.
 *
 * Text needs a context to measure, which is why one is passed in rather than
 * the width being guessed from the character count.
 */
export function markSize(
  ctx: CanvasRenderingContext2D,
  mark: WatermarkMark,
  scaleWidth: number,
): { width: number; height: number } | null {
  if (mark.kind === 'image') {
    return imageMarkSize(mark.naturalWidth, mark.naturalHeight, scaleWidth)
  }
  const fontSize = watermarkFontSize(scaleWidth)
  ctx.font = watermarkFont(fontSize)
  const width = ctx.measureText(mark.text).width
  if (!(width > 0)) return null
  // The em box, not the tight glyph bounds: it keeps descenders inside the
  // mark's own rectangle so a corner inset means the same thing for both kinds.
  return { width, height: Math.round(fontSize * 1.2) }
}

/**
 * Shrink a mark, keeping its aspect, until it fits inside its box's padding.
 *
 * A picture mark is sized against the export's *width*, so nothing in that
 * calculation knows how tall the box holding it is. In the contact-sheet header
 * — a band whose height comes from three rows of text — a tall enough logo
 * overflowed it, and because the frame grid is drawn after the mark, the grid
 * painted over the overflow and shaved the mark's bottom off (owner reported it
 * as sitting too low, 2026-08-16). Fitting here means a mark can never be
 * clipped by whatever is drawn next.
 *
 * Null when there is no room at all, which is not a mark worth drawing.
 */
export function fitWithin(
  size: { width: number; height: number },
  box: WatermarkBox,
  margin: number,
): { width: number; height: number } | null {
  const availableWidth = box.width - margin * 2
  const availableHeight = box.height - margin * 2
  if (!(availableWidth > 0) || !(availableHeight > 0)) return null
  const scale = Math.min(1, availableWidth / size.width, availableHeight / size.height)
  if (scale >= 1) return size
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/**
 * The top-left corner the mark is drawn from.
 *
 * One calculation for both kinds — the reason a picture and a word end up in
 * exactly the same place, tucked against exactly the same two edges.
 */
export function cornerOrigin(
  box: WatermarkBox,
  size: { width: number; height: number },
  margin: number,
): { x: number; y: number } {
  const right = box.corner === 'top-right' || box.corner === 'bottom-right'
  const bottom = box.corner === 'bottom-left' || box.corner === 'bottom-right'
  return {
    x: right ? box.left + box.width - margin - size.width : box.left + margin,
    y: bottom ? box.top + box.height - margin - size.height : box.top + margin,
  }
}

/**
 * Paint the mark into a corner of an already-composed canvas.
 *
 * Used by the snapshot and contact-sheet paths, which own their canvas. Returns
 * the width the mark occupied, so a caller laying out beside it (the contact
 * sheet header's metadata rows) knows what to avoid; zero when nothing drew.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  mark: WatermarkMark | null,
  box: WatermarkBox,
): number {
  if (mark === null) return 0
  if (mark.kind === 'text' && mark.text.length === 0) return 0
  const scaleWidth = box.scaleWidth ?? box.width
  const fontSize = watermarkFontSize(scaleWidth)
  const margin = box.margin ?? watermarkMargin(fontSize)

  ctx.save()
  try {
    const measured = markSize(ctx, mark, scaleWidth)
    if (measured === null) return 0
    const size = fitWithin(measured, box, margin)
    if (size === null) return 0
    // How much the fit had to give up, applied to whichever knob actually
    // resizes this kind of mark: an image is drawn at explicit dimensions,
    // but glyphs only shrink if the *font* does — scaling a text mark's
    // reported box alone would move it without making it any smaller.
    const scale = size.height / measured.height
    const drawnFontSize = Math.max(1, Math.round(fontSize * scale))
    const origin = cornerOrigin(box, size, margin)

    // The shadow is what keeps either kind off a background of its own colour.
    ctx.shadowColor = SHADOW_COLOR
    ctx.shadowBlur = Math.max(2, Math.round(drawnFontSize * 0.35))
    ctx.shadowOffsetY = Math.max(1, Math.round(drawnFontSize * 0.06))

    if (mark.kind === 'image') {
      ctx.globalAlpha = IMAGE_ALPHA
      ctx.drawImage(mark.image, origin.x, origin.y, size.width, size.height)
    } else {
      // Drawn from the box's top-left rather than a baseline, so the same
      // origin arithmetic serves both kinds.
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.font = watermarkFont(drawnFontSize)
      ctx.strokeStyle = OUTLINE_COLOR
      ctx.lineWidth = Math.max(1, drawnFontSize / 9)
      // Round joins: mitred corners on a heavy face throw spikes off the glyphs.
      ctx.lineJoin = 'round'
      ctx.strokeText(mark.text, origin.x, origin.y)

      // Shadow off for the fill: drawn through it a second time it compounds
      // into a grey smudge around letters that should be clean.
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
      ctx.fillStyle = TEXT_FILL
      ctx.fillText(mark.text, origin.x, origin.y)
    }
    return size.width + margin * 2
  } finally {
    // Shadow, alpha and alignment are context-wide; leaking them would put a
    // drop shadow under everything drawn after the mark.
    ctx.restore()
  }
}

// One decoded image per `data:` URL, so a burst of exports does not re-decode
// the same logo each time. Keyed by the URL itself: changing the image in
// Settings changes the key, so a stale picture can never be drawn.
let decoded: { src: string; image: HTMLImageElement } | null = null

/** Decode a stored `data:` URL into something a canvas can draw. */
async function decodeWatermarkImage(src: string): Promise<HTMLImageElement | null> {
  if (decoded?.src === src) return decoded.image
  try {
    // `loadImage`, not `decode()` — see the note there: `decode()` can hang
    // forever in a window that is not painting, which would strand an export
    // started from a background tab.
    const image = await loadImage(src)
    decoded = { src, image }
    return image
  } catch {
    // A stored value that no longer loads marks nothing rather than failing
    // the export it was asked for.
    return null
  }
}

/**
 * The mark the preferences currently describe, or null for none.
 *
 * Async only because a picture has to decode before it can be measured; the
 * text answer is immediate. Every export path awaits this once and then draws
 * synchronously.
 */
export async function resolveWatermark(prefs: ExportPrefs): Promise<WatermarkMark | null> {
  if (!prefs.watermarkEnabled) return null
  if (prefs.watermarkKind === 'image') {
    if (!prefs.watermarkImage) return null
    const image = await decodeWatermarkImage(prefs.watermarkImage)
    if (image === null) return null
    return {
      kind: 'image',
      image,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    }
  }
  // Whitespace-only text counts as nothing: a mark of one space would otherwise
  // reserve layout in the contact sheet header and draw an invisible nothing.
  const text = prefs.watermarkText.trim()
  return text.length > 0 ? { kind: 'text', text } : null
}

/** Test seam: forget the decoded image so one case cannot leak into the next. */
export function resetWatermarkImageCacheForTests(): void {
  decoded = null
}

/**
 * The mark as a standalone transparent PNG, sized for an export `width` wide.
 *
 * For the GIF path, which cannot draw onto the frames itself. The margin is
 * baked into the tile as transparent padding rather than passed to the server
 * as an offset, so every question of how the mark is laid out is answered in
 * this one module and ffmpeg only has to place a rectangle in a corner.
 *
 * Null when there is nothing to draw, so a caller can skip the whole overlay.
 */
export function renderWatermarkTile(
  mark: WatermarkMark | null,
  width: number,
): HTMLCanvasElement | null {
  if (mark === null) return null
  const fontSize = watermarkFontSize(width)
  const margin = watermarkMargin(fontSize)

  const canvas = document.createElement('canvas')
  const measuring = canvas.getContext('2d')
  if (!measuring) return null
  const size = markSize(measuring, mark, width)
  if (size === null) return null

  // Sized to the mark plus its inset on the two edges it is tucked against.
  canvas.width = Math.ceil(size.width + margin * 2)
  canvas.height = Math.ceil(size.height + margin * 2)

  // Resizing a canvas resets its context, so everything is set again here.
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  drawWatermark(ctx, mark, {
    left: 0,
    top: 0,
    width: canvas.width,
    height: canvas.height,
    corner: 'bottom-right',
    scaleWidth: width,
  })
  return canvas
}

/**
 * The tile as bare base64 PNG, for the export request body.
 *
 * Base64 in the existing JSON rather than a multipart upload: the server has no
 * upload route and no `python-multipart`, and a text mark is a couple of
 * kilobytes of mostly-transparent PNG. A picture mark rides the same field,
 * which is the whole reason it needed no server change.
 */
export async function watermarkTileBase64(
  mark: WatermarkMark | null,
  width: number,
): Promise<string | null> {
  const canvas = renderWatermarkTile(mark, width)
  if (canvas === null) return null
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) return null
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  // Chunked: spreading a whole image into `String.fromCharCode` overflows the
  // argument limit on anything but a tiny tile.
  const CHUNK = 0x8000
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}
