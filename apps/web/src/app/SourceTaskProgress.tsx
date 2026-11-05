import { useState } from 'react'
import { formatBytes } from '../lib/format'
import { newFolderError } from './sourceActions'
import {
  folderLabel,
  noun,
  parentFolder,
  taskProgress,
  transferProgress,
  type SourceTask,
} from './sourceTasks'
import type { SourceTasks } from './useSourceTasks'

/** Visible file activity, including direct actions for stopped items. */
export function SourceTaskProgress({ tasks }: { tasks: SourceTasks }) {
  if (tasks.tasks.length === 0) return null
  return (
    <div className="source-tasks" aria-label="File tasks">
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
  const transfer = transferProgress(task)
  const percent = Math.round(
    transfer && transfer.total
      ? (transfer.received / transfer.total) * 100
      : taskProgress(task) * 100,
  )
  const state = current?.state
  const speed = state && 'speed' in state ? state.speed : undefined
  const phase =
    state?.kind === 'sending' ? 'Transferring' : state?.kind === 'checking' ? 'Verifying' : 'Saving'

  if (task.running)
    return (
      <div className="job-progress source-task" role="status" aria-live="polite">
        <div className="job-progress__row">
          <span className="job-progress__label" title={task.title}>
            {task.stopping ? 'Stopping…' : task.title}
          </span>
          <span className="job-progress__count">
            {done} of {total} complete
          </span>
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
          className="job-progress__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="job-progress__bar" style={{ width: `${percent}%` }} />
        </div>
        <div className="source-task__metrics">
          {transfer && (
            <span>
              {transfer.received === 0 ? '0 B' : formatBytes(transfer.received)} of{' '}
              {transfer.total === 0 ? '0 B' : formatBytes(transfer.total)} transferred · {percent}%
            </span>
          )}
          <span>
            {speed !== undefined && speed > 0 ? `${formatBytes(speed)}/s` : 'Measuring speed…'}
          </span>
        </div>
        {current && (
          <div className="source-task__filename" title={current.name}>
            {phase}: {current.name}
            {state && 'bytes' in state && state.kind !== 'sending' && state.bytes !== undefined && (
              <> · {formatBytes(state.bytes)} processed</>
            )}
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
          disabled={task.busy}
          onClick={() => void tasks.dismiss(task.id)}
          title="Cancel remaining items"
          aria-label={`Cancel ${task.title}`}
        >
          Cancel
        </button>
      </div>
      {conflicts.map(({ item, index }) => (
        <div key={index} className="source-task__question" role="group" aria-label={item.name}>
          <span>
            “{item.name}” already exists in{' '}
            {folderLabel(parentFolder(item.request.destination ?? ''))}. Nothing was replaced.
          </span>
          <ChangeName
            disabled={task.busy}
            name={item.name}
            onChange={(name) => void tasks.rename(task.id, index, name)}
          />
          {item.request.action !== 'mkdir' && (
            <span className="source-task__choices">
              <button
                className="btn btn--sm"
                disabled={task.busy}
                onClick={() => void tasks.decide(task.id, index, 'suffix')}
              >
                Keep Both
              </button>
              <button
                className="btn btn--sm"
                title="The existing file is kept as a recoverable version"
                disabled={task.busy}
                onClick={() => void tasks.decide(task.id, index, 'replace')}
              >
                Replace
              </button>
              <button
                className="btn btn--sm"
                disabled={task.busy}
                onClick={() => void tasks.decide(task.id, index, 'skip')}
              >
                Skip
              </button>
            </span>
          )}
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
          <button
            className="btn btn--sm"
            disabled={task.busy}
            onClick={() => tasks.resume(task.id)}
          >
            {failed.length > 0 || task.error ? 'Try Again' : 'Continue'}
          </button>
        </div>
      )}
    </div>
  )
}

export function ChangeName({
  name,
  onChange,
  disabled = false,
}: {
  name: string
  onChange: (name: string) => void
  disabled?: boolean
}) {
  const [value, setValue] = useState(name)
  const error = newFolderError(value.trim())
  return (
    <form
      className="source-task__choices"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !error && value.trim() !== name) onChange(value.trim())
      }}
    >
      <label>
        New name{' '}
        <input
          disabled={disabled}
          aria-label="New name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        className="btn btn--sm"
        disabled={disabled || Boolean(error) || value.trim() === name}
      >
        Use this name
      </button>
      {error && <span role="alert">{error}</span>}
    </form>
  )
}
