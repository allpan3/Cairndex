import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import { bundleFiles, deleteBundles, setCollectionMembership } from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import { sourceRequest, uploadSource, type SourceJob } from '../api/sourceOperations'
import type { CatalogNotice } from './CatalogToast'
import { noun, type SourceTask, type TaskItem, type TaskItemState } from './sourceTasks'

// The server's collision refusal (`source_plan.py`); its job stops as interrupted
export const isCollision = (job: Pick<SourceJob, 'error'>) =>
  Boolean(
    job.error?.includes('Destination exists') ||
    job.error?.includes('Folder name is already in use') ||
    job.error?.includes('Folder path has catalog entries'),
  )
const PREPARING = ['queued', 'preparing']
const APPLYING = ['accepted', 'applying']

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Stopped', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Stopped', 'AbortError'))
      },
      { once: true },
    )
  })
}

const percent = (job: SourceJob, size: number | null) =>
  size && job.progress > 0 ? Math.min(99, Math.floor((job.progress / size) * 100)) : null

export type NewTask = Pick<SourceTask, 'title' | 'summary' | 'finish'> & {
  undoable?: boolean
  items: Omit<TaskItem, 'state'>[]
}

/**
 * Runs the owner's source operations in the background, one task at a time,
 * so a dialog can close the moment the owner chooses.
 *
 * Each item is its own journaled operation (ADR-0036). The server prepares an
 * exact review and this accepts that review unchanged: the click that named
 * the files, the action and the destination is the owner's approval, and an
 * occupied destination stops that item for an explicit Keep Both, Replace or
 * Skip. A lost reply repeats the same intent, which the server deduplicates.
 * Stop cancels what has not been accepted; an accepted operation finishes.
 */
export function useSourceTasks(library: string, onNotice: (notice: CatalogNotice) => void) {
  const cache = useQueryClient()
  // The ref is what the running loops read; the state is what renders
  const tasks = useRef<SourceTask[]>([])
  const [list, setList] = useState<SourceTask[]>([])
  const commit = useCallback((next: SourceTask[]) => {
    tasks.current = next
    setList(next)
  }, [])
  const uploaded = useRef(new Set<string>())
  const controllers = useRef(new Map<string, AbortController>())
  const created = useRef(new Map<string, string>())
  const queue = useRef(Promise.resolve())
  useEffect(() => {
    const running = controllers.current
    return () => running.forEach((controller) => controller.abort())
  }, [])
  // Bytes still on their way exist only in this window
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (tasks.current.some((task) => task.running && task.items.some((item) => item.file)))
        event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const find = (id: string) => tasks.current.find((task) => task.id === id)
  const patch = useCallback(
    (id: string, change: (task: SourceTask) => SourceTask) =>
      commit(tasks.current.map((task) => (task.id === id ? change(task) : task))),
    [commit],
  )
  const setItem = useCallback(
    (id: string, index: number, change: Partial<TaskItem> & { state: TaskItemState }) =>
      patch(id, (task) => ({
        ...task,
        items: task.items.map((item, at) => (at === index ? { ...item, ...change } : item)),
      })),
    [patch],
  )

  async function settle(
    job: SourceJob,
    waiting: string[],
    signal: AbortSignal,
    show: (job: SourceJob) => void,
  ) {
    while (waiting.includes(job.state)) {
      await sleep(400, signal)
      job = await sourceRequest<SourceJob>(library, `/${job.id}`)
      show(job)
    }
    return job
  }

  async function runItem(id: string, index: number, signal: AbortSignal, scope: () => void) {
    const item = find(id)!.items[index]!
    const { request, file, size } = item
    let queued: SourceJob | null = null
    let accepted = false
    let sampled = performance.now()
    let previousBytes = 0
    const reading = (bytes: number) => {
      const now = performance.now()
      const elapsed = (now - sampled) / 1000
      const speed = elapsed > 0 ? Math.max(0, bytes - previousBytes) / elapsed : 0
      sampled = now
      previousBytes = bytes
      return { bytes, speed }
    }
    try {
      if (file && request.upload && !uploaded.current.has(request.upload)) {
        setItem(id, index, { state: { kind: 'sending' } })
        await uploadSource(library, request.upload, file, signal, (bytes) => {
          const measured = reading(bytes)
          setItem(id, index, { uploaded: bytes, state: { kind: 'sending', ...measured } })
        })
        uploaded.current.add(request.upload)
        scope()
      }
      sampled = performance.now()
      previousBytes = 0
      setItem(id, index, { state: { kind: 'checking', percent: null } })
      queued = await sourceRequest<SourceJob>(library, '', 'POST', request)
      scope()
      // A request that stopped for another reason is retried explicitly
      if (queued.state === 'interrupted' && !isCollision(queued))
        queued = await sourceRequest<SourceJob>(library, `/${queued.id}/retry`, 'POST')
      let job = await settle(queued, PREPARING, signal, (next) =>
        setItem(id, index, {
          state: { kind: 'checking', percent: percent(next, size), ...reading(next.progress) },
        }),
      )
      if (job.state === 'prepared') {
        setItem(id, index, { state: { kind: 'applying', percent: null } })
        job = await sourceRequest<SourceJob>(library, `/${job.id}/accept`, 'POST', {
          receipt: job.receipt,
        })
      }
      // Also reached when a repeated request was accepted before its reply was lost
      if (APPLYING.includes(job.state)) {
        accepted = true
        sampled = performance.now()
        previousBytes = 0
        job = await settle(job, APPLYING, new AbortController().signal, (next) =>
          setItem(id, index, {
            state: { kind: 'applying', percent: percent(next, size), ...reading(next.progress) },
          }),
        )
      }
      scope()
      const review = job.review as {
        skipped?: boolean
        destination?: string
        output_id?: string | null
        destination_id?: string | null
      } | null
      if (job.state === 'succeeded')
        setItem(id, index, {
          state: {
            kind: 'done',
            destination: review?.destination ?? request.destination ?? '',
            operation: job.id,
            skipped: Boolean(review?.skipped),
            file: review?.output_id ?? null,
            created: !review?.skipped && !review?.destination_id,
          },
        })
      else if (isCollision(job) && !job.result?.started)
        setItem(id, index, { state: { kind: 'exists' } })
      else
        setItem(id, index, {
          state: { kind: 'failed', message: job.error ?? `It stopped (${job.state}).` },
        })
    } catch (reason) {
      if (signal.aborted && !accepted) {
        // Nothing reached the library; a new intent keeps any received bytes
        if (queued) await sourceRequest(library, `/${queued.id}`, 'DELETE').catch(() => undefined)
        setItem(id, index, {
          request: { ...request, operation: operationId() },
          state: { kind: 'waiting' },
        })
        return
      }
      setItem(id, index, { state: { kind: 'failed', message: (reason as Error).message } })
    }
  }

  // The bundle step runs once every item landed; a failure keeps the files and says so.
  // A copy is catalogued at once in a provisional bundle of its own, so the
  // files are bundled by the identities the operations report.
  async function finish(id: string) {
    const task = find(id)!
    const landed = task.items.flatMap((item) =>
      item.state.kind === 'done' && !item.state.skipped && item.state.file ? [item.state.file] : [],
    )
    try {
      let summary = task.summary
      if (task.finish.kind === 'new-bundle' && landed.length > 0) {
        const bundle = await bundleFiles(library, landed, null, task.finish.title || null)
        created.current.set(id, bundle)
        for (const collection of task.finish.collections)
          await setCollectionMembership(library, [bundle], collection, true)
        summary = `Created “${task.finish.title || 'Untitled bundle'}” with ${noun(landed.length)}.`
      } else if (task.finish.kind === 'add-to-bundle' && landed.length > 0) {
        await bundleFiles(library, landed, task.finish.bundle, null)
        summary = `Added ${noun(landed.length)} to “${task.finish.title}”.`
      } else if (task.finish.kind === 'delete-bundle') {
        await deleteBundles(library, [task.finish.bundle]).catch(() => undefined)
      }
      commit(tasks.current.filter((item) => item.id !== id))
      // Counts and views that read the bundles changed again
      if (task.finish.kind !== 'none') void cache.invalidateQueries()
      const done = task.items.flatMap((item) => (item.state.kind === 'done' ? [item.state] : []))
      // Bundled copies are undone through the Trash (see `undo`), which only
      // takes back files this task made; a Replace stays, with its old version kept
      const undoable =
        task.undoable &&
        done.some((state) => !state.skipped) &&
        (task.finish.kind === 'none' || done.every((state) => state.skipped || state.created))
      onNotice({
        text: summary,
        action: undoable ? { label: 'Undo', run: () => undo(task) } : undefined,
      })
    } catch (reason) {
      patch(id, (current) => ({
        ...current,
        error: `The files were copied, but the bundle was not made: ${(reason as Error).message}`,
      }))
    }
  }

  async function run(id: string, indexes: number[]) {
    if (!find(id)) return
    if (find(id)?.stopping) {
      patch(id, (task) => ({ ...task, running: false, stopping: false }))
      return
    }
    const scope = captureRequestScope()
    const controller = new AbortController()
    controllers.current.set(id, controller)
    patch(id, (task) => ({ ...task, running: true, stopping: false, error: '' }))
    try {
      for (const index of indexes) {
        if (controller.signal.aborted) break
        await runItem(id, index, controller.signal, scope)
      }
    } finally {
      controllers.current.delete(id)
      patch(id, (task) => ({ ...task, running: false, stopping: false }))
      void cache.invalidateQueries()
    }
    if (find(id)?.items.every((item) => item.state.kind === 'done')) await finish(id)
  }

  const enqueue = (id: string, indexes: number[]) => {
    patch(id, (task) => ({ ...task, running: true, busy: false }))
    queue.current = queue.current.then(() => run(id, indexes)).catch(() => undefined)
  }

  function start(task: NewTask, inline = false) {
    const id = operationId()
    commit([
      ...tasks.current,
      {
        ...task,
        id,
        inline,
        undoable: task.undoable ?? true,
        items: task.items.map((item) => ({ ...item, state: { kind: 'waiting' } })),
        running: false,
        stopping: false,
        error: '',
      },
    ])
    enqueue(
      id,
      task.items.map((_, index) => index),
    )
    return id
  }

  /**
   * Undo is one new journaled operation per landed item, approved by the click.
   * A plain copy, move, rename or trash has its exact inverse. Bundling changed
   * the copies' metadata after they landed, which that inverse refuses, so
   * bundled copies go to the Trash instead (still recoverable), and a bundle
   * the task made is removed once they are gone.
   */
  function undo(task: SourceTask) {
    const bundle = created.current.get(task.id)
    const landed = task.items.flatMap((item) =>
      item.state.kind === 'done' && !item.state.skipped ? [{ item, state: item.state }] : [],
    )
    const bundled = task.finish.kind === 'new-bundle' || task.finish.kind === 'add-to-bundle'
    start({
      title: `Undoing: ${task.summary.replace(/\.$/, '')}`,
      summary: bundled ? `Moved ${noun(landed.length)} to the Trash.` : 'Undone.',
      undoable: false,
      finish: bundle ? { kind: 'delete-bundle', bundle } : { kind: 'none' },
      items: landed.map(({ item, state }) => ({
        name: item.name,
        size: null,
        request: bundled
          ? {
              operation: operationId(),
              action: 'trash',
              source: state.destination,
              destination: '',
            }
          : { operation: operationId(), action: 'undo', prior: state.operation },
      })),
    })
  }

  return {
    tasks: list,
    start,
    async name(task: NewTask): Promise<void> {
      const id = start(task, true)
      await queue.current
      const stopped = find(id)
      if (!stopped) return
      if (stopped.items[0]?.state.kind === 'exists') {
        // A rejected name has changed no files. Retire that intent; a corrected
        // name gets a fresh one. Older rejected intents are also omitted from
        // the recovery list if cancellation could not reach the server.
        await sourceRequest(library, `/${stopped.items[0].request.operation}`, 'DELETE').catch(
          () => undefined,
        )
        commit(tasks.current.filter((task) => task.id !== id))
        throw new Error('This name is already in use.')
      }
      // Real interruptions still need the existing recovery path.
      patch(id, (task) => ({ ...task, inline: false }))
      const state = stopped.items[0]?.state
      throw new Error(state?.kind === 'failed' ? state.message : 'The operation did not finish.')
    },
    stop(id: string) {
      patch(id, (task) => ({ ...task, stopping: true }))
      controllers.current.get(id)?.abort()
    },
    /** Answer an occupied name with a new intent over the same received bytes. */
    async decide(id: string, index: number, collision: 'suffix' | 'replace' | 'skip') {
      const item = find(id)?.items[index]
      if (!item || item.state.kind !== 'exists' || find(id)?.running || find(id)?.busy) return
      patch(id, (task) => ({ ...task, busy: true }))
      try {
        await sourceRequest(library, `/${item.request.operation}`, 'DELETE')
      } catch (error) {
        patch(id, (task) => ({ ...task, busy: false }))
        onNotice({ text: (error as Error).message, alert: true })
        return
      }
      setItem(id, index, {
        request: { ...item.request, operation: operationId(), collision },
        state: { kind: 'waiting' },
      })
      enqueue(id, [index])
    },
    async rename(id: string, index: number, name: string) {
      const item = find(id)?.items[index]
      if (!item || item.state.kind !== 'exists' || find(id)?.running || find(id)?.busy) return
      patch(id, (task) => ({ ...task, busy: true }))
      try {
        await sourceRequest(library, `/${item.request.operation}`, 'DELETE')
        const destination = item.request.destination ?? ''
        const slash = destination.lastIndexOf('/')
        setItem(id, index, {
          name,
          request: {
            ...item.request,
            operation: operationId(),
            destination: destination.slice(0, slash + 1) + name,
            collision: 'fail',
          },
          state: { kind: 'waiting' },
        })
        if (find(id)?.items.length === 1)
          patch(id, (task) => ({
            ...task,
            title: task.title.replaceAll(item.name, name),
            summary: task.summary.replaceAll(item.name, name),
          }))
        enqueue(id, [index])
      } catch (error) {
        patch(id, (task) => ({ ...task, busy: false }))
        onNotice({ text: (error as Error).message, alert: true })
      }
    },
    /** Try the stopped, failed or unfinished items again, or the bundle step. */
    resume(id: string) {
      const task = find(id)
      if (!task || task.running || task.busy) return
      const open = task.items.flatMap((item, index) =>
        item.state.kind === 'waiting' || item.state.kind === 'failed' ? [index] : [],
      )
      if (open.length > 0) enqueue(id, open)
      else if (task.items.every((item) => item.state.kind === 'done')) void finish(id)
    },
    async dismiss(id: string) {
      const task = find(id)
      if (!task || task.running || task.busy) return
      patch(id, (task) => ({ ...task, busy: true }))
      try {
        for (const item of task.items) {
          if (
            item.state.kind === 'done' ||
            item.state.kind === 'waiting' ||
            (item.request.upload && !uploaded.current.has(item.request.upload))
          )
            continue
          await sourceRequest(library, `/${item.request.operation}`, 'DELETE')
        }
        commit(tasks.current.filter((task) => task.id !== id))
        await cache.invalidateQueries({ queryKey: ['source-operations', library] })
      } catch (error) {
        patch(id, (task) => ({ ...task, busy: false }))
        onNotice({ text: (error as Error).message, alert: true })
      }
    },
  }
}

export type SourceTasks = ReturnType<typeof useSourceTasks>
