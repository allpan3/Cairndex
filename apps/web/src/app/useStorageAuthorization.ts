import { useState } from 'react'

export const ACCESS_REQUEST =
  'Cairndex needs your permission to use the login saved for this network share.'
export const ACCESS_WAITING =
  'macOS asks for your Mac login password. Type it, then choose Always Allow.'
export const NO_SAVED_LOGIN =
  'No saved login matches this network share. In Finder, connect to the share and choose to remember the password in your keychain. Then retry.'

/** One authorization request at a time, with the refusal kept for display. */
export function useStorageAuthorization(
  authorize: () => Promise<unknown>,
  onAuthorized?: () => void,
) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  async function allow() {
    setWaiting(true)
    setError('')
    try {
      await authorize()
      onAuthorized?.()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setWaiting(false)
    }
  }
  return { waiting, error, allow }
}
