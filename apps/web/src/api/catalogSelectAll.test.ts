import { expect, test, vi } from 'vitest'

import { readEveryKey, SELECT_ALL_LIMIT } from './catalogSelectAll'

const keys = (total: number) => Array.from({ length: total }, (_, index) => `item-${index}`)
const pages = (items: string[], total = items.length) =>
  vi.fn(async (offset: number, limit: number) => ({
    items: items.slice(offset, offset + limit),
    total,
  }))

test('reads every page of 1,000 in order and reports progress', async () => {
  const read = pages(keys(2500))
  const progress: number[] = []
  const found = await readEveryKey(
    read,
    (item) => item,
    ({ done }) => progress.push(done),
    new AbortController().signal,
  )
  expect(found).toEqual(keys(2500))
  expect(read.mock.calls.map(([offset]) => offset).sort((a, b) => a - b)).toEqual([0, 1000, 2000])
  expect(progress.at(-1)).toBe(2500)
})

test('starts again when the view changes while it is read, then gives up', async () => {
  let calls = 0
  // The second page reports one more item than the first each time
  const growing = vi.fn(async (offset: number, limit: number) => {
    calls += 1
    return { items: keys(1500).slice(offset, offset + limit), total: offset ? 1501 : 1500 }
  })
  await expect(
    readEveryKey(
      growing,
      (item) => item,
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow('The list changed')
  expect(calls).toBe(4)

  // A shift between pages repeats one item: the read is retried, and a stable view succeeds
  let shifted = true
  const settling = vi.fn(async (offset: number, limit: number) => {
    const items = keys(1500)
    const page = items.slice(offset, offset + limit)
    if (offset === 1000 && shifted) {
      shifted = false
      return { items: [items[999]!, ...page.slice(1)], total: 1500 }
    }
    return { items: page, total: 1500 }
  })
  expect(
    await readEveryKey(
      settling,
      (item) => item,
      () => undefined,
      new AbortController().signal,
    ),
  ).toEqual(keys(1500))
})

test('refuses a view larger than the Select All limit before reading it', async () => {
  const read = pages([], SELECT_ALL_LIMIT + 1)
  await expect(
    readEveryKey(
      read,
      (item) => item,
      () => undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow('Select All takes up to 100,000 items')
  expect(read).toHaveBeenCalledTimes(1)
})
