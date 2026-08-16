/**
 * Taking an image the owner picked and making it storable as a watermark.
 *
 * The picked file never becomes a path: a browser does not hand out a usable
 * one, and copying it under the data dir would make a machine-local preference
 * into server state. It is inlined as a `data:` URL in `localStorage` beside
 * the rest of `exportPrefs` — which is only safe because it is bounded here.
 *
 * Two bounds, for two different reasons. The **file** cap rejects a full-size
 * photo before any work is done on it. The **dimension** cap is what actually
 * keeps storage small: a logo is re-encoded down to something no larger than
 * any export could need, so the quota holds however large the original was.
 */

/** Rejected before decoding: past this, the picked file is not a logo. */
export const MAX_WATERMARK_FILE_BYTES = 4 * 1024 * 1024

/**
 * The longest side kept in storage.
 *
 * Above what the largest export asks for: a picture mark is at most
 * `IMAGE_MAX_WIDTH_RATIO` of the output, so even a 4K snapshot wants barely
 * 1080px of it. Storing more would only pay quota for pixels no export can use.
 */
export const MAX_WATERMARK_STORED_EDGE = 1024

/**
 * Raster only, and deliberately not SVG.
 *
 * An SVG is a document rather than a picture — it can carry scripts and fetch
 * external references — and nothing here needs one, since the mark is always
 * rasterized onto a canvas before it is used.
 */
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** What the file input offers, matching {@link ACCEPTED_TYPES}. */
export const WATERMARK_FILE_ACCEPT = ACCEPTED_TYPES.join(',')

export interface WatermarkImport {
  /** The normalized image, ready to store. */
  dataUrl: string
  /** The picked file's name, for Settings to show. */
  name: string
  width: number
  height: number
}

/** Raised with a message meant to be shown to the owner as-is. */
export class WatermarkImageError extends Error {}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new WatermarkImageError('That image could not be read.'))
    reader.readAsDataURL(file)
  })
}

/**
 * Load an image, resolving when it is drawable.
 *
 * **Deliberately `onload` rather than `decode()`**, which is the obvious call
 * and the wrong one here. `decode()` resolves off the rendering pipeline, and
 * in a window that is not painting — a backgrounded tab, a hidden view — it can
 * simply never settle: observed here with an image reporting `complete` and its
 * true dimensions while the promise hung indefinitely. An export must not
 * depend on whether anyone is looking at the window, and `onload` already
 * guarantees the image can be drawn; `decode()` only buys a smoother frame,
 * which a one-off export has no use for.
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new WatermarkImageError('That file is not an image Cairndex can read.'))
    image.src = src
  })
}

/**
 * Validate, normalize, and inline one picked image.
 *
 * Re-encoded to PNG whenever it is resized, because a watermark is the one
 * place transparency matters most — a logo flattened onto white would carry a
 * white box across every export.
 */
export async function importWatermarkImage(file: File): Promise<WatermarkImport> {
  if (!ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) {
    throw new WatermarkImageError('Choose a PNG, JPEG, WebP, or GIF image.')
  }
  if (file.size > MAX_WATERMARK_FILE_BYTES) {
    throw new WatermarkImageError(
      `That image is larger than ${MAX_WATERMARK_FILE_BYTES / (1024 * 1024)} MB.`,
    )
  }

  const original = await readAsDataUrl(file)
  const image = await loadImage(original)
  const { naturalWidth: width, naturalHeight: height } = image
  if (!(width > 0) || !(height > 0)) {
    throw new WatermarkImageError('That image is empty.')
  }

  const longest = Math.max(width, height)
  if (longest <= MAX_WATERMARK_STORED_EDGE) {
    // Already small enough: kept byte-for-byte rather than re-encoded, so a
    // logo that was authored as a compact PNG is not inflated by a round trip
    // through the canvas.
    return { dataUrl: original, name: file.name, width, height }
  }

  const scale = MAX_WATERMARK_STORED_EDGE / longest
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new WatermarkImageError('This browser cannot resize images.')
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight)

  return {
    dataUrl: canvas.toDataURL('image/png'),
    name: file.name,
    width: targetWidth,
    height: targetHeight,
  }
}
