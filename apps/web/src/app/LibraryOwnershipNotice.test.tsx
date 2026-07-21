import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { LibraryOwnership, LibraryRead } from '../api/client'
import { LibraryOwnershipNotice } from './LibraryOwnershipNotice'

const LIBRARIES = [
  { id: 'lib-1', name: 'Photos' },
  { id: 'lib-2', name: 'Video' },
] as LibraryRead[]

function runningTakeover(overrides: Partial<NonNullable<LibraryOwnership['takeover']>> = {}) {
  return {
    running: true,
    error_code: null,
    error_message: null,
    started_at: new Date().toISOString(),
    observation_seconds: 80,
    ...overrides,
  }
}

function ownership(overrides: Partial<LibraryOwnership> = {}): LibraryOwnership {
  return {
    library_id: 'lib-1',
    state: 'fresh',
    mountable: false,
    can_take_over: false,
    redirect_url: null,
    holder: {
      server_uuid: 'srv-1',
      machine_name: 'the-NAS',
      advertised_url: null,
      heartbeat_at: '2026-07-20T12:00:00+00:00',
    },
    takeover: null,
    ...overrides,
  }
}

interface NoticeOverrides {
  takeoverPending?: boolean
  takeoverError?: string | null
}

function renderNotice(value: LibraryOwnership, overrides: NoticeOverrides = {}) {
  const props = {
    ownership: value,
    libraries: LIBRARIES,
    libraryId: 'lib-1',
    onChangeLibrary: vi.fn(),
    onTakeOver: vi.fn(),
    onConnectTo: vi.fn(),
    takeoverPending: overrides.takeoverPending ?? false,
    takeoverError: overrides.takeoverError ?? null,
  }
  render(<LibraryOwnershipNotice {...props} />)
  return props
}

describe('a live holder', () => {
  it('names the machine and does not offer a takeover', () => {
    // Taking a library from a server that is actively serving it is exactly the
    // dual-writer the lease exists to prevent, so the offer must not appear.
    renderNotice(ownership())

    expect(screen.getByText(/open on the-NAS/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /serve here anyway/i })).not.toBeInTheDocument()
  })

  it('offers a redirect when the holder advertises a reachable address', () => {
    const props = renderNotice(ownership({ redirect_url: 'http://nas.local:8000' }))

    fireEvent.click(screen.getByRole('button', { name: /connect to the-NAS/i }))

    expect(props.onConnectTo).toHaveBeenCalledWith('http://nas.local:8000')
  })

  it('tells the user what to do instead when there is no reachable address', () => {
    // A loopback holder URL is never offered by the server, so this is the case
    // where the only useful instruction is "close it over there".
    renderNotice(ownership({ redirect_url: null }))

    expect(screen.queryByRole('button', { name: /connect to/i })).not.toBeInTheDocument()
    expect(screen.getByText(/close it on the-NAS first/i)).toBeInTheDocument()
  })

  it('falls back to neutral wording when the holder has no name', () => {
    renderNotice(ownership({ holder: null }))
    expect(screen.getByText(/open on another server/i)).toBeInTheDocument()
  })
})

describe('a stale lease', () => {
  it('offers a confirmed takeover and says why confirmation is needed', () => {
    const props = renderNotice(ownership({ state: 'stale', can_take_over: true }))

    expect(screen.getByText(/did not close this library/i)).toBeInTheDocument()
    // The reason the confirmation exists, in the user's terms.
    expect(screen.getByText(/two places at once can lose data/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /serve here anyway/i }))
    expect(props.onTakeOver).toHaveBeenCalled()
  })

  it('explains an unreadable record differently from a stale one', () => {
    // "We could not read it" is not "they left it open"; conflating them would
    // tell the user something the server never said.
    renderNotice(ownership({ state: 'unreadable', can_take_over: true, holder: null }))

    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
  })

  it('surfaces a failed takeover attempt', () => {
    renderNotice(ownership({ state: 'stale', can_take_over: true }), {
      takeoverError: 'this library is currently served by the-NAS',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('currently served by the-NAS')
  })
})

describe('a takeover in flight', () => {
  it('shows indeterminate progress and warns it takes minutes', () => {
    // The server watches the lease for longer than a heartbeat period before it
    // may proceed, so a spinner with no explanation would look like a hang.
    renderNotice(
      ownership({
        state: 'stale',
        takeover: runningTakeover(),
      }),
    )

    // States the actual duration rather than a vague "a couple of minutes",
    // both in the explanation and as a live countdown.
    expect(screen.getAllByText(/1 minute 20 seconds/).length).toBeGreaterThan(0)
    expect(screen.getByRole('status')).toHaveTextContent(/1 minute 20 seconds left/i)
  })

  it('explains why the wait is that long, in terms of the holder', () => {
    renderNotice(ownership({ state: 'stale', takeover: runningTakeover() }))
    expect(screen.getByText(/longer than the gap between a running server/i)).toBeInTheDocument()
  })

  it('falls back to a wait with no number when the server reports no timing', () => {
    renderNotice(
      ownership({
        state: 'stale',
        takeover: runningTakeover({ started_at: null, observation_seconds: null }),
      }),
    )
    expect(screen.getByRole('status')).toHaveTextContent(/watching the ownership record/i)
  })

  it('says it is finishing once the window has elapsed', () => {
    renderNotice(
      ownership({
        state: 'stale',
        takeover: runningTakeover({
          started_at: new Date(Date.now() - 200_000).toISOString(),
          observation_seconds: 80,
        }),
      }),
    )
    // The window is over but the write-then-verify still has to run, so the
    // dialog must not sit at "0 seconds left".
    expect(screen.getByRole('status')).toHaveTextContent(/finishing up/i)
  })

  it('shows progress from the moment the request is sent, before the first poll', () => {
    renderNotice(ownership({ state: 'stale', can_take_over: true }), { takeoverPending: true })

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /serve here anyway/i })).not.toBeInTheDocument()
  })

  it('says a live holder can still win the race', () => {
    // Confirmation answers "is that machine gone?"; the observation window is
    // what actually checks, and it can disagree with the user.
    renderNotice(ownership({ takeover: runningTakeover() }))

    expect(screen.getByText(/it will write during the check/i)).toBeInTheDocument()
  })
})

describe('escape hatches', () => {
  it('keeps the library picker so the user is never stranded', () => {
    const props = renderNotice(ownership())

    fireEvent.change(screen.getByLabelText('Library'), { target: { value: 'lib-2' } })

    expect(props.onChangeLibrary).toHaveBeenCalledWith('lib-2')
  })
})
