import type { SourceRequest } from '../api/sourceOperations'

/** Where one item of a background source task stands. */
export type TaskItemState =
  | { kind: 'waiting' }
  | { kind: 'sending'; bytes?: number; speed?: number }
  | { kind: 'checking'; percent: number | null; bytes?: number; speed?: number }
  | { kind: 'applying'; percent: number | null; bytes?: number; speed?: number }
  | {
      kind: 'done'
      destination: string
      operation: string
      skipped: boolean
      /** The catalog file at the destination, and whether this operation made it. */
      file: string | null
      created: boolean
    }
  | { kind: 'exists' }
  | { kind: 'failed'; message: string }

/** One journaled operation inside a task, with the bytes it uploads first, if any. */
export interface TaskItem {
  name: string
  size: number | null
  file?: File
  request: SourceRequest
  state: TaskItemState
  uploaded?: number
}

/** What happens once every item of a task has landed. */
export type TaskFinish =
  | { kind: 'none' }
  | { kind: 'new-bundle'; title: string; collections: string[] }
  | { kind: 'add-to-bundle'; bundle: string; title: string }
  | { kind: 'delete-bundle'; bundle: string }

/**
 * A group of source operations the owner started with one click: files copied
 * in from this computer, a move, a trash or an undo. It runs in the background
 * and reports in a floating activity card; only a question (an occupied name) or a failure
 * keeps it there after it ends.
 */
export interface SourceTask {
  id: string
  /** Present-tense headline while it runs, such as "Copying 3 files to Trips". */
  title: string
  /** Past-tense message once it ends, such as "Copied 3 files to Trips". */
  summary: string
  /** Whether Undo is offered when it ends; an undo is not undone again. */
  undoable: boolean
  items: TaskItem[]
  finish: TaskFinish
  running: boolean
  stopping: boolean
  busy?: boolean
  /** Waiting for macOS to let the server use the network share's saved login. */
  access?: boolean
  /** Naming stays in its editor until the server accepts or rejects it. */
  inline?: boolean
  /** A failure of the finishing step, after every item landed. */
  error: string
}

export const noun = (count: number) => (count === 1 ? '1 file' : `${count.toLocaleString()} files`)

/** The folder's own name, or "Library" for the root. */
export const folderLabel = (folder: string) => (folder ? folder.split('/').at(-1)! : 'Library')

export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

export const parentFolder = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

const stem = (name: string) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name)

/**
 * A name for the bundle the dropped files become: the stem they share
 * ("Harbor at dusk" for its .mp4 and .srt), else the largest file's stem,
 * which is usually the main media rather than a sidecar.
 */
export function suggestBundleTitle(files: { name: string; size: number }[]): string {
  if (files.length === 0) return ''
  const stems = files.map((file) => stem(file.name))
  let shared = stems[0]!
  for (const next of stems.slice(1)) {
    let length = 0
    while (length < shared.length && shared[length] === next[length]) length += 1
    shared = shared.slice(0, length)
  }
  // A prefix that stops inside a word ("clip-0" of clip-01 and clip-02) keeps whole words
  const word = /[\p{L}\p{N}]/u
  if (
    word.test(shared.at(-1) ?? '') &&
    stems.some((name) => name.length > shared.length && word.test(name[shared.length]!))
  )
    shared = shared.replace(/[\p{L}\p{N}]+$/u, '')
  shared = shared.replace(/[\s._-]+$/, '')
  if (shared.length >= 3) return shared
  const largest = files.reduce((best, file) => (file.size > best.size ? file : best))
  return stem(largest.name)
}

/** Where a view's bundles are stored, as a hint for where a new one belongs. */
export interface BundleHome {
  /** The folder a new bundle goes into, or whose subfolder it gets. */
  folder: string
  /** Whether each bundle has a folder of its own inside `folder`. */
  perBundle: boolean
}

/**
 * Reads the layout from one file path per bundle. Bundles that share a folder
 * put a new bundle beside them in that folder. Bundles that each have their
 * own folder put a new bundle in a new folder under their common parent, never
 * inside another bundle's folder.
 */
export function bundleHome(paths: (string | null | undefined)[]): BundleHome | null {
  const counts = new Map<string, number>()
  for (const path of paths)
    if (path) counts.set(parentFolder(path), (counts.get(parentFolder(path)) ?? 0) + 1)
  if (counts.size === 0) return null
  let shared: string | null = null
  for (const [folder, count] of counts)
    if (count > 1 && (shared === null || count > counts.get(shared)!)) shared = folder
  if (shared !== null || counts.has('')) return { folder: shared ?? '', perBundle: false }
  const parents = [...counts.keys()].map((folder) => parentFolder(folder).split('/'))
  let common = parents[0]!
  for (const next of parents.slice(1)) {
    let length = 0
    while (length < common.length && common[length] === next[length]) length += 1
    common = common.slice(0, length)
  }
  return { folder: common.join('/'), perBundle: true }
}

/** A bundle name as one folder name, or null when nothing usable remains. */
export function folderNameFor(title: string): string | null {
  const name = title
    .replace(/[/\\\0]/g, '-')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  return name && name !== '-' ? name : null
}

/** Transfer bytes are separate from verification and final publication. */
export function transferProgress(task: SourceTask) {
  const items = task.items.filter((item) => item.file)
  if (!items.length) return null
  const total = items.reduce((sum, item) => sum + item.file!.size, 0)
  const received = items.reduce(
    (sum, item) => sum + Math.min(item.file!.size, item.uploaded ?? 0),
    0,
  )
  return { total, received }
}

/** How far along a task is, from 0 to 1, counting the item in progress by its percent. */
export function taskProgress(task: SourceTask): number {
  if (task.items.length === 0) return 1
  let done = 0
  for (const item of task.items) {
    if (item.state.kind === 'done') done += 1
    else if (
      (item.state.kind === 'checking' || item.state.kind === 'applying') &&
      item.state.percent !== null
    )
      done += item.state.percent / 100 / 2 + (item.state.kind === 'applying' ? 0.5 : 0)
  }
  return done / task.items.length
}

const LEAVING = new Set(['move', 'relocate', 'trash', 'retain'])

/**
 * Library paths that running Move and Trash tasks are taking out of their folder.
 * A file browser hides them at once rather than after the server confirms. A
 * failed or waiting-for-a-decision item stays visible, and a stopped task
 * shows every item it did not move.
 */
export function leavingPaths(tasks: SourceTask[]): ReadonlySet<string> {
  const paths = new Set<string>()
  for (const task of tasks)
    if (task.running && !task.inline)
      for (const item of task.items)
        if (
          LEAVING.has(item.request.action) &&
          item.request.source &&
          item.state.kind !== 'failed' &&
          item.state.kind !== 'exists'
        )
          paths.add(item.request.source)
  return paths
}
