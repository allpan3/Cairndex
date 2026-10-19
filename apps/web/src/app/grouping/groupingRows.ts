import type { GroupingNode } from '../../api/grouping'

export function groupingFileSummary(node: GroupingNode): string {
  const files = `${node.files} ${node.files === 1 ? 'file' : 'files'}`
  const kinds = ['video', 'audio', 'image', 'subtitle'].filter(
    (kind) => (node.media_counts?.[kind] ?? 0) > 0,
  )
  return kinds.length ? `${files} · ${kinds.join(', ')}` : files
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
