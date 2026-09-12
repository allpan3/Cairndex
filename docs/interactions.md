# Everyday interactions

## Listing selection

Click or Tab into a listing before using its selection shortcuts. Arrow keys
move through the displayed order; Up/Down follow grid rows, including virtualized
rows outside the viewport. Home/End reach the first/last loaded item.

Shift extends a range from its anchor, and reversing direction shrinks it.
Command/Ctrl-click toggles an item; Command/Ctrl+Shift adds a range. Command/Ctrl
arrows move focus without replacing the selection. Text inputs and editable
content retain their normal shortcuts. Open viewers, dialogs and menus keep
their commands without changing a background listing.

Command+A on macOS, or Ctrl+A, selects the focused listing's loaded items. When
another page is available, a status message identifies how many loaded items
are included. Selection does not fetch or imply selection of the entire result
set. Collection cards and bundles keep separate selections and actions.

Escape clears a focused listing's selection. File and bundle selections use
visible focus indicators independently of the selected range.

## Dialogs and collection drafts

Escape dismisses the top eligible dialog or picker. Tab stays within the active
dialog, and closing returns focus to its opener. Nested pickers close before
their parent dialog. Dialogs awaiting a confirmed mutation remain open until
that operation finishes; closing a dialog does not undo a saved action.

New Collection and New Subcollection open a local name draft. Create confirms
the name and parent; Cancel, Close and Escape discard an unsubmitted draft.
A failed create retains the name and focuses it for correction. Existing
collections are unaffected by cancelling a new draft.

Smart Collection changes are submitted by Create or Save. Cancel, Close and
Escape discard that dialog's unsaved edits. Replica conflict review retains its
existing private-draft behavior.
