import { catalog, operationId, runJob, type Entity, type Save } from '../../api/catalog'

/**
 * Write a portable library file's cover-frame offset, or clear it with `null`.
 *
 * The offset is ordinary authored metadata (`asset_files/<id>/cover_time`), so
 * it goes through the catalog's journaled save like any other edit, against
 * the basis read just before. The server keys the file's thumbnail by this
 * value, so the next thumbnail request extracts the chosen frame.
 */
export async function saveCoverTime(
  library: string,
  fileId: string,
  time: number | null,
  duration: number | null,
): Promise<void> {
  const entity = await catalog<Entity>(library, `/entities/asset_files/${fileId}`)
  const field = entity.fields.cover_time
  const alive = entity.fields.$alive
  if (!field || !alive) throw new Error('This file’s cover can’t be changed here.')
  if (field.held) throw new Error('Review this file’s competing cover values first.')
  const request: Save = {
    changes: [
      { unit: field.unit, value: JSON.stringify(coverOffset(time, duration)), basis: field.basis },
      { unit: alive.unit, value: 'true', basis: alive.basis },
    ],
    parents: entity.parents,
    resolve: false,
    recover: false,
  }
  await runJob(library, 'save', request, operationId())
}

/**
 * The stored offset: inside the video, as the old library's cover endpoint
 * kept it (a seek to the very end extracts no frame), and in whole
 * milliseconds so the JSON text is the same one the server would write.
 */
export function coverOffset(time: number | null, duration: number | null): number | null {
  if (time === null) return null
  const end = duration != null && duration > 0 ? Math.max(0, duration - 0.1) : Infinity
  return Math.round(Math.max(0, Math.min(time, end)) * 1000) / 1000
}
