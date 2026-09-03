# ADR-0027: Do not vendor muda for the Full Screen shortcut

- Status: rejected (tried and reverted, 2026-09-01); its diagnosis of *why* was
  wrong — see [ADR-0028](0028-globe-shortcut-default-for-full-screen.md)
- Date: 2026-09-01
- Branch/PR: `feat/browser-ui-fixes`

## Context

The View menu offered two Full Screen entries: ours (`Toggle Full Screen`, ⌃⌘F)
and a second `Enter Full Screen` at 🌐F. The second is AppKit's: it inserts its
own item unless the app already owns one bound to `toggleFullScreen:`, and a
custom Tauri item is bound to a muda action instead. Building that item from
Tauri's **predefined** Full Screen item fixed the duplicate — the predefined
item carries the system selector — but the surviving entry then displayed 🌐F
rather than the ⌃⌘F muda asks for.

The owner observed that other macOS apps display ⌃⌘F, which sent us to muda's
source, where a bug appeared to be waiting. Two of muda's own producers emit
`keyboard_types::Modifiers::META` for Command:

- `accelerator.rs` parses `"Cmd"`, `"Command"` and `"Super"` to `META`
  (`"CmdOrCtrl"` alone parses to `SUPER`);
- `items/predefined.rs` builds the Full Screen accelerator as `META | CONTROL`.

…while `platform_impl/macos/accelerator.rs::modifier_mask` translates only
`SUPER` into `NSEventModifierFlags::Command`. Read in isolation that means `META`
is dropped and those accelerators reach AppKit without their Command bit.

**That reading was wrong, and it is the mistake this ADR exists to record.**
`Accelerator::new` and `KeyAccelerator::new` — the latter being what string
parsing goes through — both fold `META` into `SUPER` before storing it, and the
`mods` field is crate-private, so no value carrying `META` can reach that mask.
The unchecked branch is unreachable, not a bug. A test in
`src/keymap.rs::cmd_and_cmdorctrl_mean_the_same_thing` now pins this against the
published crate: `"Cmd+F"` and `"CmdOrCtrl+F"` produce the same accelerator, and
`"Ctrl+Cmd+F"` resolves to Control+Command.

The patch was therefore fixing nothing, which is exactly what the menu showed.

muda 0.19.3 was nonetheless vendored at `apps/desktop/vendor/muda/` and patched
in with `[patch.crates-io]`, with tests "proving" the predefined Full Screen
accelerator resolved to Command+Control+`f` — tests that would have passed just
as well against the unpatched crate, which is why they proved nothing. Running a
new test only against the patched build was the methodological error underneath
the wrong diagnosis.

**It changed nothing on screen.** With a confirmed rebuild the menu still read
🌐F, and this ADR originally concluded that AppKit rewrites the key equivalent of
whichever item carries `toggleFullScreen:`. **That was wrong.** A menu dump the
next day showed AppKit *adds* its own Globe-F item and *hides* the app's, leaving
our ⌃⌘F item present but invisible — and that substitution can be switched off.
[ADR-0028](0028-globe-shortcut-default-for-full-screen.md) has the evidence and
the mechanism. The revert below still stands: the muda patch was not what was
missing.

## Decision

Reverted. The desktop shell links published muda again, and the View menu keeps
the predefined Full Screen item: one entry, carrying the system action, its
shortcut displayed as macOS chooses.

There is no upstream bug to report. `Cmd+…` and `CmdOrCtrl+…` are the same
accelerator on macOS, which is what the pinning test asserts.

## Consequences

- The View menu shows *Enter Full Screen* with the system's 🌐F. ⌃⌘F works.
- 508 KB of third-party source, a re-vendor on every Tauri bump, and the lint
  noise a path dependency brings (it is not cap-linted) are all avoided.
- The dilemma this ADR recorded — one item at 🌐F, or ⌃⌘F with a duplicate —
  turned out to be false. ADR-0028 gets both by stopping AppKit's substitution
  instead of arguing with its accelerator.
