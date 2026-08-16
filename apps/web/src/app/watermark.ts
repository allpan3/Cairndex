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
 * setting look different on a GIF than on a snapshot of the same frame. It also
 * means the image watermark the owner asked for next needs no server change —
 * an image and a rendered string arrive as the same transparent PNG.
 */

/** Which corner the mark sits in. */
export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * Cap height as a fraction of the export's width, so the mark reads the same
 * size on a 480px GIF as on a 3840px snapshot rather than growing with pixels.
 */
const SIZE_RATIO = 1 / 52
/** Never below this: past it the mark is unreadable at any resolution. */
const MIN_FONT_SIZE = 11
/** The gap between the mark and the edges it is tucked into, in text units. */
const MARGIN_RATIO = 0.9

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
 * The text actually drawn, or null when nothing should be.
 *
 * Whitespace-only text counts as nothing: a mark of one space would otherwise
 * reserve layout in the contact sheet header and draw an invisible nothing.
 */
export function watermarkLabel(prefs: {
  watermarkEnabled: boolean
  watermarkText: string
}): string | null {
  if (!prefs.watermarkEnabled) return null
  const text = prefs.watermarkText.trim()
  return text.length > 0 ? text : null
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
}

/**
 * Where the mark's baseline lands inside its box.
 *
 * Pure, so the placement is testable without a canvas: everything a caller
 * needs to draw is derived here and only the painting itself needs a context.
 * The measured text width is deliberately not an input — the canvas aligns
 * right-hand text from its right edge, so the anchor is the edge itself.
 */
export function watermarkPlacement(box: WatermarkBox): {
  x: number
  y: number
  align: 'left' | 'right'
  fontSize: number
} {
  const fontSize = watermarkFontSize(box.scaleWidth ?? box.width)
  const margin = watermarkMargin(fontSize)
  const right = box.corner === 'top-right' || box.corner === 'bottom-right'
  const bottom = box.corner === 'bottom-left' || box.corner === 'bottom-right'
  return {
    // Right-aligned text draws from its right edge, so the x is the edge itself
    // rather than the edge less the measured width.
    x: right ? box.left + box.width - margin : box.left + margin,
    // `alphabetic` baseline: the glyphs sit above it, so the bottom corner needs
    // a descender's worth of room left under it.
    y: bottom
      ? box.top + box.height - margin - Math.round(fontSize * 0.22)
      : box.top + margin + fontSize,
    align: right ? 'right' : 'left',
    fontSize,
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
  text: string | null,
  box: WatermarkBox,
): number {
  if (text === null || text.length === 0) return 0
  const fontSize = watermarkFontSize(box.scaleWidth ?? box.width)
  ctx.save()
  try {
    ctx.font = watermarkFont(fontSize)
    ctx.textBaseline = 'alphabetic'
    const textWidth = ctx.measureText(text).width
    const placement = watermarkPlacement(box)
    ctx.textAlign = placement.align

    // The outline carries the shadow, so the halo sits behind the mark's whole
    // silhouette rather than being traced a second time around the fill.
    ctx.shadowColor = SHADOW_COLOR
    ctx.shadowBlur = Math.max(2, Math.round(fontSize * 0.35))
    ctx.shadowOffsetY = Math.max(1, Math.round(fontSize * 0.06))
    ctx.strokeStyle = OUTLINE_COLOR
    ctx.lineWidth = Math.max(1, fontSize / 9)
    // Round joins: mitred corners on a heavy face throw spikes off the glyphs.
    ctx.lineJoin = 'round'
    ctx.strokeText(text, placement.x, placement.y)

    // Shadow off for the fill: drawn through it a second time it compounds into
    // a grey smudge around letters that should be clean.
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.fillStyle = TEXT_FILL
    ctx.fillText(text, placement.x, placement.y)
    return textWidth + watermarkMargin(fontSize) * 2
  } finally {
    // Shadow and alignment are context-wide; leaking them would put a drop
    // shadow under everything drawn after the mark.
    ctx.restore()
  }
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
export function renderWatermarkTile(text: string | null, width: number): HTMLCanvasElement | null {
  if (text === null || text.length === 0) return null
  const fontSize = watermarkFontSize(width)
  const margin = watermarkMargin(fontSize)

  const canvas = document.createElement('canvas')
  const measuring = canvas.getContext('2d')
  if (!measuring) return null
  measuring.font = watermarkFont(fontSize)
  const textWidth = measuring.measureText(text).width
  if (!(textWidth > 0)) return null

  // Sized to the mark plus its inset on the two edges it is tucked against, and
  // a descender's room under the baseline.
  canvas.width = Math.ceil(textWidth + margin * 2)
  canvas.height = Math.ceil(fontSize * 1.25 + margin)

  // Resizing a canvas resets its context, so everything is set again here.
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  drawWatermark(ctx, text, {
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
 * kilobytes of mostly-transparent PNG. A future image mark rides the same field.
 */
export async function watermarkTileBase64(
  text: string | null,
  width: number,
): Promise<string | null> {
  const canvas = renderWatermarkTile(text, width)
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
