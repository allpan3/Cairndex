import { operationId } from '../api/catalog'
import {
  discovery,
  type DiscoveryCandidate,
  type DiscoveryReview,
  type DiscoveryVerification,
} from '../api/discovery'

/** Discoveries about files already in the library, as opposed to grouping proposals */
export type FileChangeKind = 'verification' | 'repair' | 'replacement'

export function isFileChange(candidate: DiscoveryCandidate): boolean {
  return ['verification', 'repair', 'replacement'].includes(candidate.body.kind)
}

export const FILE_CHANGE_LABEL: Record<FileChangeKind, string> = {
  verification: 'Not confirmed',
  repair: 'Possibly moved',
  replacement: 'Content changed',
}

export function friendlyFileChangeError(message: string): string {
  if (message.includes('different bytes'))
    return 'The whole file is different from what Cairndex recorded. Run Update to review it as changed content.'
  return message
}

function waitPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForReadyReceipt(
  library: string,
  reviewOp: string,
  signal?: AbortSignal,
): Promise<string> {
  while (true) {
    const rev = await discovery<DiscoveryReview>(
      library,
      `/reviews/${reviewOp}`,
      'GET',
      undefined,
      signal,
    )
    if (rev.state === 'ready' && rev.receipt) return rev.receipt
    if (['failed', 'cancelled'].includes(rev.state)) {
      throw new Error(friendlyFileChangeError(rev.error ?? 'The change was not saved.'))
    }
    await waitPoll(200, signal)
  }
}

/**
 * Settle one unambiguous file-change candidate (verify when needed -> prepare -> accept).
 * Returns false when a `repair` candidate has multiple missing-file choices that need a human pick.
 */
export async function settleFileChangeCandidate(
  library: string,
  candidate: DiscoveryCandidate,
  signal?: AbortSignal,
): Promise<boolean> {
  const { body } = candidate
  const kind = body.kind as FileChangeKind
  let repairFile: string | null = null
  if (kind === 'repair') {
    const listed =
      body.choices && !body.choices_next
        ? body.choices
        : (
            await discovery<{
              items: { file_id: string; path: string }[]
              next_cursor: string | null
            }>(library, `/candidates/${candidate.id}/choices?after=`, 'GET', undefined, signal)
          ).items
    if (listed.length !== 1) return false
    repairFile = listed[0]!.file_id
  }
  const needsCheck =
    (body.unverified_count ??
      body.files.filter((item) => item.evidence.algorithm !== 'sha256').length) > 0
  let verifyOp: string | null = null
  if (needsCheck) {
    verifyOp = operationId()
    await discovery(
      library,
      '/verifications',
      'POST',
      { operation: verifyOp, candidate: candidate.id },
      signal,
    )
    while (true) {
      const check = await discovery<DiscoveryVerification>(
        library,
        `/verifications/${verifyOp}`,
        'GET',
        undefined,
        signal,
      )
      if (!['queued', 'running'].includes(check.state)) {
        if (check.state !== 'succeeded') {
          throw new Error(friendlyFileChangeError(check.error || 'The check stopped.'))
        }
        break
      }
      await waitPoll(250, signal)
    }
  }
  const reviewOp = operationId()
  await discovery(
    library,
    '/reviews',
    'POST',
    {
      operation: reviewOp,
      candidate: candidate.id,
      title: body.title,
      repair_file: repairFile,
      use_replacement: kind === 'replacement',
      ...(verifyOp ? { verification: verifyOp } : {}),
    },
    signal,
  )
  const receipt = await waitForReadyReceipt(library, reviewOp, signal)
  await discovery(library, `/reviews/${reviewOp}/accept`, 'POST', { receipt }, signal)
  while (true) {
    const rev = await discovery<DiscoveryReview>(
      library,
      `/reviews/${reviewOp}`,
      'GET',
      undefined,
      signal,
    )
    if (rev.state === 'applied') return true
    if (['failed', 'cancelled'].includes(rev.state)) {
      throw new Error(friendlyFileChangeError(rev.error ?? 'The change was not saved.'))
    }
    await waitPoll(200, signal)
  }
}
