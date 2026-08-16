import { beforeEach } from 'vitest'

import '@testing-library/jest-dom/vitest'

// jsdom has no layout engine, so ResizeObserver (used by the virtualized
// browser to measure its width) is undefined. Stub it so components mount;
// real grid rendering is covered by the Playwright e2e in a real browser.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never)

// Same reason: with no layout there is nothing to scroll, so jsdom leaves
// scrollIntoView undefined and any keyboard navigation that keeps its active
// item visible would throw in tests while working in every real browser.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function () {}

// Same reason as ResizeObserver: jsdom has no layout, so nothing can intersect.
// The stub reports its target as visible immediately, which is what a rendered
// element in a test *means* — real on-screen-only loading is covered by the
// Playwright specs in a browser that actually lays out.
class IntersectionObserverStub {
  private readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
globalThis.IntersectionObserver =
  globalThis.IntersectionObserver ?? (IntersectionObserverStub as never)

/**
 * A working `localStorage`, because the absence of one hid a real bug.
 *
 * This environment provides none (Node's is behind `--localstorage-file`),
 * while CI's does — so preference stores silently never persisted here and
 * every write leaked between tests there. Four tests passed locally and failed
 * in CI for exactly that reason. Backed by a Map, and cleared before each test
 * so a file's cases stay independent whichever environment runs them.
 */
const testStorage = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => testStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void testStorage.set(key, String(value)),
  removeItem: (key: string) => void testStorage.delete(key),
  clear: () => testStorage.clear(),
  key: (index: number) => [...testStorage.keys()][index] ?? null,
  get length() {
    return testStorage.size
  },
} satisfies Storage

beforeEach(() => testStorage.clear())
