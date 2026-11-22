import { describe, expect, test, vi } from 'vitest'
import { bundleLockKey, fileLockKey, withCatalogWriteLock } from './catalogWriteQueue'
import { advanceLibraryScope } from './requestScope'

describe('catalogWriteQueue', () => {
  test('invokes uncontended work synchronously and reports waited=false', async () => {
    const events: string[] = []
    let release!: () => void
    const promise = withCatalogWriteLock([bundleLockKey('lib', 'b1')], async ({ waited }) => {
      events.push(`start:${waited}`)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      events.push('end')
      return 42
    })
    // Started synchronously before awaiting any microtask
    expect(events).toEqual(['start:false'])
    release()
    await expect(promise).resolves.toBe(42)
    expect(events).toEqual(['start:false', 'end'])
  })

  test('serializes contended writes even across multi-key overlaps without deadlock', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstStarted = vi.fn()
    const secondStarted = vi.fn()
    const thirdStarted = vi.fn()

    const first = withCatalogWriteLock(
      [bundleLockKey('lib', 'b1'), fileLockKey('lib', 'f1')],
      async ({ waited }) => {
        firstStarted(waited)
        order.push('first:start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        order.push('first:end')
      },
    )

    const second = withCatalogWriteLock([fileLockKey('lib', 'f1')], async ({ waited }) => {
      secondStarted(waited)
      order.push('second')
    })

    const third = withCatalogWriteLock(
      [fileLockKey('lib', 'f1'), bundleLockKey('lib', 'b1')],
      async ({ waited }) => {
        thirdStarted(waited)
        order.push('third')
      },
    )

    const unrelated = withCatalogWriteLock([bundleLockKey('lib', 'b2')], async ({ waited }) => {
      order.push(`unrelated:${waited}`)
    })

    expect(firstStarted).toHaveBeenCalledWith(false)
    expect(secondStarted).not.toHaveBeenCalled()
    expect(thirdStarted).not.toHaveBeenCalled()
    expect(order).toEqual(['first:start', 'unrelated:false'])

    releaseFirst()
    await Promise.all([first, second, third, unrelated])

    expect(secondStarted).toHaveBeenCalledWith(true)
    expect(thirdStarted).toHaveBeenCalledWith(true)
    expect(order).toEqual(['first:start', 'unrelated:false', 'first:end', 'second', 'third'])
  })

  test('releases the lock if an earlier write rejects', async () => {
    const failing = withCatalogWriteLock([fileLockKey('lib', 'f-err')], async () => {
      throw new Error('boom')
    })
    const recovered = withCatalogWriteLock([fileLockKey('lib', 'f-err')], async ({ waited }) => {
      return `ok:${waited}`
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(recovered).resolves.toBe('ok:true')
  })

  test('isolates locks across connection or library scope advances', async () => {
    let releaseAbandoned!: () => void
    const abandoned = withCatalogWriteLock(
      [bundleLockKey('lib', 'b1')],
      () =>
        new Promise<void>((resolve) => {
          releaseAbandoned = resolve
        }),
    )

    advanceLibraryScope()
    const fresh = await withCatalogWriteLock([bundleLockKey('lib', 'b1')], async ({ waited }) => {
      return `fresh:${waited}`
    })
    expect(fresh).toBe('fresh:false')

    releaseAbandoned()
    await abandoned
  })
})
