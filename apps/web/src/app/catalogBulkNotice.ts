import { CatalogBulkIncomplete } from '../api/catalogBulk'
import type { CatalogNotice } from './CatalogToast'

/** The browser selects these bundles when this event arrives; `detail` lists their ids. */
export const SELECT_BUNDLES_EVENT = 'cairndex:select-bundles'

/** A failure's message; a bulk change that left bundles unchanged offers to select them. */
export function failureNotice(reason: Error): CatalogNotice {
  if (!(reason instanceof CatalogBulkIncomplete) || !reason.unchanged.length)
    return { text: reason.message, alert: true }
  const unchanged = reason.unchanged
  return {
    text: reason.message,
    alert: true,
    action: {
      label: 'Select Unchanged',
      run: () => window.dispatchEvent(new CustomEvent(SELECT_BUNDLES_EVENT, { detail: unchanged })),
    },
  }
}
