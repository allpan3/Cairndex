// Controls one cancelable leading-and-trailing stream of work
export interface LeadingTrailingThrottle<T> {
  schedule: (value: T) => void
  flush: (value: T) => void
  cancel: () => void
}

// Coalesce repeated work to one leading call plus the latest trailing value
export function createLeadingTrailingThrottle<T>(
  waitMs: number,
  commit: (value: T) => void,
): LeadingTrailingThrottle<T> {
  let lastCommit: number | null = null
  let pending: T | null = null
  let timer: number | null = null

  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer)
    lastCommit = null
    pending = null
    timer = null
  }

  const flush = (value: T) => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    pending = null
    lastCommit = performance.now()
    commit(value)
  }

  const schedule = (value: T) => {
    const elapsed = lastCommit === null ? waitMs : performance.now() - lastCommit
    if (elapsed >= waitMs) {
      flush(value)
      return
    }
    pending = value
    if (timer === null) {
      timer = window.setTimeout(() => {
        timer = null
        if (pending !== null) flush(pending)
      }, waitMs - elapsed)
    }
  }

  return { schedule, flush, cancel }
}
