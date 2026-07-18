import { expect, test, vi } from 'vitest'

import { fileDragProps } from './dragOut'

test('is inert without a drag-out handler', () => {
  const props = fileDragProps(undefined, () => ['a.mp4'])
  expect(props.draggable).toBe(false)
  expect(props.onDragStart).toBeUndefined()
})

test('cancels the HTML5 drag and forwards resolved paths on dragstart', () => {
  const start = vi.fn()
  const props = fileDragProps(start, () => ['dir/a.mp4', 'dir/b.mp4'])
  const preventDefault = vi.fn()
  props.onDragStart?.({ preventDefault } as unknown as React.DragEvent<HTMLElement>)

  expect(preventDefault).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledWith(['dir/a.mp4', 'dir/b.mp4'])
})

test('does nothing when no paths resolve (e.g. a directory or empty selection)', () => {
  const start = vi.fn()
  const props = fileDragProps(start, () => [])
  const preventDefault = vi.fn()
  props.onDragStart?.({ preventDefault } as unknown as React.DragEvent<HTMLElement>)

  expect(preventDefault).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})
