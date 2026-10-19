import { useMemo } from 'react'
import type { DiscoveryRun } from '../api/discovery'
import type { JobNotificationSnapshot } from './jobRun'
import { useJobNotifications } from './useJobNotifications'

type Maintenance = {
  kind: 'probe' | 'storyboards' | null
  job: { id: string; state: JobNotificationSnapshot['status'] } | null
}

/** Feed the existing desktop policy from the workspace's already-polled work. */
export function usePortableJobNotifications(
  library: string,
  discovery: Pick<DiscoveryRun, 'id' | 'state'> | undefined,
  maintenance: Maintenance | undefined,
) {
  const jobs = useMemo(() => {
    const result: JobNotificationSnapshot[] = []
    if (discovery?.id && discovery.state !== 'idle') {
      result.push({
        id: `${library}/discovery/${discovery.id}`,
        job_type: 'scan',
        status: discovery.state,
        // Private jobs do not claim a persisted wall-clock start time.
        started_at: null,
        created_at: null,
      })
    }
    if (maintenance?.job && maintenance.kind) {
      result.push({
        id: `${library}/maintenance/${maintenance.job.id}`,
        job_type: maintenance.kind === 'probe' ? 'probe' : 'storyboard',
        status: maintenance.job.state,
        started_at: null,
        created_at: null,
      })
    }
    return result
  }, [library, discovery, maintenance])
  useJobNotifications(jobs)
}
