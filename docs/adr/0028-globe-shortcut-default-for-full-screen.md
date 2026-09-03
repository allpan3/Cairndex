# ADR-0028: Register the AppKit Globe-shortcut default so Full Screen shows ⌃⌘F

- Status: accepted (owner-ratified 2026-09-02)
- Date: 2026-09-02
- Branch/PR: `feat/browser-ui-fixes`
- Supersedes the conclusion of [ADR-0027](0027-vendored-muda-command-modifier.md)

## Context

The owner asked for one *Enter Full Screen* item in the View menu, displaying
⌃⌘F. Three attempts failed, each on a wrong model of what AppKit does:

1. A custom item at ⌃⌘F displayed correctly but AppKit added a second *Enter
   Full Screen* at 🌐F beside it.
2. Tauri's predefined item (bound to `toggleFullScreen:`) removed the duplicate
   but displayed 🌐F.
3. ADR-0027 vendored and patched muda, on the reading that its macOS modifier
   mapping dropped `Modifiers::META` and so built the item with a broken key
   equivalent. The menu still displayed 🌐F. That ADR concluded AppKit rewrites
   the item's shortcut and the display was not ours to set. Both halves were
   wrong: muda's constructors fold `META` into `SUPER`, so the accelerator was
   correct all along (pinned now by
   `src/keymap.rs::cmd_and_cmdorctrl_mean_the_same_thing`), and AppKit does not
   rewrite anything.

**That conclusion was wrong.** A Cocoa probe that dumps `NSApp.mainMenu` after
launch shows what AppKit actually does on macOS 26.6: it does not touch our
item's key equivalent. It *adds* its own item and *hides* ours.

```text
[3] Enter Full Screen  action=toggleFullScreen:  keyEq='f'  mods=0x800000 FUNCTION(Globe)  hidden=0
[4] Enter Full Screen  action=toggleFullScreen:  keyEq='f'  mods=0x140000 Control+Command   hidden=1
```

With a custom action it cannot recognize ours, so it adds its own and hides
nothing — the two-item case. Either way the substitution, not the accelerator,
was the whole problem.

The probe also found what suppresses it. Registering
`NSApplicationEnableGlobeShortcuts` as `false` **before `NSApplication` is
created** leaves exactly one visible item at ⌃⌘F, with the system action intact,
at every checkpoint (launch, activation, menu update, and a forced
`_addFullScreenMenuItemIfNeeded`):

```text
[3] Enter Full Screen  action=toggleFullScreen:  keyEq='f'  mods=0x140000 Control+Command  hidden=0
```

Setting the same key in `Info.plist` does nothing; the registration domain is
what AppKit consults. `UserDefaults.standard.set` and
`CFPreferencesSetAppValue` also work but persist a preference to disk, which
registration does not.

## Decision

Register that default at the top of `fn main()`, before Tauri builds anything,
from a new `globe_shortcuts` module. `NSUserDefaults.registerDefaults:` has no C
entry point, so unlike [ADR-0023](0023-native-modifier-state-during-drag.md)'s
single `extern "C"` declaration this needs an Objective-C bridge: `objc2` and
`objc2-foundation` become direct macOS-only dependencies, pinned to the versions
already in the graph via tao/muda so no second copy of the runtime is compiled
and no new crate enters the build (the lockfile gains two edges, nothing else).

The `#[cfg(target_os = "macos")]` seam stays inside that one module, as
`modifiers` does, so the Ubuntu Rust-only gate keeps building.

muda stays unpatched and unvendored, and there was never anything to patch: the
`META`/`SUPER` mismatch that looked like a bug is unreachable, because both of
muda's accelerator constructors normalize `META` away and the field is
crate-private. The predefined item's key equivalent was correct before any of
this; what it displayed was AppKit's substitute item, not our accelerator.

## Consequences

- The View menu shows one *Enter Full Screen* at ⌃⌘F, carrying the system
  action, so the green button, Mission Control and the window's own full-screen
  transitions are unaffected.
- **The key is undocumented.** It exists in AppKit's compatibility
  default-value table (`_NSApplicationEnableGlobeShortcutsDefaultValueFunction`)
  and in no header. A macOS update could rename or ignore it; the only symptom
  would be the menu showing 🌐F again, which is where it started. Nothing else
  regresses, and ⌃⌘F keeps working regardless because macOS binds it globally.
- It disables *standard Globe key equivalents* for this process, app-wide. The
  shell defines no other Globe shortcut, so the blast radius is this one item.
  A narrower sibling key, `NSHideStandardGlobeKeyEquivalentsFromWindow`, exists
  in the same table and was not tested.
- A unit test asserts the registration lands and reads back false — the part
  this module owns. A second, in `keymap.rs`, pins the accelerator equivalence
  that ADR-0027 got wrong, so the false lead cannot be followed twice. The menu it affects belongs to AppKit and cannot be asserted
  from a test process, so the visible result is verified by the owner opening
  the menu.
- **Removal condition:** if Apple documents a supported opt-out, or the key stops
  working, delete the module, its dependency edges and the call in `main`, and
  the menu returns to the system's 🌐F.
