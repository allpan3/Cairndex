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
