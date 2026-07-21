import { fetchHealth, setApiBaseUrl } from '../api/client'

export const INCOMPATIBLE_SERVER_ERROR = 'This address is not a compatible Cairndex server.'
export const UNREACHABLE_SERVER_ERROR =
  'Cairndex did not respond at this address. Check that the server is running.'

const REQUIRED_API_FEATURES = ['pairing', 'progress']
const HEALTH_TIMEOUT_MS = 5000

/**
 * Prove a URL reaches a live, compatible Cairndex backend.
 *
 * Shared by first-run setup and by connection activation. Activation needs it
 * for the same reason setup does, and leaving it out was a real defect: a lease
 * redirect would switch to the holder's advertised address without ever checking
 * anything answered there, strand the user on a dead server, and persist it as
 * the active connection so the next launch opened straight into the error.
 * Reachability is a fallible step, so it belongs before the commit.
 */
export async function verifyServer(serverUrl: string): Promise<void> {
  setApiBaseUrl(serverUrl)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const health = await fetchHealth(controller.signal)
    const compatible =
      health.status === 'ok' &&
      typeof health.app_name === 'string' &&
      health.app_name.length > 0 &&
      Array.isArray(health.api_features) &&
      REQUIRED_API_FEATURES.every((feature) => health.api_features.includes(feature))
    if (!compatible) throw new Error(INCOMPATIBLE_SERVER_ERROR)
  } catch (error) {
    if (error instanceof Error && error.message === INCOMPATIBLE_SERVER_ERROR) throw error
    throw new Error(UNREACHABLE_SERVER_ERROR, { cause: error })
  } finally {
    window.clearTimeout(timeout)
  }
}
