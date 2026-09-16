# Everyday interactions

## Listing selection

Click or Tab into a listing before using its selection shortcuts. Arrow keys
move through the displayed order; Up/Down follow grid rows, including virtualized
rows outside the viewport. Home/End reach the first/last loaded item.
File-list keyboard scrolling keeps the target row below the sticky column header.

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

## Panels and compact toolbars

Panel widths are preferences. When a window narrows, the sidebar and inspector
shrink above their existing minimum widths to reserve 400 pixels for the listing;
widening the window restores the preferred widths. Panel visibility, selection,
layout and item-size preferences remain independent. The desktop minimum is
960 × 640; browser checks also cover 800-pixel-wide windows.

When item sizing leaves the toolbar, **View options** exposes layout and item
size in a keyboard-accessible dialog. At narrower widths it also replaces the
inline layout buttons. File Browser includes **Add Files Here** in this dialog
when the current directory permits imports. Search, sort and panel controls
remain on the toolbar. Escape closes the dialog and returns focus to its opener.

## Shortcut reference

**Settings → Keyboard shortcuts** describes focused-listing keys, shared video
keys and desktop menu accelerators separately. Desktop also provides **Help →
Keyboard Shortcuts** once connected to a server. The reference reads the same
command table as native menus, and panel tooltips show their accelerator only in
the desktop app. Browser controls remain the way to invoke desktop-only actions;
no new global or bare-key bindings are registered.

## Inspector hierarchy

Bundle covers retain their preview and drag behavior in a compact frame capped
at 144 pixels high. The cover Play button is visible on keyboard focus as well as
hover. Title, rating and metadata remain editable with the same save semantics.
Existing section-folding preferences are retained.

File inspectors show type, size, dimensions, duration, dates and status first,
then location and available mapped-host actions. **More details** exposes the
full path, encoding and other technical facts without pushing actions below a
long path. This disclosure starts closed for each selected file. Long values
wrap within the panel. Bulk selection retains its existing common-metadata controls.

## Inspector loading

Unknown file counts and sizes show Loading. Failed requests offer Retry;
successful empty lists explicitly report no files. Cached files remain visible
during refresh or a failed refresh, with a status identifying that state.
Folder membership must load before files are arranged into loose and folder
rows. Changing the selected bundle fences late responses to the previous bundle.

## Navigation continuity

Inspector folder disclosures survive File Browser and viewer round-trips in the
current window. The retained state uses server, library, bundle and surface
identity; it does not change folder membership. The window retains at most 128
inactive navigation scopes.

Indexed File Browser selections and the open viewer follow file IDs across
rename and reordering. Directories and unindexed files use paths. Each folder,
view and search has its own selection scope. Bundle selections survive sorting
and refresh, and clear when the view, collection, search or filter scope changes.
Missing selections are pruned only after a complete successful listing; partial
pages and failed refreshes cannot establish that an item is gone.

Folder playback includes that folder's files. A parent's playlist retains its
loose-file boundary; expanding a disclosure does not add child files to it.
