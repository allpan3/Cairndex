import { fetchHealth } from '../api/client'

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
 *
 * A pure probe: it must not touch the module API base. It used to call
 * `setApiBaseUrl` as a side effect, which broke activation's all-or-nothing
 * property from outside — a *failed* activation left every subsequent request
 * pointed at the dead server it had just probed, and the local branch (which
 * never probes) left the base pointed at the previous connection entirely.
 * Activation owns the base; this function only answers a question.
 */
export async function verifyServer(serverUrl: string): Promise<void> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const health = await fetchHealth(controller.signal, serverUrl)
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
