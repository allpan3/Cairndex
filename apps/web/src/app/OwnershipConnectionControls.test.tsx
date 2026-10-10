import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OwnershipConnectionControls } from './OwnershipConnectionControls'

vi.mock('../desktop/connections', () => {
  const state = {
    activeConnectionId: 'local',
    connections: [
      { id: 'local', kind: 'local', label: 'This Computer', serverUrl: null },
      {
        id: 'remote:alias',
        kind: 'remote',
        label: 'Storage',
        serverUrl: 'https://storage.example',
      },
    ],
  }
  return { getConnections: () => state, subscribeConnections: () => () => undefined }
})

function controls(
  overrides: Partial<React.ComponentProps<typeof OwnershipConnectionControls>> = {},
) {
  const onConnectTo = vi.fn()
  render(
    <OwnershipConnectionControls
      holder="Storage server"
      advertisedUrl="https://unavailable.example"
      pending={false}
      error={null}
      onConnectTo={onConnectTo}
      {...overrides}
    />,
  )
  return onConnectTo
}

describe('ownership connection alternatives', () => {
  it('uses a saved address only after an explicit submission', () => {
    const connect = controls()
    fireEvent.click(screen.getByRole('button', { name: 'Use another address' }))
    const saved = screen.getByRole('combobox', { name: 'Saved server address' })
    expect(screen.queryByRole('option', { name: 'This Computer' })).not.toBeInTheDocument()
    fireEvent.change(saved, { target: { value: 'https://storage.example' } })
    expect(connect).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Server address' })).toHaveValue(
      'https://storage.example',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connect using this address' }))
    expect(connect).toHaveBeenCalledExactlyOnceWith('https://storage.example')
  })

  it('shows address recovery immediately after a failed redirect', () => {
    controls({ error: 'The advertised address did not respond.' })
    expect(screen.getByRole('alert')).toHaveTextContent('did not respond')
    expect(screen.getByRole('textbox', { name: 'Server address' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Connect using this address' })).toBeDisabled()
  })

  it('accepts a typed address when the holder advertises none', () => {
    const connect = controls({ advertisedUrl: null })
    fireEvent.change(screen.getByRole('textbox', { name: 'Server address' }), {
      target: { value: 'https://another.example' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect using this address' }))
    expect(connect).toHaveBeenCalledExactlyOnceWith('https://another.example')
  })

  it('disables address changes and submissions during connection preparation', () => {
    const connect = controls({ pending: true, error: 'Previous attempt failed.' })
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Saved server address' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Server address' })).toBeDisabled()
    const submit = screen.getByRole('button', { name: 'Connect using this address' })
    expect(submit).toBeDisabled()
    fireEvent.submit(submit.closest('form')!)
    expect(connect).not.toHaveBeenCalled()
  })
})
