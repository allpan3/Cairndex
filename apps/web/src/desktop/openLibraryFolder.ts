/**
 * The folder-opening flow (plan 3 D6.4/D6.5).
 *
 * Picking a folder, starting the local server, and registering or creating the
 * library all happen inside the shell — the absolute path never reaches this
 * layer, only ids and, for a folder that is not a library yet, an opaque token.
 * What is left here is the *client* half: point the app at the local connection
 * and select the library that was opened.
 *
 * Ordering matters for the same reason it does in `activateConnection`: the
 * cancellable step runs first, so a user who dismisses the picker has changed
 * nothing at all. A folder that needs a name is the same rule taken one step
 * further — nothing switches until the user has confirmed.
 */

import { confirmHostPickedLibrary, openHostLibraryFolder, type OpenedLibrary } from '../platform'
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
 * When the picked folder is not a Cairndex library, this returns the
 * confirmation request untouched: nothing has been created, no server started,
 * and no connection switched. The caller shows the name dialog and finishes
 * through {@link confirmPickedLibrary}.
 *
 * Throws with the shell's own message when the sidecar cannot start or the
 * server refuses the registration.
 */
export async function openLibraryFolder(
  knownLibraryUuids: string[] = [],
  options: { adopt?: boolean; stage?: boolean } = {},
): Promise<OpenLibraryFolderResult> {
  // Cancellable step first: dismissing the picker must leave the current
  // connection, cache, and library exactly as they were.
  const opened = await openHostLibraryFolder(knownLibraryUuids, options.stage ?? false)
  if (!opened) return { opened: null }

  // Not a library yet. The shell is holding the folder against the token; until
  // the user names it there is nothing to switch to, and cancelling the dialog
  // must be as free as cancelling the picker was.
  if (opened.needsConfirmation) return { opened }

  // The current server already has it. Starting a local one would make a second
  // server for the same folder, which the lease refuses — so the useful action
  // is simply to select what is already there. The caller resolves the library
  // by uuid, since our id would belong to a registry it is not talking to.
  if (opened.alreadyAvailable) return { opened }

  // Registered with the local sidecar by the shell. The first-run/open-folder
  // flow *adopts* it (switches to it); the Manage dialog passes `adopt: false`,
  // because adding a library to the list is not the same as switching to it —
  // and switching remounts the app, which is exactly what closes that dialog.
  if (options.adopt ?? true) await adoptOpenedLibrary(opened)
  return { opened }
}

/**
 * Create the library at a picked folder and make it active.
 *
 * The second half of a `needsConfirmation` pick. The token — not a path — is
 * what identifies the folder; the shell refuses one that a later pick has
 * superseded, so a name typed for one folder can never land on another.
 */
export async function confirmPickedLibrary(
  token: string,
  name: string,
  options: { adopt?: boolean } = {},
): Promise<OpenLibraryFolderResult> {
  // Creation first, and only then the switch: a failure here (a blank name, an
  // unwritable folder, a stale token) must leave the current connection alone.
  const opened = await confirmHostPickedLibrary(token, name)
  // `adopt: false` (the Manage dialog) creates the library and leaves it in the
  // list without switching to it, so the dialog stays open on an explicit add.
  if (options.adopt ?? true) await adoptOpenedLibrary(opened)
  return { opened }
}

// Points the app at the local server and queues the library it just opened
async function adoptOpenedLibrary(opened: OpenedLibrary): Promise<void> {
  await ensureLocalConnection()

  // Queued *before* activation, because activating remounts the query scope and
  // with it the component that would consume this. Setting it after would race
  // the remount it is meant to survive.
  setPendingLibrarySelection(LOCAL_CONNECTION_ID, opened.libraryId)

  await activateConnection(LOCAL_CONNECTION_ID)
}
