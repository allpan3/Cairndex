/**
 * The "Open Library Folder…" flow (plan 3 D6.4/D6.5).
 *
 * Picking a folder, starting the local server, and registering the folder all
 * happen inside the shell in one command — the absolute path never reaches this
 * layer, only ids. What is left here is the *client* half: point the app at the
 * local connection and select the library that was opened.
 *
 * Ordering matters for the same reason it does in `activateConnection`: the
 * cancellable step runs first, so a user who dismisses the picker has changed
 * nothing at all.
 */

import { openHostLibraryFolder, type OpenedLibrary } from '../platform'
import {
  activateConnection,
  ensureLocalConnection,
  setPendingLibrarySelection,
  LOCAL_CONNECTION_ID,
} from './connections'

export interface OpenLibraryFolderResult {
  /** Null when the user dismissed the picker — not an error, and not a change. */
  opened: OpenedLibrary | null
}

/**
 * Prompt for a library folder and make it the active library.
 *
 * Throws with the shell's own message when the folder is not a library, the
 * sidecar cannot start, or the server refuses the registration.
 */
export async function openLibraryFolder(
  knownLibraryUuids: string[] = [],
): Promise<OpenLibraryFolderResult> {
  // Cancellable step first: dismissing the picker must leave the current
  // connection, cache, and library exactly as they were.
  const opened = await openHostLibraryFolder(knownLibraryUuids)
  if (!opened) return { opened: null }

  // The current server already has it. Starting a local one would make a second
  // server for the same folder, which the lease refuses — so the useful action
  // is simply to select what is already there. The caller resolves the library
  // by uuid, since our id would belong to a registry it is not talking to.
  if (opened.alreadyAvailable) return { opened }

  await ensureLocalConnection()

  // Queued *before* activation, because activating remounts the query scope and
  // with it the component that would consume this. Setting it after would race
  // the remount it is meant to survive.
  setPendingLibrarySelection(LOCAL_CONNECTION_ID, opened.libraryId)

  await activateConnection(LOCAL_CONNECTION_ID)
  return { opened }
}
