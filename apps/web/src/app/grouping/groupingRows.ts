import type { GroupingNode } from '../../api/grouping'

export function groupingFileSummary(node: GroupingNode): string {
  const files = `${node.files} ${node.files === 1 ? 'file' : 'files'}`
  const kinds = ['video', 'audio', 'image', 'subtitle'].filter(
    (kind) => (node.media_counts?.[kind] ?? 0) > 0,
  )
  return kinds.length ? `${files} · ${kinds.join(', ')}` : files
}

/** Suggestions the review flags, matching the server's uncertain count */
export function needsLook(node: GroupingNode): boolean {
  return node.kind === 'bundle' && !node.context && node.files > 0 && node.confidence < 0.75
}

/** The title a row shows. In the additions section its heading already says
 * "Add to existing bundles", so the row names only the bundle. */
export function groupingTitle(node: GroupingNode, inAdditions = false): string {
  if (!node.target) return node.title
  const bundle = node.target_title ?? node.title
  return inAdditions ? bundle : `Add to ${bundle}`
}

/** Whether the kind glyph can convert this row, as the server allows it */
export function convertible(node: GroupingNode): boolean {
  return node.kind === 'container' ? !node.context : !node.target && node.files > 0
}

function shape(node: GroupingNode): string | null {
  if (
    node.kind !== 'bundle' ||
    node.context ||
    node.target ||
    node.children ||
    !node.files ||
    node.confidence < 0.75 ||
    !node.media_counts
  )
    return null
  return JSON.stringify([
    node.files,
    Object.entries(node.media_counts).sort(([a], [b]) => a.localeCompare(b)),
    node.reason,
  ])
}

// Runs cover only loaded siblings. Fifty members fit one guarded selection
// command; paging never changes the selection of rows that have not been loaded.
export function groupingRuns(nodes: GroupingNode[], rollUp = true) {
  const runs: { key: string; nodes: GroupingNode[]; shape: string | null }[] = []
  for (const node of nodes) {
    const key = rollUp ? shape(node) : null
    const prior = runs.at(-1)
    if (key !== null && prior?.shape === key && prior.nodes.length < 50) {
      prior.nodes.push(node)
    } else {
      // Regrouping replaces row IDs. Keep an opened run at the same logical
      // position open through those edits and through inline title changes.
      runs.push({
        key: `run:${JSON.stringify([node.parent, node.directory, node.position])}`,
        nodes: [node],
        shape: key,
      })
    }
  }
  return runs.map((run) => ({ ...run, rolled: run.shape !== null && run.nodes.length >= 3 }))
}
