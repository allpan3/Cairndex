import { useEffect, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import {
  grouping,
  type GroupingFile,
  type GroupingFolder,
  type GroupingNode,
  type GroupingPage,
} from '../../api/grouping'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'
import { groupingRuns } from './groupingRows'

type Scope = {
  kind: 'nodes' | 'files' | 'folders' | 'attention' | 'additions' | 'uncertain_additions'
  node: string
  after: number | string
}
type Item = GroupingNode | GroupingFile | GroupingFolder
type TreePage = GroupingPage<Item, number | string> & { pages: number }
export type TreeSection = 'additions' | 'suggestions'
export type TreeRow =
  | {
      kind: 'section'
      key: string
      depth: number
      section: TreeSection
      open: boolean
      /** Loaded section members, complete when `complete` is set */
      nodes: GroupingNode[]
      complete: boolean
    }
  | { kind: 'node'; key: string; depth: number; node: GroupingNode }
  | { kind: 'rollup'; key: string; run: string; depth: number; nodes: GroupingNode[] }
  | { kind: 'fold'; key: string; run: string; depth: number; nodes: GroupingNode[] }
  | { kind: 'file'; key: string; depth: number; node: GroupingNode; file: GroupingFile }
  | { kind: 'folder'; key: string; depth: number; node: GroupingNode; folder: GroupingFolder }
  | { kind: 'more'; key: string; depth: number; scope: Scope }
  | { kind: 'loading'; key: string; depth: number }
  | { kind: 'error'; key: string; depth: number; message: string; retry: () => void }

const scopeKey = (scope: Pick<Scope, 'kind' | 'node'>) => `${scope.kind}:${scope.node}`

// Only explicitly opened branches and requested pages are fetched. Rendering a
// large plan never recursively downloads every file or collection.
type TreeSource = Pick<GroupingWorkspaceState, 'library' | 'workspace' | 'scope'> & {
  status: Pick<GroupingWorkspaceState['status'], 'data'>
}

/** With `separateAdditions` (grouping_version 2), additions to existing bundles
 * page as their own section above a tree that excludes them. An older server
 * keeps the mixed tree it can serve. */
export function useGroupingTree(state: TreeSource, attention: boolean, separateAdditions = false) {
  const { library, workspace, scope, status } = state
  const client = useQueryClient()
  const revision = status.data?.revision ?? 0
  const ready = status.data?.state === 'ready'
  const [open, setOpen] = useState<{
    workspace: string | null
    nodes: Map<string, 'bundle' | 'container'>
    showFiles: boolean
    closed: Set<string>
  }>({ workspace, nodes: new Map(), showFiles: false, closed: new Set() })
  const [fileDragging, setFileDragging] = useState(false)
  const expanded = new Map(open.workspace === workspace ? open.nodes : [])
  if (fileDragging || (open.workspace === workspace && open.showFiles)) {
    // New pages inherit Show files; individual folds remain overrides. Cached
    // node pages already belong to these queries, so this fetches no hidden tree.
    for (const [, page] of client.getQueriesData<TreePage>({
      queryKey: ['grouping-tree', scope, library, workspace],
    })) {
      for (const item of page?.items ?? [])
        if ('kind' in item && item.kind === 'bundle' && (fileDragging || !open.closed.has(item.id)))
          expanded.set(item.id, item.kind)
    }
  }
  function setExpanded(
    update: (prior: Map<string, 'bundle' | 'container'>) => Map<string, 'bundle' | 'container'>,
  ) {
    setOpen((prior) => ({
      workspace,
      showFiles: prior.workspace === workspace && prior.showFiles,
      closed: prior.workspace === workspace ? prior.closed : new Set(),
      nodes: update(prior.workspace === workspace ? prior.nodes : new Map()),
    }))
  }
  const [pages, setPages] = useState<Record<string, number>>({})
  const [openRuns, setOpenRuns] = useState<{ workspace: string | null; keys: Set<string> }>({
    workspace,
    keys: new Set(),
  })
  function toggleRun(key: string, expanded: boolean) {
    setOpenRuns((prior) => {
      const keys = new Set(prior.workspace === workspace ? prior.keys : [])
      if (expanded) keys.add(key)
      else keys.delete(key)
      return { workspace, keys }
    })
  }
  const [closedSections, setClosedSections] = useState<{
    workspace: string | null
    keys: Set<TreeSection>
  }>({ workspace, keys: new Set() })
  function toggleSection(section: TreeSection, shown: boolean) {
    setClosedSections((prior) => {
      const keys = new Set(prior.workspace === workspace ? prior.keys : [])
      if (shown) keys.delete(section)
      else keys.add(section)
      return { workspace, keys }
    })
  }
  const rootKind = attention ? 'attention' : 'nodes'
  const additionsKind = attention ? 'uncertain_additions' : 'additions'
  const roots: Scope[] = [{ kind: rootKind, node: '', after: attention ? '' : -1 }]
  if (separateAdditions) roots.unshift({ kind: additionsKind, node: '', after: '' })
  for (const [node, kind] of expanded) {
    if (kind === 'container') {
      if (!attention) roots.push({ kind: 'nodes', node, after: -1 })
    } else roots.push({ kind: 'files', node, after: -1 }, { kind: 'folders', node, after: '' })
  }
  const requests = roots.map((root) => ({
    ...root,
    pages: pages[`${workspace}:${scopeKey(root)}`] ?? 1,
  }))
  const queries = useQueries({
    queries: requests.map((request) => ({
      // The section flag keeps a mixed page from serving the separated tree
      queryKey: [
        'grouping-tree',
        scope,
        library,
        workspace,
        request.kind,
        request.node,
        separateAdditions,
      ],
      enabled: workspace !== null && revision > 0 && ready,
      staleTime: Infinity,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<TreePage> => {
        const previous = client.getQueryData<TreePage>([
          'grouping-tree',
          scope,
          library,
          workspace,
          request.kind,
          request.node,
          separateAdditions,
        ])
        let result: TreePage =
          previous?.revision === revision
            ? previous
            : { items: [], revision, pages: 0, next_cursor: request.after }
        // A revision restarts the loaded prefix with fresh cursors. This keeps
        // later pages visible across edits without reusing stale page boundaries.
        while (result.pages < request.pages && result.next_cursor !== null) {
          const params = new URLSearchParams({
            revision: String(revision),
            after: String(result.next_cursor),
          })
          if (request.kind === 'files' || request.kind === 'folders')
            params.set('visible_only', 'true')
          const path =
            request.kind === 'attention'
              ? '/attention'
              : request.kind === 'nodes'
                ? '/nodes'
                : request.kind === 'additions' || request.kind === 'uncertain_additions'
                  ? '/additions'
                  : `/nodes/${request.node}/${request.kind}`
          if (request.kind === 'nodes' && request.node) params.set('parent', request.node)
          // Sent only to a grouping_version 2 server, which defines these parameters
          if (separateAdditions && (request.kind === 'nodes' || request.kind === 'attention'))
            params.set('exclude_additions', 'true')
          if (request.kind === 'uncertain_additions') params.set('uncertain', 'true')
          const page = await grouping<GroupingPage<Item, number | string>>(
            library,
            `/workspaces/${workspace}${path}?${params}`,
            'GET',
            undefined,
            signal,
          )
          result = { ...page, items: [...result.items, ...page.items], pages: result.pages + 1 }
        }
        return result
      },
    })),
  })
  const demand = JSON.stringify(requests.map(({ kind, node, pages }) => ({ kind, node, pages })))
  useEffect(() => {
    if (!ready || !workspace || !revision) return
    const wanted = JSON.parse(demand) as { kind: string; node: string; pages: number }[]
    void client.invalidateQueries({
      queryKey: ['grouping-tree', scope, library, workspace],
      predicate: (query) => {
        const target = wanted.find(
          (item) => item.kind === query.queryKey[4] && item.node === query.queryKey[5],
        )
        const data = query.state.data as TreePage | undefined
        return Boolean(
          target &&
          (!data ||
            data.revision !== revision ||
            (data.pages < target.pages && data.next_cursor !== null)),
        )
      },
    })
  }, [client, scope, library, workspace, revision, ready, demand])
  const loaded = (kind: Scope['kind'], node: string) =>
    requests.flatMap((request, i) =>
      request.kind === kind && request.node === node ? (queries[i]?.data?.items ?? []) : [],
    )
  const nodes = new Map<string, GroupingNode>()
  for (const request of roots.filter((item) => item.kind === 'nodes' || item.kind === 'attention'))
    for (const node of loaded(request.kind, request.node) as GroupingNode[])
      nodes.set(node.id, node)
  const root = (kind: Scope['kind']) =>
    queries[requests.findIndex((item) => item.kind === kind && item.node === '')]
  const rows: TreeRow[] = []
  function tail(kind: Scope['kind'], node: string, depth: number) {
    const indices = requests.flatMap((request, i) =>
      request.kind === kind && request.node === node ? [i] : [],
    )
    const i = indices.at(-1)
    if (i === undefined) return
    const query = queries[i]
    const request = requests[i]
    if (!query || !request) return
    const key = `${kind}:${node}:tail`
    if (query.error)
      rows.push({
        kind: 'error',
        key,
        depth,
        message: query.error.message,
        retry: () => void query.refetch(),
      })
    else if (query.isPending) rows.push({ kind: 'loading', key, depth })
    else if (query.data?.next_cursor != null)
      rows.push({
        kind: 'more',
        key,
        depth,
        scope: { ...request, after: query.data.next_cursor },
      })
  }
  function branch(
    parent: string,
    depth: number,
    kind: Scope['kind'] = parent ? 'nodes' : rootKind,
  ) {
    const siblings = loaded(kind, parent) as GroupingNode[]
    for (const run of groupingRuns(
      siblings,
      !fileDragging && !(open.workspace === workspace && open.showFiles),
    )) {
      const opened = openRuns.workspace === workspace && openRuns.keys.has(run.key)
      if (run.rolled && !opened) {
        rows.push({ kind: 'rollup', key: run.key, run: run.key, depth, nodes: run.nodes })
        continue
      }
      for (const node of run.nodes) {
        rows.push({ kind: 'node', key: node.id, depth, node })
        if (!expanded.has(node.id)) continue
        if (node.kind === 'container') branch(node.id, depth + 1)
        else {
          const folders = loaded('folders', node.id) as GroupingFolder[]
          for (const folder of folders.filter(
            (item) =>
              !folders.some(
                (parent) => !parent.expanded && item.path.startsWith(parent.path + '/'),
              ),
          ))
            rows.push({
              kind: 'folder',
              key: `${node.id}:folder:${folder.path}`,
              depth: depth + 1,
              node,
              folder,
            })
          tail('folders', node.id, depth + 1)
          for (const file of (loaded('files', node.id) as GroupingFile[]).filter(
            (item) =>
              !folders.some(
                (parent) => !parent.expanded && item.path.startsWith(parent.path + '/'),
              ),
          ))
            rows.push({
              kind: 'file',
              key: `${node.id}:file:${file.id}`,
              depth: depth + 1,
              node,
              file,
            })
          tail('files', node.id, depth + 1)
        }
      }
      if (run.rolled)
        rows.push({ kind: 'fold', key: `${run.key}:fold`, run: run.key, depth, nodes: run.nodes })
    }
    tail(kind, parent, depth)
  }
  const additions = root(additionsKind)
  const suggestions = root(rootKind)
  // Neither section is drawn until both first pages have arrived, so a late
  // first page never moves rows that are already on screen.
  const firstLoad = separateAdditions && Boolean(additions?.isPending || suggestions?.isPending)
  const sectioned =
    separateAdditions && !firstLoad && Boolean(additions?.error || additions?.data?.items.length)
  const folded =
    closedSections.workspace === workspace ? closedSections.keys : new Set<TreeSection>()
  if (firstLoad) {
    rows.push({ kind: 'loading', key: 'sections:loading', depth: 0 })
  } else if (sectioned) {
    const members = (additions?.data?.items ?? []) as GroupingNode[]
    rows.push({
      kind: 'section',
      key: 'section:additions',
      depth: 0,
      section: 'additions',
      open: !folded.has('additions'),
      nodes: members,
      complete: Boolean(additions?.data && additions.data.next_cursor === null),
    })
    if (!folded.has('additions')) branch('', 0, additionsKind)
    // A tree with no new work keeps no heading of its own
    if (
      suggestions?.error ||
      loaded(rootKind, '').length ||
      suggestions?.data?.next_cursor != null
    ) {
      rows.push({
        kind: 'section',
        key: 'section:suggestions',
        depth: 0,
        section: 'suggestions',
        open: !folded.has('suggestions'),
        nodes: [],
        complete: false,
      })
      if (!folded.has('suggestions')) branch('', 0)
    }
  } else branch('', 0)
  function toggle(node: GroupingNode) {
    const wasExpanded = expanded.has(node.id)
    setOpen((prior) => {
      const nodes = new Map(prior.workspace === workspace ? prior.nodes : [])
      const closed = new Set(prior.workspace === workspace ? prior.closed : [])
      if (wasExpanded) {
        nodes.delete(node.id)
        if (node.kind === 'bundle') closed.add(node.id)
      } else {
        nodes.set(node.id, node.kind)
        closed.delete(node.id)
      }
      return {
        workspace,
        nodes,
        closed,
        showFiles: prior.workspace === workspace && prior.showFiles,
      }
    })
  }
  return {
    rows,
    nodes,
    expanded,
    toggle,
    toggleRun,
    toggleSection,
    /** The server lists additions separately (grouping_version 2) */
    separate: separateAdditions,
    /** Rows sit inside the two section headings, one tree level down */
    sectioned,
    filesShown: open.workspace === workspace && open.showFiles,
    setFileDragging,
    stale: queries.some((query, index) => {
      if (query.data) return query.data.revision !== revision
      // Opening an uncached file list must not disable existing drop targets.
      // Loaded rows from an older revision still block every edit until refreshed.
      return !['files', 'folders'].includes(requests[index]?.kind ?? '')
    }),
    loadMore: (request: Scope) =>
      setPages((prior) => {
        const key = `${workspace}:${scopeKey(request)}`
        return { ...prior, [key]: (prior[key] ?? 1) + 1 }
      }),
    expandCollections: () =>
      setExpanded(
        (prior) =>
          new Map([
            ...prior,
            ...[...nodes.values()]
              .filter((node) => node.kind === 'container')
              .map((node) => [node.id, node.kind] as const),
          ]),
      ),
    collapseCollections: () =>
      setExpanded((prior) => new Map([...prior].filter(([, kind]) => kind !== 'container'))),
    showFiles: () =>
      setOpen((prior) => ({
        workspace,
        nodes: prior.workspace === workspace ? prior.nodes : new Map(),
        showFiles: true,
        closed: new Set(),
      })),
    hideFiles: () =>
      setOpen((prior) => ({
        workspace,
        nodes: new Map(
          prior.workspace === workspace
            ? [...prior.nodes].filter(([, kind]) => kind !== 'bundle')
            : [],
        ),
        showFiles: false,
        closed: new Set(),
      })),
  }
}

export type GroupingTreeState = ReturnType<typeof useGroupingTree>
