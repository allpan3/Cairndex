import type { JobRead } from '../api/client'

/** Snapshots of the jobs this client is watching, keyed by job id.
 *
 * There used to be one slot instead of a map, on the assumption that one
 * maintenance flow runs at a time. Two do, routinely: the Update flow hands
 * metadata and storyboards to background watchers and returns, so pressing
 * Update again while a storyboard pass is still going left two pollers writing
 * to the same slot half a second apart. One progress row was rendered and its
 * identity flipped between the two jobs — a label, a count and a bar that each
 * belonged to a different job every 500 ms (owner-reported, 2026-08-28).
 */
export type LiveJobs = Record<string, JobRead>

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Fold one polled snapshot into the map.
 *
 * `null` means "the flow that was reporting has settled", which is not the same
 * as "nothing is running": another flow may still be watching its own job. So it
 * drops what has finished and leaves the rest alone. A snapshot that is still
 * running or queued therefore only ever leaves the map by finishing, which is
 * what keeps two overlapping flows from evicting each other.
 */
export function trackJobSnapshot(live: LiveJobs, snapshot: JobRead | null): LiveJobs {
  if (snapshot === null) {
    const remaining = Object.entries(live).filter(([, job]) => !TERMINAL.has(job.status))
    return remaining.length === Object.keys(live).length ? live : Object.fromEntries(remaining)
  }
  return { ...live, [snapshot.id]: snapshot }
}

/**
 * The rows to show: the server's list, with this client's fresher copy of any
 * job it is watching, plus anything it is watching that the server has not
 * reported yet.
 *
 * The server's list is authoritative about what *exists* (a page load has to
 * find work already in progress, and a job started elsewhere is still work);
 * the local snapshots poll twice as often, and appear before the first server
 * poll of a job lands. Server ordering is preserved because it is queue order.
 */
export function mergeJobRows(rows: JobRead[], live: LiveJobs): JobRead[] {
  const merged = rows.map((row) => live[row.id] ?? row)
  const listed = new Set(rows.map((row) => row.id))
  for (const job of Object.values(live)) if (!listed.has(job.id)) merged.push(job)
  return merged
}
