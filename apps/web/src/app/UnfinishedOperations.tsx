import type { SourceJob } from '../api/sourceOperations'
import { SourceOperationReview } from './SourceOperationReview'
import type { SourceTasks } from './useSourceTasks'

/** Each waiting operation with its saved review: apply, retry or cancel it. */
export function UnfinishedOperations({
  library,
  operations,
  enabled,
  tasks,
}: {
  library: string
  operations: SourceJob[]
  enabled: boolean
  tasks: SourceTasks
}) {
  if (operations.length === 0) return null
  return (
    <div className="source-operation-panel source-stopped" aria-label="Stopped file operations">
      {operations.map((job) => (
        <SourceOperationReview
          key={job.id}
          library={library}
          operation={job.id}
          enabled={enabled}
          // A changed request is a new intent; it runs as a task like any other
          onPrepare={(request) =>
            tasks.start({
              title: 'Preparing a file operation',
              summary: 'Done.',
              finish: { kind: 'none' },
              items: [
                { name: request.destination || request.source || job.id, size: null, request },
              ],
            })
          }
        />
      ))}
    </div>
  )
}
