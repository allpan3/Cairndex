import { useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import { rename, setBulkMembership, setMembership } from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import type { components } from '../api/schema'
import { CatalogChipPicker, type ChipChoice } from './CatalogChipPicker'
import { InspectorSection } from './InspectorSection'
import { ContextMenu } from './ContextMenu'
import { useContextMenu } from './useContextMenu'
import { PromptDialog } from './PromptDialog'
import { copiedCatalogTags } from '../api/catalogTagClipboard'
import { useCatalogTagClipboard } from './useCatalogTagClipboard'
import { useReplicaStatus } from '../api/useReplicaStatus'

type Page = components['schemas']['CatalogMembershipPage']
type BulkPage = components['schemas']['CatalogBulkMembershipPage']
type Observed = Record<string, string[]>

const TITLE = { tags: 'Tags', collections: 'Collections' } as const
// Every view that shows a membership or counts one. The selection snapshot comes
// first: a bulk change advances each bundle's lifetime basis, and the next bulk
// title or rating save must read the new one before the chips show the change.
const AFFECTED = [
  'catalog-selection',
  'catalog-memberships',
  'catalog-bulk-memberships',
  'catalog-browse',
  'catalog-detail',
  'catalog-navigation',
  'catalog-view-counts',
]

/**
 * A bundle's tags or collections as chips, or a selection's: chips list what any
 * selected bundle has, and adding or removing one changes every selected bundle.
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
  const menu = useContextMenu()
  const clipboard = useCatalogTagClipboard(library)
  const canPaste = (useReplicaStatus(library).data?.selection_version ?? 0) >= 2
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
          ...(assigned ? { assigned } : {}),
        }).then((page) => ({
          next: page.next_cursor,
          items: page.items.map((item): ChipChoice & { observed: Observed } => ({
            id: item.id,
            name: item.name,
            path: [item.name],
            state: item.assigned_count === ids.length ? 'on' : item.assigned_count ? 'some' : 'off',
            held: item.held,
            observed: item.observed,
          })),
        }))
  const key = single
    ? ['catalog-memberships', library, single]
    : ['catalog-bulk-memberships', library, ids]
  const assigned = useQuery({
    queryKey: [...key, family, 'assigned'],
    queryFn: () => read('', '', true),
    refetchInterval: 2000,
  })
  const found = useInfiniteQuery({
    queryKey: [...key, family, 'search', search],
    enabled: picking,
    initialPageParam: '',
    queryFn: ({ pageParam }) => read(search.trim(), pageParam, false),
    getNextPageParam: (page) => page.next ?? undefined,
  })
  const choices = found.data?.pages.flatMap((page) => page.items) ?? []
  const chips = assigned.data?.items ?? []
  function toggle(choice: ChipChoice, assign: boolean) {
    const read = [...chips, ...choices].find((item) => item.id === choice.id)
    if (!read || busy) return
    const current = captureRequestScope()
    setBusy(true)
    setError('')
    void (
      single
        ? setMembership(library, single, family, read, assign)
        : setBulkMembership(library, ids, family, read, assign)
    )
      .then(async () => {
        current()
        for (const name of AFFECTED) await client.invalidateQueries({ queryKey: [name, library] })
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
        onTagMenu={
          family === 'tags'
            ? (chip, event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                menu.open(
                  event,
                  [
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
                      label:
                        ids.length === 1 ? 'Remove from This Bundle' : 'Remove from These Bundles',
                      disabled: blocked || busy,
                      onClick: () => toggle(chip, false),
                    },
                  ],
                  event.clientX || event.clientY ? undefined : { x: rect.left, y: rect.bottom },
                )
              }
            : undefined
        }
      />
      <ContextMenu state={menu.state} onClose={menu.close} />
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
                for (const key of [...AFFECTED, 'tags'])
                  await client.invalidateQueries({ queryKey: [key, library] })
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
