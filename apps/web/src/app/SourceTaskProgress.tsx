import { folderLabel, noun, parentFolder, taskProgress, type SourceTask } from './sourceTasks'
import type { SourceTasks } from './useSourceTasks'

/**
 * Background source tasks in the sidebar foot, beside Update's progress: a
 * running task with Stop, then whatever a task needs from the owner (an
 * occupied name to resolve, a failure to retry). A task that ends cleanly
 * leaves the sidebar and reports in the browser's message instead.
 */
export function SourceTaskProgress({ tasks }: { tasks: SourceTasks }) {
  if (tasks.tasks.length === 0) return null
  return (
    <div className="sidebar__job-progress" aria-label="File tasks">
      {tasks.tasks.map((task) => (
        <TaskRow key={task.id} task={task} tasks={tasks} />
      ))}
    </div>
  )
}

function TaskRow({ task, tasks }: { task: SourceTask; tasks: SourceTasks }) {
  const total = task.items.length
  const done = task.items.filter((item) => item.state.kind === 'done').length
  const current = task.items.find((item) =>
    ['sending', 'checking', 'applying'].includes(item.state.kind),
  )
  const conflicts = task.items.flatMap((item, index) =>
    item.state.kind === 'exists' ? [{ item, index }] : [],
  )
  const failed = task.items.filter((item) => item.state.kind === 'failed')
  const waiting = task.items.filter((item) => item.state.kind === 'waiting').length
  const percent = Math.round(taskProgress(task) * 100)
  if (task.running)
    return (
      <div className="job-progress source-task" role="status" aria-live="polite">
        <div className="job-progress__row">
          <span className="job-progress__label" title={task.title}>
            {task.stopping ? 'Stopping…' : task.title}
          </span>
          {total > 1 && (
            <span className="job-progress__count">
              {Math.min(done + 1, total)}/{total}
            </span>
          )}
          <button
            type="button"
            className="job-progress__cancel"
            onClick={() => tasks.stop(task.id)}
            title="Stop"
            aria-label={`Stop ${task.title}`}
            disabled={task.stopping}
          >
            ×
          </button>
        </div>
        <div
          className={`job-progress__track${current?.state.kind === 'sending' ? ' job-progress__track--indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="job-progress__bar" style={{ width: `${percent}%` }} />
        </div>
        {current && (
          <div className="import-progress__name" title={current.name}>
            {current.state.kind === 'sending' ? `Sending ${current.name}` : current.name}
          </div>
        )}
      </div>
    )
  return (
    <div className="job-progress source-task">
      <div className="job-progress__row">
        <span className="job-progress__label source-task__title" title={task.title}>
          {task.title}
        </span>
        <button
          type="button"
          className="job-progress__cancel"
          onClick={() => tasks.dismiss(task.id)}
          title="Dismiss"
          aria-label={`Dismiss ${task.title}`}
        >
          ×
        </button>
      </div>
      {conflicts.map(({ item, index }) => (
        <div key={index} className="source-task__question" role="group" aria-label={item.name}>
          <span>
            “{item.name}” already exists in{' '}
            {folderLabel(parentFolder(item.request.destination ?? ''))}.
          </span>
          <span className="source-task__choices">
            <button className="btn btn--sm" onClick={() => tasks.decide(task.id, index, 'suffix')}>
              Keep Both
            </button>
            <button
              className="btn btn--sm"
              title="The existing file is kept as a recoverable version"
              onClick={() => tasks.decide(task.id, index, 'replace')}
            >
              Replace
            </button>
            <button className="btn btn--sm" onClick={() => tasks.decide(task.id, index, 'skip')}>
              Skip
            </button>
          </span>
        </div>
      ))}
      {failed.map((item, index) => (
        <p key={index} role="alert">
          {item.name}: {item.state.kind === 'failed' ? item.state.message : ''}
        </p>
      ))}
      {task.error && <p role="alert">{task.error}</p>}
      {(failed.length > 0 || waiting > 0 || task.error) && (
        <div className="source-task__choices">
          {waiting > 0 && failed.length === 0 && (
            <span className="source-task__note">Stopped · {noun(waiting)} not started</span>
          )}
          <button className="btn btn--sm" onClick={() => tasks.resume(task.id)}>
            {failed.length > 0 || task.error ? 'Try Again' : 'Continue'}
          </button>
        </div>
      )}
    </div>
  )
}
