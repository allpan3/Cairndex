import { expect, it } from 'vitest'
import type { GroupingNode } from '../../api/grouping'
import { groupingFileSummary, groupingRuns } from './groupingRows'

function node(id: string, changes: Partial<GroupingNode> = {}): GroupingNode {
  return {
    id,
    parent: null,
    kind: 'bundle',
    title: id,
    directory: 'Synthetic',
    target: null,
    original_target: null,
    target_title: null,
    collection: null,
    context: false,
    position: 0,
    confidence: 1,
    reason: 'Matching names',
    files: 3,
    selected: 3,
    bundles: 1,
    children: 0,
    folders: 0,
    media_counts: { video: 1, image: 1, subtitle: 1 },
    ...changes,
  }
}

it('summarizes media without fetching file lists and never hides uncertain or distinct rows', () => {
  const nodes = [node('one'), node('two'), node('three')]
  expect(groupingFileSummary(nodes[0]!)).toBe('3 files · video, image, subtitle')
  expect(groupingRuns(nodes)).toMatchObject([{ rolled: true, nodes }])
  const uncertain = node('uncertain', { confidence: 0.5 })
  const addition = node('addition', { target: 'existing' })
  const different = node('different', { media_counts: { video: 3 } })
  const unknown = node('older-response', { media_counts: undefined })
  expect(
    groupingRuns([nodes[0]!, uncertain, addition, different, unknown, ...nodes]),
  ).toMatchObject([
    { rolled: false },
    { rolled: false },
    { rolled: false },
    { rolled: false },
    { rolled: false },
    { rolled: true },
  ])
  expect(groupingRuns(nodes, false).every((run) => !run.rolled)).toBe(true)
})

it('keeps run identity through selection and rename and bounds exact bulk changes', () => {
  const nodes = Array.from({ length: 103 }, (_, i) => node(`bundle-${i}`, { position: i }))
  const before = groupingRuns(nodes)
  expect(before.map((run) => run.nodes.length)).toEqual([50, 50, 3])
  const edited = groupingRuns(nodes.map((item) => ({ ...item, selected: 0, title: 'Renamed' })))
  expect(edited.map((run) => run.key)).toEqual(before.map((run) => run.key))
  expect(
    groupingRuns(nodes.map((item) => ({ ...item, id: `regenerated-${item.id}` }))).map(
      (run) => run.key,
    ),
  ).toEqual(before.map((run) => run.key))
  expect(edited.flatMap((run) => run.nodes.map((item) => item.id))).toEqual(
    nodes.map((item) => item.id),
  )
})
