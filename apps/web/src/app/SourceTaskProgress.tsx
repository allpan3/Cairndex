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
      {tasks.tasks
        .filter((task) => !task.inline || task.running)
        .map((task) => (
          <TaskRow key={task.id} task={task} tasks={tasks} />
        ))}
    </div>
  )
}

function TaskRow({ task, tasks }: { task: SourceTask; tasks: SourceTasks }) {
  // Folders a copy makes for its files are steps, not the files the owner chose
  const files = task.items.filter((item) => item.request.action !== 'mkdir')
  const counted = files.length > 0 ? files : task.items
  const total = counted.length
  const done = counted.filter((item) => item.state.kind === 'done').length
  const current = task.items.find((item) =>
    ['sending', 'checking', 'applying'].includes(item.state.kind),
  )
  const conflicts = task.items.flatMap((item, index) =>
    item.state.kind === 'exists' ? [{ item, index }] : [],
  )
  const failed = task.items.filter((item) => item.state.kind === 'failed')
  const waiting = counted.filter((item) => item.state.kind === 'waiting').length
  const transfer = transferProgress(task)
  const percent = Math.round(
    transfer && transfer.total
      ? (transfer.received / transfer.total) * 100
      : taskProgress(task) * 100,
  )
  const state = current?.state
  const speed = state && 'speed' in state ? state.speed : undefined
  const phase =
    current?.request.action === 'mkdir'
      ? 'Creating folder'
      : state?.kind === 'sending'
        ? 'Transferring'
        : state?.kind === 'checking'
          ? 'Verifying'
          : 'Saving'
  const rate =
    speed !== undefined && speed > 0
      ? `${formatBytes(speed)}/s`
      : state?.kind === 'sending'
        ? 'Measuring speed…'
        : null

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
        {(transfer || rate) && (
          <div className="source-task__metrics">
            {transfer && (
              <span>
                {`${transfer.received === 0 ? '0 B' : formatBytes(transfer.received)} of `}
                {`${transfer.total === 0 ? '0 B' : formatBytes(transfer.total)} transferred · `}
                {`${percent}%`}
              </span>
            )}
            {rate && <span>{rate}</span>}
          </div>
        )}
        {task.access && !current && (
          <div className="source-task__filename">Checking access to the network share…</div>
        )}
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
      {(failed.length > 0 || task.error) && (
        <ul className="source-task__failures" role="alert">
          {task.error && (
            <li>
              <span className="source-task__failure-message">{task.error}</span>
            </li>
          )}
          {failed.map((item, index) => (
            <li key={index}>
              <span className="source-task__failure-name" title={item.name}>
                {item.name}
              </span>
              <span className="source-task__failure-message">
                {item.state.kind === 'failed' ? item.state.message : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="source-task__actions">
        {waiting > 0 && (
          <span className="source-task__note">
            {failed.length > 0 || task.error ? '' : 'Stopped · '}
            {files.length > 0
              ? noun(waiting)
              : waiting === 1
                ? '1 folder'
                : `${waiting} folders`}{' '}
            not started
          </span>
        )}
        <button
          type="button"
          className="btn btn--sm"
          disabled={task.busy}
          onClick={() => void tasks.dismiss(task.id)}
          title="Cancel remaining items"
          aria-label={`Cancel ${task.title}`}
        >
          Cancel
        </button>
        {(failed.length > 0 || waiting > 0 || task.error) && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={task.busy}
            onClick={() => tasks.resume(task.id)}
          >
            {failed.length > 0 || task.error ? 'Try Again' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  )
}

export function ChangeName({
  name,
  onChange,
  disabled = false,
  onCancel,
  cancelDisabled = false,
}: {
  name: string
  onChange: (name: string) => void
  disabled?: boolean
  onCancel?: () => void
  cancelDisabled?: boolean
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
      {onCancel && (
        <button type="button" className="btn btn--sm" disabled={cancelDisabled} onClick={onCancel}>
          Cancel item
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </form>
  )
}
