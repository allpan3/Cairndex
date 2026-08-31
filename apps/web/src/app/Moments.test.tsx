import { fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { setActiveLibraryId, type FileRead, type Moment } from '../api/client'
import {
  BundleInspectorActionsContext,
  type BundleInspectorActions,
} from './bundleInspectorActions'
import { Moments } from './Moments'
import { noteCapturedMoment } from './momentCapture'

const hooks = vi.hoisted(() => ({
  moments: [] as unknown[],
  create: { mutate: vi.fn() },
  update: { mutate: vi.fn() },
  setTags: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  cues: null as unknown,
}))

vi.mock('../api/hooks', () => ({
  useMoments: () => ({ data: hooks.moments }),
  useMomentMutations: () => ({
    create: hooks.create,
    update: hooks.update,
    setTags: hooks.setTags,
    remove: hooks.remove,
  }),
}))

// The tag picker reads a fistful of library-wide queries; which tags a moment
// carries is the backend's contract, and the picker has its own tests.
vi.mock('./TagEditor', () => ({ TagPicker: () => null }))
// jsdom cannot fetch or crop a storyboard sheet, and the row must render without
// one anyway — a video whose storyboard has not been generated yet.
vi.mock('./viewer/player/useStoryboardCues', () => ({
  useStoryboardCues: () => ({ data: hooks.cues }),
}))

function video(id: string, title: string, sequence = 0): FileRead {
  return {
    id,
    bundle_id: 'bundle',
    relative_path: `folder/${title}`,
    original_filename: title,
    display_title: title,
    role: 'primary_video',
    media_kind: 'video',
    mime_type: 'video/mp4',
    supported: true,
    sequence,
    availability: 'available',
  } as FileRead
}

function moment(overrides: Partial<Moment> = {}): Moment {
  return {
    id: 'moment-1',
    bundle_id: 'bundle',
    file_id: 'file-1',
    start_s: 83.48,
    end_s: null,
    comment: null,
    tag_ids: [],
    version: 1,
    created_at: '2026-08-29T00:00:00Z',
    updated_at: '2026-08-29T00:00:00Z',
    ...overrides,
  } as Moment
}

/** The abilities the viewer supplies and the shell does not. */
function playerActions(): NonNullable<BundleInspectorActions['moments']> {
  return { capture: vi.fn(), loop: vi.fn() }
}

function renderSection(
  files: FileRead[],
  actions: BundleInspectorActions = {},
): BundleInspectorActions {
  render(
    <BundleInspectorActionsContext value={actions}>
      <Moments bundleId="bundle" files={files} />
    </BundleInspectorActionsContext>,
  )
  return actions
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setActiveLibraryId('library-one')
  hooks.moments = []
  hooks.cues = null
  for (const m of [hooks.create, hooks.update, hooks.setTags, hooks.remove]) m.mutate.mockReset()
})

// A bundle of photos has nothing this section could describe, so it shows
// nothing at all rather than an empty heading.
test('a bundle with no video has no moments section', () => {
  renderSection([{ ...video('file-1', 'cover.jpg'), media_kind: 'image' } as FileRead])
  expect(screen.queryByText('Moments')).not.toBeInTheDocument()
})

// The invitation belongs where it can be taken up. In the shell's rail there is
// no playhead, so an empty section would be a permanent hint nobody there can
// act on — and permanent height on every video bundle.
test('an unmarked video shows nothing in a pane with no playhead', () => {
  renderSection([video('file-1', 'clip.mp4')])
  expect(screen.queryByText('Moments')).not.toBeInTheDocument()
})

test('an unmarked video says how to mark one where a playhead exists', () => {
  renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })
  expect(screen.getByText('Moments')).toBeInTheDocument()
  expect(screen.getByText(/Press/)).toBeInTheDocument()
  expect(screen.getByText('B')).toBeInTheDocument()
})

// But a bundle that *has* moments shows them everywhere, playhead or not —
// reading them back is the whole point of the section.
test('marked moments show in a pane with no playhead', () => {
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')])
  expect(screen.getByText('Moments')).toBeInTheDocument()
  expect(screen.getByText('1:23')).toBeInTheDocument()
})

test('a frame shows its timecode and a range shows its start and length', () => {
  hooks.moments = [
    moment({ id: 'frame', start_s: 83.48 }),
    moment({ id: 'span', start_s: 12.4, end_s: 17.9 }),
  ]
  renderSection([video('file-1', 'clip.mp4')])

  expect(screen.getByText('1:23')).toBeInTheDocument()
  // Start and length, not both ends: the second end is their sum, so printing it
  // spends the row's width saying the same thing twice (owner, 2026-08-30).
  expect(screen.getByText('0:12')).toBeInTheDocument()
  expect(screen.getByText('5.5s')).toBeInTheDocument()
  expect(screen.queryByText(/→/)).not.toBeInTheDocument()
})

// Only a range is an A-B pair; a frame has nothing to loop between.
test('only a range offers the loop control', () => {
  hooks.moments = [moment({ id: 'frame' }), moment({ id: 'span', start_s: 1, end_s: 4 })]
  renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })

  expect(screen.getAllByRole('button', { name: /^Range loop/ })).toHaveLength(1)
})

test('the loop control arms the range loop on that span', () => {
  hooks.moments = [moment({ id: 'span', start_s: 1, end_s: 4 })]
  const actions = renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })

  fireEvent.click(screen.getByRole('button', { name: /^Range loop/ }))

  expect(actions.moments?.loop).toHaveBeenCalledWith('file-1', { start: 1, end: 4 })
})

test('playing a moment names its file and its instant', () => {
  hooks.moments = [moment({ start_s: 42.5 })]
  const onPlayMoment = vi.fn()
  renderSection([video('file-1', 'clip.mp4')], { onPlayMoment })

  fireEvent.click(screen.getAllByRole('button', { name: /^Play from / })[0]!)

  expect(onPlayMoment).toHaveBeenCalledWith('bundle', 'file-1', 42.5)
})

// The header's `+` needs a playhead, which only the viewer has. In the shell it
// is absent rather than present and inert — there is nothing it could mean.
test('the capture button appears only where there is a playhead', () => {
  hooks.moments = [moment()]
  const { unmount } = render(
    <BundleInspectorActionsContext value={{}}>
      <Moments bundleId="bundle" files={[video('file-1', 'clip.mp4')]} />
    </BundleInspectorActionsContext>,
  )
  expect(screen.queryByRole('button', { name: /Mark a moment/ })).not.toBeInTheDocument()
  unmount()

  const actions = playerActions()
  renderSection([video('file-1', 'clip.mp4')], { moments: actions })
  fireEvent.click(screen.getByRole('button', { name: /Mark a moment/ }))
  expect(actions.capture).toHaveBeenCalledOnce()
})

test('moments are grouped by file only when there is more than one to tell apart', () => {
  hooks.moments = [moment({ id: 'a', file_id: 'file-1' })]
  const files = [video('file-1', 'first.mp4', 0), video('file-2', 'second.mp4', 1)]
  const { unmount } = render(
    <BundleInspectorActionsContext value={{}}>
      <Moments bundleId="bundle" files={files} />
    </BundleInspectorActionsContext>,
  )
  // One video *with moments*, so no subheading — the other has none.
  expect(screen.queryByText('first.mp4')).not.toBeInTheDocument()
  unmount()

  hooks.moments = [moment({ id: 'a', file_id: 'file-1' }), moment({ id: 'b', file_id: 'file-2' })]
  renderSection(files)
  expect(screen.getByText('first.mp4')).toBeInTheDocument()
  expect(screen.getByText('second.mp4')).toBeInTheDocument()
})

// Groups follow the bundle's own file order, not the order the moments arrived
// in — the rows within a group are already chronological from the server.
test('groups follow the bundle file order', () => {
  hooks.moments = [
    moment({ id: 'late-file', file_id: 'file-2', start_s: 1 }),
    moment({ id: 'early-file', file_id: 'file-1', start_s: 90 }),
  ]
  renderSection([video('file-1', 'first.mp4', 0), video('file-2', 'second.mp4', 1)])

  const headings = screen.getAllByText(/\.mp4$/).map((node) => node.textContent)
  expect(headings).toEqual(['first.mp4', 'second.mp4'])
})

// A trashed video keeps its moments — Put back has to restore them with it — but
// drops out of the rail's file list. The count would otherwise disagree with the
// rows beneath it.
test('the count reflects the rows on screen, not every stored moment', () => {
  hooks.moments = [
    moment({ id: 'visible', file_id: 'file-1' }),
    moment({ id: 'on-a-trashed-file', file_id: 'file-gone' }),
  ]
  renderSection([video('file-1', 'clip.mp4')])

  expect(screen.getByText('1')).toBeInTheDocument()
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
})

test('a comment is shown, and clicking it opens an editor that commits on blur', () => {
  hooks.moments = [moment({ comment: 'the wide shot' })]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.click(screen.getByText('the wide shot'))
  const box = screen.getByLabelText('Moment comment')
  fireEvent.change(box, { target: { value: 'the wide shot, before the cut' } })
  fireEvent.blur(box)

  expect(hooks.update.mutate).toHaveBeenCalledWith({
    momentId: 'moment-1',
    patch: { comment: 'the wide shot, before the cut' },
    version: 1,
  })
})

test('Escape abandons a comment edit without saving it', () => {
  hooks.moments = [moment({ comment: 'keep me' })]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.click(screen.getByText('keep me'))
  const box = screen.getByLabelText('Moment comment')
  fireEvent.change(box, { target: { value: 'discard me' } })
  fireEvent.keyDown(box, { key: 'Escape' })

  expect(hooks.update.mutate).not.toHaveBeenCalled()
  expect(screen.getByText('keep me')).toBeInTheDocument()
})

test('an unchanged comment is not written back', () => {
  hooks.moments = [moment({ comment: 'same' })]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.click(screen.getByText('same'))
  fireEvent.blur(screen.getByLabelText('Moment comment'))

  expect(hooks.update.mutate).not.toHaveBeenCalled()
})

function rowMenu(): string[] {
  fireEvent.contextMenu(screen.getAllByRole('listitem')[0]!)
  return within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
}

// The `⋯` button and a right-click on the row open the same menu: the button is
// there because a rail row is small and right-click is not the only way anyone
// reaches for actions.
test('the ⋯ button opens the same menu the row does', () => {
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.click(screen.getByRole('button', { name: /Moment actions/ }))
  const labels = within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((item) => item.textContent)
  expect(labels).toContain('Delete Moment')

  fireEvent.click(screen.getByText('Delete Moment'))
  expect(hooks.remove.mutate).toHaveBeenCalledWith('moment-1')
})

test('the row menu offers Delete, and deleting forgets that moment', () => {
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')])

  expect(rowMenu()).toContain('Delete Moment')
  fireEvent.click(screen.getByText('Delete Moment'))
  expect(hooks.remove.mutate).toHaveBeenCalledWith('moment-1')
})

// Two entries only: "Update to Range Marks" was here to move a saved span
// without losing its tags and comment, and re-marking is the same gesture for a
// moment this cheap to delete and re-make (owner, 2026-08-30).
test('the row menu offers a comment and a delete, and nothing else', () => {
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })

  expect(rowMenu()).toEqual(['Add Comment…', 'Delete Moment'])
})

test('a comment entry names whether there is a comment to edit', () => {
  hooks.moments = [moment({ comment: null })]
  const { unmount } = render(
    <BundleInspectorActionsContext value={{}}>
      <Moments bundleId="bundle" files={[video('file-1', 'clip.mp4')]} />
    </BundleInspectorActionsContext>,
  )
  expect(rowMenu()).toContain('Add Comment…')
  unmount()

  hooks.moments = [moment({ comment: 'already said' })]
  renderSection([video('file-1', 'clip.mp4')])
  expect(rowMenu()).toContain('Edit Comment…')
})

// The frame is a hover tooltip now, not a column of thumbnails (owner,
// 2026-08-29): nothing costs layout until the pointer asks for it.
test('the frame appears on hover and goes when the pointer leaves', () => {
  hooks.cues = [
    { start: 0, end: 10, url: 'sb_001.jpg#xywh=0,0,320,180', x: 0, y: 0, w: 320, h: 180 },
  ]
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')])

  expect(screen.queryByTestId('moment-preview')).not.toBeInTheDocument()

  const row = screen.getAllByRole('listitem')[0]!
  fireEvent.pointerEnter(row)
  expect(screen.getByTestId('moment-preview')).toBeInTheDocument()

  fireEvent.pointerLeave(row)
  expect(screen.queryByTestId('moment-preview')).not.toBeInTheDocument()
})

// A moment's still is its own decoded frame, not a storyboard tile, so it does
// not depend on a sheet existing — and it is the *marked* frame, where the tile
// held whatever the sampling grid happened to catch up to 30s earlier.
test('a video with no storyboard still shows the frame the moment marks', () => {
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.pointerEnter(screen.getAllByRole('listitem')[0]!)
  expect(screen.getByTestId('moment-preview')).toBeInTheDocument()
  const poster = screen.getByTestId('moment-preview-poster')
  expect(poster.getAttribute('src')).toContain('/moments/moment-1/poster.jpg')
  // Nothing to approximate with, and nothing pretending to.
  expect(screen.queryByTestId('moment-preview-tile')).not.toBeInTheDocument()
})

// The poster is hidden until it has actually decoded, because the server answers
// 404 while it is still being made — a visible-but-broken image would blank the
// tile underneath instead of letting it stand in.
test('a poster that has not been built yet leaves the tile showing', () => {
  hooks.moments = [moment()]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.pointerEnter(screen.getAllByRole('listitem')[0]!)
  const poster = screen.getByTestId('moment-preview-poster')
  expect(poster.className).not.toContain('is-ready')

  fireEvent.load(poster)
  expect(poster.className).toContain('is-ready')

  // ...and a build that failed hides it again rather than showing a broken icon.
  fireEvent.error(poster)
  expect(poster.className).not.toContain('is-ready')
})

// What you want to write down is freshest at the instant you mark it, so the row
// a capture just created opens straight into its comment box.
test('the row a capture just created opens its comment box', () => {
  hooks.moments = [moment({ id: 'fresh' })]
  noteCapturedMoment('bundle', 'fresh')
  renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })

  expect(screen.getByLabelText('Moment comment')).toBeInTheDocument()
})

// Both rails are mounted while the viewer is up. The capture came from the
// player, so the box opens in the player's rail — the one the owner is looking
// at — and never in the shell's, which is behind a full-screen viewer.
test('a capture does not open a box in a rail with no player', () => {
  hooks.moments = [moment({ id: 'fresh' })]
  noteCapturedMoment('bundle', 'fresh')
  renderSection([video('file-1', 'clip.mp4')])

  expect(screen.queryByLabelText('Moment comment')).not.toBeInTheDocument()
})

// ...and only that once: coming back to the bundle later must not reopen it.
test('a captured row does not reopen its comment box on a later visit', () => {
  hooks.moments = [moment({ id: 'fresh' })]
  noteCapturedMoment('bundle', 'fresh')
  const first = render(
    <BundleInspectorActionsContext value={{ moments: playerActions() }}>
      <Moments bundleId="bundle" files={[video('file-1', 'clip.mp4')]} />
    </BundleInspectorActionsContext>,
  )
  expect(screen.getByLabelText('Moment comment')).toBeInTheDocument()
  first.unmount()

  renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })
  expect(screen.queryByLabelText('Moment comment')).not.toBeInTheDocument()
})

// A capture in one bundle must not open an editor in another's rail.
test('a capture belongs to the bundle it was made in', () => {
  hooks.moments = [moment({ id: 'fresh' })]
  noteCapturedMoment('some-other-bundle', 'fresh')
  renderSection([video('file-1', 'clip.mp4')], { moments: playerActions() })

  expect(screen.queryByLabelText('Moment comment')).not.toBeInTheDocument()
})

// A span deserves to move, and it plays the real video rather than a generated
// clip — the same source the player uses, so there is nothing to build and
// nothing to wait for (owner, 2026-08-30: "why can't this be as smooth as scrub
// preview?").
test('a range plays its span on hover and a frame shows a still tile', async () => {
  hooks.cues = [
    { start: 0, end: 10, url: 'sb_001.jpg#xywh=0,0,320,180', x: 0, y: 0, w: 320, h: 180 },
  ]
  hooks.moments = [
    moment({ id: 'frame', start_s: 4 }),
    moment({ id: 'span', start_s: 9, end_s: 13.5 }),
  ]
  renderSection([video('file-1', 'clip.mp4')])
  const rows = screen.getAllByRole('listitem')

  // The still tile is there from the first frame the pointer rests; the video
  // is held back so sweeping the list does not open a stream per row.
  fireEvent.pointerEnter(rows[1]!)
  expect(screen.queryByTestId('moment-preview-video')).not.toBeInTheDocument()
  await act(async () => {
    vi.advanceTimersByTime(400)
  })
  expect(screen.getByTestId('moment-preview-video')).toBeInTheDocument()
  fireEvent.pointerLeave(rows[1]!)

  // A frame never plays anything.
  fireEvent.pointerEnter(rows[0]!)
  await act(async () => {
    vi.advanceTimersByTime(400)
  })
  expect(screen.queryByTestId('moment-preview-video')).not.toBeInTheDocument()
})

// A source the browser cannot decode keeps the still tile: remuxing is the
// player's job, and far too much machinery for a hover.
test('a range on an undecodable file does not try to play', async () => {
  hooks.moments = [moment({ id: 'span', start_s: 9, end_s: 13.5 })]
  renderSection([{ ...video('file-1', 'clip.mkv'), supported: false } as FileRead])

  fireEvent.pointerEnter(screen.getAllByRole('listitem')[0]!)
  await act(async () => {
    vi.advanceTimersByTime(400)
  })
  expect(screen.queryByTestId('moment-preview-video')).not.toBeInTheDocument()
})

// The row clamps a comment to one line, so the preview is where the whole of it
// can be read (owner, 2026-08-30).
test('the hover preview carries the comment in full', () => {
  const long = 'a comment far too long to fit on one line of a three-hundred pixel rail'
  hooks.moments = [moment({ comment: long })]
  renderSection([video('file-1', 'clip.mp4')])

  fireEvent.pointerEnter(screen.getAllByRole('listitem')[0]!)
  expect(screen.getByTestId('moment-preview')).toHaveTextContent(long)
  // ...and the clamped line names it too, for a pointer resting on the line.
  expect(screen.getByRole('button', { name: long })).toHaveAttribute('title', long)
})

// A hovered span reaches for its pre-cut clip first, which plays from byte 0 and
// so needs neither a seek nor a manual loop.
test('a hovered span plays its pre-cut clip, looping natively', async () => {
  hooks.moments = [moment({ id: 'span', start_s: 9, end_s: 13.5 })]
  renderSection([video('file-1', 'clip.mp4')])
  fireEvent.pointerEnter(screen.getAllByRole('listitem')[0]!)
  await act(async () => {
    vi.advanceTimersByTime(400)
  })

  const media = screen.getByTestId('moment-preview-video') as HTMLVideoElement
  expect(media.dataset.source).toBe('clip')
  expect(media.getAttribute('src')).toContain('/moments/span/clip.mp4')
  // Nothing to arrange: it starts where it should and repeats itself.
  expect(media.loop).toBe(true)
  expect(media.autoplay).toBe(true)
})

// The clip route answers 404 until the cut lands, so the row must fall back to
// streaming the original rather than showing a broken preview — and once it
// does, the span is what was marked, so playback keeps to it: `loop` on the
// element would replay the whole file instead.
test('a span whose clip is not built yet streams the original and keeps to the span', async () => {
  hooks.moments = [moment({ id: 'span', start_s: 9, end_s: 13.5 })]
  renderSection([video('file-1', 'clip.mp4')])
  fireEvent.pointerEnter(screen.getAllByRole('listitem')[0]!)
  await act(async () => {
    vi.advanceTimersByTime(400)
  })

  // The clip is unavailable: demote to the stream.
  await act(async () => {
    fireEvent.error(screen.getByTestId('moment-preview-video'))
  })
  const media = screen.getByTestId('moment-preview-video') as HTMLVideoElement
  expect(media.dataset.source).toBe('stream')
  expect(media.getAttribute('src')).toContain('/files/file-1/stream')
  expect(media.loop).toBe(false)

  // The seek to the in-point happens once metadata is there.
  fireEvent.loadedMetadata(media)
  expect(media.currentTime).toBe(9)

  // Still inside: left alone.
  media.currentTime = 12
  fireEvent.timeUpdate(media)
  expect(media.currentTime).toBe(12)

  // At the out-point: back to the start of the span, not of the file.
  media.currentTime = 13.6
  fireEvent.timeUpdate(media)
  expect(media.currentTime).toBe(9)
})
