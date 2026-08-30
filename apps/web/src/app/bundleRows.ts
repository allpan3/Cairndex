/**
 * Composing a bundle's rows from its files and its folder members (plan 6).
 *
 * A folder member stands in for its files as one row, so two surfaces need to
 * agree on which files a folder covers: the inspector rail, which replaces the
 * covered rows with a folder row, and the viewer, whose playlist leaves them
 * out. Both derive it here rather than each writing the containment test.
 */
import type { DirectoryMember, FileRead } from '../api/client'

export type BundleRow =
  | { kind: 'file'; id: string; sequence: number; file: FileRead }
  | { kind: 'folder'; id: string; sequence: number; member: DirectoryMember }

/**
 * Whether a file sits inside a folder member — the directory itself or any
 * depth beneath it.
 *
 * Derived from `relative_path` rather than a `directory_path` the API does not
 * send, and equivalent: a file directly in `p` has the path `p/name`, one in a
 * subfolder has `p/sub/name`, and both start with `p/`. The trailing slash is
 * what stops `album2` from being read as inside `album`.
 */
export function isInside(
  file: { relative_path: string },
  member: { directory_path: string },
): boolean {
  return file.relative_path.startsWith(`${member.directory_path}/`)
}

/** The folder member covering this file, or null when it stands on its own. */
export function memberCovering<M extends { directory_path: string }>(
  file: { relative_path: string },
  members: M[],
): M | null {
  return members.find((member) => isInside(file, member)) ?? null
}

/**
 * Split files into the ones a folder row hides and the ones still drawn.
 *
 * Shared by the inspector rail and the grouping review dialog, which face the
 * same question about different shapes — a bundle's files against its folder
 * members, and a proposal's files against the folders it would create. Both ask
 * "does this path sit under that directory", and writing it twice is how the two
 * surfaces would come to disagree about what a folder contains.
 */
export function splitByFolder<F extends { relative_path: string }>(
  files: F[],
  members: { directory_path: string }[],
): { loose: F[]; covered: F[] } {
  const loose: F[] = []
  const covered: F[] = []
  for (const file of files) {
    if (memberCovering(file, members) === null) loose.push(file)
    else covered.push(file)
  }
  return { loose, covered }
}

/**
 * The bundle's rows in one order: files that no folder covers, plus one row per
 * folder, interleaved by the sequence they share.
 *
 * The tie-break on id matches the server's `ORDER BY sequence, id`, so a folder
 * and a file that were given the same sequence do not swap places between a
 * fetch and a local recompute.
 */
export function bundleRows(files: FileRead[], members: DirectoryMember[]): BundleRow[] {
  const rows: BundleRow[] = [
    ...files
      .filter((file) => memberCovering(file, members) === null)
      .map<BundleRow>((file) => ({
        kind: 'file',
        id: file.id,
        sequence: file.sequence,
        file,
      })),
    ...members.map<BundleRow>((member) => ({
      kind: 'folder',
      id: member.id,
      sequence: member.sequence,
      member,
    })),
  ]
  return rows.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The files the viewer pages through.
 *
 * Two cases, because a folder's contents are browsable without being part of
 * the bundle's own run of media:
 *
 * - Playing the bundle skips them — "play this bundle" means its own media, not
 *   the thousand photos inside a folder member.
 * - Opening one *of* them pages through that folder instead, which is the
 *   next/previous the plan expects from the File Browser handoff. Filtering
 *   them out here too would strand the viewer on a file its own playlist
 *   claimed did not exist.
 */
export function playlistFor(
  files: FileRead[],
  members: DirectoryMember[],
  initialFileId?: string | null,
): FileRead[] {
  const playable = files.filter(
    (file) => file.supported && (file.media_kind === 'image' || file.media_kind === 'video'),
  )
  const opened = initialFileId ? playable.find((file) => file.id === initialFileId) : undefined
  const inside = opened ? memberCovering(opened, members) : null
  if (inside) return playable.filter((file) => isInside(file, inside))
  return playable.filter((file) => memberCovering(file, members) === null)
}

/** One drawn entry in a grouping suggestion's file list. */
export type ProposalEntry<F extends { relative_path: string; sequence: number }, D> =
  | { kind: 'file'; key: string; index: number; file: F }
  | { kind: 'folder'; key: string; index: number; directory: D; contents: F[] }

/**
 * A suggestion's files and its folder rows, in one order.
 *
 * **A folder is anchored where its files begin**, not appended after them. That
 * single rule covers both states: collapsed, the row sits exactly where the
 * files it replaces would have been; listed, it reads as a header immediately
 * above them. Drawing every folder after the loose files instead left a listed
 * folder stranded at the very bottom, an apparently empty row nowhere near the
 * files it belonged to (owner-reported, 2026-08-29).
 *
 * ``index`` is each file's position in the *original* list, because that is what
 * a drop target means — the visible position stops matching as soon as a folder
 * hides or reorders anything.
 */
export function proposalEntries<
  F extends { relative_path: string; sequence: number },
  D extends { id: string; directory_path: string },
>(files: F[], directories: D[], keyOf: (file: F) => string): ProposalEntry<F, D>[] {
  // Tolerates an absent list rather than throwing. A proposal always carries
  // `directories` — the field is required in the response — but the cost of
  // being wrong about that is the whole review dialog rendering nothing, which
  // is a far worse failure than a suggestion drawn without its folder rows.
  const folders = directories ?? []
  const contents = new Map<string, F[]>()
  const owner = new Map<string, D>()
  for (const directory of folders) {
    const inside = files.filter((file) => isInside(file, directory))
    contents.set(directory.id, inside)
    for (const file of inside) owner.set(keyOf(file), directory)
  }
  const indexOf = new Map(files.map((file, index) => [keyOf(file), index]))

  const entries: (ProposalEntry<F, D> & { at: number })[] = []
  for (const file of files) {
    if (owner.has(keyOf(file))) continue
    entries.push({
      kind: 'file',
      key: keyOf(file),
      index: indexOf.get(keyOf(file)) ?? 0,
      at: file.sequence,
      file,
    })
  }
  for (const directory of folders) {
    const inside = contents.get(directory.id) ?? []
    if (inside.length === 0) continue
    entries.push({
      kind: 'folder',
      key: directory.id,
      index: indexOf.get(keyOf(inside[0] as F)) ?? 0,
      // Where its files begin. A folder and the first file it covers therefore
      // share a position, and the tie-break below puts the folder first — it is
      // a header over them, not a peer.
      at: Math.min(...inside.map((file) => file.sequence)),
      directory,
      contents: inside,
    })
  }
  entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1))
  // `at` was only ever the sort key; the caller renders in the order returned.
  return entries.map((entry) => {
    const { at, ...rest } = entry
    void at
    return rest as ProposalEntry<F, D>
  })
}
