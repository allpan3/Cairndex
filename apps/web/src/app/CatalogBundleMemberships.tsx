import { useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import { rename, setBulkMembership, setMembership } from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import type { components } from '../api/schema'
import { CatalogChipPicker, type ChipChoice } from './CatalogChipPicker'
import { InspectorSection } from './InspectorSection'
import { TargetContextMenu } from './ContextMenu'
import { useContextMenu, type MenuEntry } from './useContextMenu'
import { PromptDialog } from './PromptDialog'
import { copiedCatalogTags } from '../api/catalogTagClipboard'
import { useCatalogTagClipboard } from './useCatalogTagClipboard'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { CollectionPickerPanel } from './CollectionPickerPanel'
import { TagPickerPanel } from './TagPickerPanel'

type Page = components['schemas']['CatalogMembershipPage']
type BulkPage = components['schemas']['CatalogBulkMembershipPage']
type Observed = Record<string, string[]>

const TITLE = { tags: 'Tags', collections: 'Collections' } as const
// Every view that shows a membership or counts one, read again together after the
// selection snapshot: a bulk change advances each bundle's lifetime basis, and the
// next bulk title or rating save must read the new one before the chips show the change.
const AFFECTED = [
  'catalog-memberships',
  'catalog-bulk-memberships',
  'catalog-browse',
  'catalog-detail',
  'catalog-navigation',
  'catalog-view-counts',
  'catalog-tag-counts',
]

/**
 * A bundle's tags or collections as chips, or a selection's: chips list what every
 * selected bundle has, as in v0.2.1, and adding or removing one changes every
 * selected bundle. The picker marks a destination only some of them have.
 */
export function CatalogBundleMemberships({
  library,
  ids,
  family,
  blocked,
  onReview,
  onOpenCollection,
  onFilterTag,
}: {
  library: string
  /** One bundle, or a selection of up to 100. */
  ids: string[]
  family: 'tags' | 'collections'
  blocked: boolean
  onReview: () => void
  onOpenCollection?: (id: string) => void
  onFilterTag?: (id: string) => void
}) {
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState<ChipChoice | null>(null)
  const [menuChip, setMenuChip] = useState<string | null>(null)
  const menu = useContextMenu()
  const clipboard = useCatalogTagClipboard(library)
  const selectionVersion = useReplicaStatus(library).data?.selection_version ?? 0
  const canPaste = selectionVersion >= 2
  // Version 4 lists only shared destinations; before it, a page of any is filtered
  const common = selectionVersion >= 4
  // v0.2.1's trees list every destination, so a pick reads its one target's bases (version 2)
  const tree = selectionVersion >= 2
  const single = ids.length === 1 ? ids[0]! : null
  const read = (q: string, after: string, assigned: boolean) =>
    single
      ? catalog<Page>(
          library,
          `/bundles/${single}/memberships/${family}?${new URLSearchParams({
            q,
            after,
            limit: '50',
            assigned: String(assigned),
          })}`,
        ).then((page) => ({
          next: page.next_cursor,
          items: page.items.map((item): ChipChoice & { observed: Observed } => ({
            id: item.id,
            name: item.name,
            path: item.path,
            state: item.assigned ? 'on' : 'off',
            held: item.held,
            observed: item.observed,
          })),
        }))
      : catalog<BulkPage>(library, '/bundles/selection/memberships', 'POST', {
          ids,
          family,
          q,
          after,
          limit: 50,
          ...(assigned ? (common ? { common } : { assigned }) : {}),
        }).then((page) => ({
          next: page.next_cursor,
          items: page.items.flatMap((item): (ChipChoice & { observed: Observed })[] =>
            assigned && item.assigned_count !== ids.length
              ? []
              : [
                  {
                    id: item.id,
                    name: item.name,
                    path: [item.name],
                    state:
                      item.assigned_count === ids.length
                        ? 'on'
                        : item.assigned_count
                          ? 'some'
                          : 'off',
                    held: item.held,
                    observed: item.observed,
                  },
                ],
          ),
        }))
  const key = single
    ? ['catalog-memberships', library, single]
    : ['catalog-bulk-memberships', library, ids]
  const assigned = useQuery({
    queryKey: [...key, family, 'assigned', common],
    queryFn: () => read('', '', true),
    refetchInterval: 2000,
  })
  const found = useInfiniteQuery({
    queryKey: [...key, family, 'search', search],
    enabled: picking && !tree,
    initialPageParam: '',
    queryFn: ({ pageParam }) => read(search.trim(), pageParam, false),
    getNextPageParam: (page) => page.next ?? undefined,
  })
  // The tree marks a destination only some selected bundles have; every page, as it shows all
  const partial = useQuery({
    queryKey: [...key, family, 'partial'],
    enabled: picking && tree && !single,
    queryFn: async () => {
      const some = new Set<string>()
      let after = ''
      do {
        const page = await catalog<BulkPage>(library, '/bundles/selection/memberships', 'POST', {
          ids,
          family,
          after,
          limit: 50,
          assigned: true,
        })
        for (const item of page.items) if (item.assigned_count < ids.length) some.add(item.id)
        after = page.next_cursor ?? ''
      } while (after)
      return some
    },
  })
  const choices = found.data?.pages.flatMap((page) => page.items) ?? []
  const chips = assigned.data?.items ?? []
  function toggle(choice: ChipChoice, assign: boolean) {
    const read = [...chips, ...choices].find((item) => item.id === choice.id)
    if (read) change(() => save(read, assign))
  }
  const save = (read: ChipChoice & { observed: Observed }, assign: boolean) =>
    single
      ? setMembership(library, single, family, read, assign)
      : setBulkMembership(library, ids, family, read, assign)
  // A tree pick reads the one destination with its current bases, as a drag onto a
  // sidebar collection does
  function pickTree(id: string, assign: boolean) {
    change(async () => {
      const page = await catalog<BulkPage>(library, '/bundles/selection/memberships', 'POST', {
        ids,
        family,
        target: id,
        limit: 1,
      })
      const item = page.items[0]
      if (!item)
        throw new Error(
          `This ${family === 'tags' ? 'tag' : 'collection'} is no longer in the library.`,
        )
      if (item.held) {
        onReview()
        return
      }
      await save({ ...item, path: [item.name], state: 'off' }, assign)
    })
  }
  function change(work: () => Promise<void>) {
    if (busy) return
    const current = captureRequestScope()
    setBusy(true)
    setError('')
    void work()
      .then(async () => {
        current()
        await client.invalidateQueries({ queryKey: ['catalog-selection', library] })
        await Promise.all(
          AFFECTED.map((name) => client.invalidateQueries({ queryKey: [name, library] })),
        )
      })
      .catch((reason: Error) => {
        try {
          current()
        } catch {
          return
        }
        setError(reason.message)
      })
      .finally(() => setBusy(false))
  }
  // Rebuilt while open, so a toggle or hold that settles enables the entries
  function tagEntries(chip: ChipChoice): MenuEntry[] {
    return [
      {
        label: `Filter Items with “${chip.name}”`,
        disabled: !onFilterTag,
        onClick: () => onFilterTag?.(chip.id),
      },
      null,
      {
        label: 'Rename Tag…',
        disabled: blocked || busy || chip.held,
        onClick: () => setRenaming(chip),
      },
      {
        label: 'Copy Tags',
        disabled: !single || clipboard.busy,
        onClick: () => {
          if (single) void clipboard.copy(single)
        },
      },
      {
        label: 'Paste Tags',
        disabled:
          !canPaste ||
          blocked ||
          clipboard.busy ||
          !copiedCatalogTags(library).length ||
          ids.length > 100,
        onClick: () => void clipboard.paste(ids),
      },
      null,
      {
        label: ids.length === 1 ? 'Remove from This Bundle' : 'Remove from These Bundles',
        disabled: blocked || busy,
        onClick: () => toggle(chip, false),
      },
    ]
  }
  const treeProps = {
    assigned: new Set(chips.map((chip) => chip.id)),
    partial: partial.data,
    disabled: blocked || busy || clipboard.busy || ids.length > 100,
    onToggle: pickTree,
    onCreated: (created: { id: string }) => pickTree(created.id, true),
  }
  return (
    <InspectorSection id={family} title={TITLE[family]}>
      <CatalogChipPicker
        family={family}
        chips={chips}
        choices={choices}
        search={search}
        onSearch={setSearch}
        onOpenChange={setPicking}
        onMore={found.hasNextPage ? () => void found.fetchNextPage() : undefined}
        loading={found.isPending}
        disabled={blocked || busy || clipboard.busy || ids.length > 100}
        onToggle={toggle}
        onReview={onReview}
        onOpenChip={family === 'collections' ? onOpenCollection : undefined}
        panel={
          !tree ? undefined : family === 'tags' ? (
            <TagPickerPanel {...treeProps} />
          ) : (
            <CollectionPickerPanel {...treeProps} />
          )
        }
        onTagMenu={
          family === 'tags'
            ? (chip, event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setMenuChip(chip.id)
                menu.open(
                  event,
                  tagEntries(chip),
                  event.clientX || event.clientY ? undefined : { x: rect.left, y: rect.bottom },
                )
              }
            : undefined
        }
      />
      <TargetContextMenu
        state={menu.state}
        target={menu.state ? chips.find((chip) => chip.id === menuChip) : undefined}
        entries={tagEntries}
        onClose={menu.close}
      />
      {renaming && (
        <PromptDialog
          title="Rename Tag"
          label="Tag name"
          initial={renaming.name}
          pending={busy}
          error={error || null}
          onCancel={() => {
            setRenaming(null)
            setError('')
          }}
          onConfirm={(name) => {
            const current = captureRequestScope()
            setBusy(true)
            setError('')
            void rename(library, 'tags', renaming.id, name)
              .then(async () => {
                current()
                setRenaming(null)
                await Promise.all(
                  ['catalog-selection', ...AFFECTED, 'tags'].map((key) =>
                    client.invalidateQueries({ queryKey: [key, library] }),
                  ),
                )
              })
              .catch((reason: Error) => {
                try {
                  current()
                  setError(reason.message)
                } catch {
                  /* The prior library owns this reply. */
                }
              })
              .finally(() => setBusy(false))
          }}
        />
      )}
      {clipboard.message && <p role="status">{clipboard.message}</p>}
      {assigned.data?.next && <p className="catalog-chips-more">More {family} than shown.</p>}
      {(error || assigned.error) && (
        <p role="alert">{error || `${TITLE[family]} are unavailable.`}</p>
      )}
    </InspectorSection>
  )
}
