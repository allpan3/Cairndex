# ADR-0033: Selective native file-drop capture

- Status: proposed; owner decision required before implementation
- Date: 2026-09-13
- Branch: `fix/library-ownership-lifecycle`

## Blocked requirement

A Finder drop of existing library files must support metadata-only grouping or
linking without copying source bytes. External files require deployment and
library write permission plus journaled imports. An app-originated file drag
returning to its own window must not import a duplicate. Bundle-target drops,
HTML/picker imports and internal reorder/collection gestures must keep working.

The shipping HTML `File` route supplies bytes without trustworthy source-path
identity. Accepting a path or a claimed OS-drop token from JavaScript would not
repair that boundary. Enabling the stock native handler consumes internal HTML
drags. The integration group therefore remains incomplete independently of the
already-passed transfer, Open/Reveal, picker-import and keyboard-reorder checks.

## Verified framework evidence

These findings come from the registry sources matching the checked-in
[Cargo.lock](../../apps/desktop/src-tauri/Cargo.lock), not a proposed upgrade.

| Layer | Relevant behavior |
| --- | --- |
| Tauri 2.11.5 | `WebviewBuilder::disable_drag_drop_handler` controls one boolean; window/webview event listeners cannot return a synchronous handling decision |
| tauri-runtime-wry 2.11.4 | `create_webview` installs Wry's handler, queues each event, then unconditionally returns `true` |
| Wry 0.55.1, macOS | A `false` callback forwards Enter/Over/Drop/Leave to WebKit. Over then changes WebKit's `None` result to `Copy`, so forwarding does not preserve every return value |
| Wry 0.55.1, Windows | The controller replaces WebView2's drop targets with `RevokeDragDrop`/`RegisterDragDrop`; it ignores the callback's boolean return. A macOS forwarding fix does not fix Windows |
| Wry 0.55.1, Linux | GTK signal handling and drop completion differ from macOS; they require separate qualification |

Tauri's runtime plugin observes an event-loop message after the native callback
has returned. `on_webview_ready`/`with_webview` expose an existing platform view,
not Wry's construction-time callback. Page/navigation hooks cannot recover OS
file identity. The exposed macOS `WKUIDelegate` has no interchangeable drag
routing delegate; `WKWebView` itself implements `NSDraggingDestination`.
Installing native handling through the platform handle is the adapter below,
not an existing plugin configuration switch.

Wry's macOS collector reads `NSFilenamesPboardType`; the `drag` crate 2.1.1 writes
`NSURL` pasteboard items. Compatibility for incoming Finder files and returning
app drags must be verified, not assumed from the callback signature.

## Recommendation awaiting approval

Approve a **macOS adapter in `src/host_file_drop_macos.rs`**, using public
`NSDraggingDestination`/`NSDraggingInfo` and file-URL pasteboard APIs. Keep
`dragDropEnabled: false`. Prefer this over maintaining a Tauri fork: it gives the
application the actual OS source/session boundary and modern file-URL capture,
while leaving the existing framework and non-file event handling intact.

This is a deliberate native boundary, not a claim that Tauri already supports
it. [AGENTS.md](../../AGENTS.md) requires a new accepted ADR before direct AppKit
usage. No native adapter, framework patch or vendored dependency is implemented
or authorized by this proposed record.

### Adapter ownership and chaining

Install once for the main webview on the main thread. Use an instance-specific
subclass of its actual runtime class; do not replace methods on global AppKit,
WebKit or Wry classes, access private ivars, or replace `WKUIDelegate`. Preserve
the original class and destination-method implementations. The adapter owns four
native drag callbacks and a per-view state record, with weak application/window
references. Forward every non-file/internal callback to its original implementation
with unchanged arguments and return value. Consume a recognized native file drop
once so WebKit cannot also import its HTML representation.

Copy native event values while the callback is alive; never retain or use the
`NSDraggingInfo` argument on a background worker. Canonicalization, manifest
validation and file I/O stay off the UI thread. On webview teardown, invalidate
pending drops and remove the state; restore the original class only if this
adapter still owns it. No delayed work may use a released view. Unknown class
composition or failed installation leaves the HTML path intact and marks native
capture unavailable; it must not claim trusted grouping or self-drop protection.

Subclass chaining and teardown are implementation acceptance risks. If preserving
the original WebKit/Wry behavior cannot be demonstrated, stop this choice and
return to the framework-patch alternative; do not silently switch designs.

### Shared routing and authority

Only a native **Drop** callback can create a bounded, opaque drop record. Hover,
HTML events, filenames and renderer-supplied tokens cannot grant read authority.
Bind the record to its window, captured connection epoch/server, active library
identity and actual OS files. Scope changes, cancellation and teardown retire it;
claim it once before asynchronous processing. Re-prove source containment and
portable library identity before metadata work; opening a source for upload must
match the authorized file, not a subsequently retargeted path.

Use the OS drag source/session to distinguish self-return from a later genuine
Finder drop of the same file. The current recent-path/time guard alone is
insufficient to make that distinction. Keep paths inside Rust where practical;
pass opaque references, relative mapped paths and display metadata to the UI.

Capture the intended target once from drop coordinates: File Browser directory,
bundle card/inspector, or global grouping surface. Ignore blocked surfaces and
reject a target made stale by a server/library switch. Route in-library files to
metadata-only grouping/linking; route outside files through the existing gated,
journaled import flow, preserving destination choices, collisions, cancellation,
Undo and post-import linking. Mixed drops use one coordinated plan, not competing
dialogs. Browser and picker HTML imports remain available. Never run both native
and HTML import paths for the same physical drop.

## Alternative comparison

| Choice | Surface and platform limit | Maintenance, packaging and privacy |
| --- | --- | --- |
| Recommended macOS adapter | Four native callbacks plus one view-lifecycle module and shared drop records/routing. Reads OS source and file URLs directly. Other platforms retain their current HTML behavior and are explicitly unqualified for trusted native routing | Direct pinned `objc2`/AppKit bindings already present transitively, without a vendored framework. Own the lifetime/chaining tests and recheck them on Tauri/Wry/macOS updates. Normal app build/signature checks; no new entitlement, input monitor or global shortcut change |
| Maintained framework patch | A selective gate in `tauri-runtime-wry::create_webview` is roughly 25–40 production lines plus tests, an estimate for that gate only. Complete behavior also requires Wry work: preserve WebKit's Over return and expose source/session identity absent from its event payload; qualify file-URL formats. macOS only; it does not restore Windows delegation | The cached runtime crate alone contains 23 files / 315,893 bytes before source curation. Carry pinned source forks and patches, preserve licenses/provenance, declare `vendored_trees` in the privacy allowlist, audit them before any publication and rebase/requalify every runtime update. Never modify the global Cargo cache or download/apply an unreviewed patch during builds |

The framework gate must remember whether **Enter** belongs to a file drag, retain
that decision for **Over**, and clear it on **Drop/Leave**. Only fresh Drop paths
authorize reads. Testing only `paths.is_empty()` cannot classify Over/Leave, which
carry no paths. Stock behavior on other platforms must remain unchanged unless a
separate supported forwarding design is approved and qualified.

Keeping HTML-only imports does not fulfill the intended source-identity contract.
Replacing all internal HTML gestures with a new pointer-drag system is a much
broader interaction rewrite. Neither is selected as a shortcut to completion.

## Engineering acceptance and native qualification

Engineering owns this work; there is no owner regression checklist. After approval:

- Test drop-record creation, replay rejection, cross-window/server/library scope,
  teardown, path retargeting, missing roots/identities, and non-file forwarding.
- Exercise metadata-only in-library linking/grouping and mixed drops against a
  real disposable backend; verify unchanged source hashes and exact memberships.
  Exercise gated external imports, destination selection, journal/Undo, collisions,
  cancellation and recovery. Keep HTML picker/import and internal gesture regressions.
- Build the actual packaged app, run relevant frontend/backend/Rust gates and the
  Ubuntu Rust-only gate where available, and verify the app signature and privacy
  gate. Do not treat platform compilation as native interaction qualification.
- In the foreground production app, verify Finder file drops, returning app drags,
  bundle targets and internal collection/reorder gestures with synthetic fixtures.
  Inspect visible outcomes plus destination bytes, metadata and journals. No injected
  drop credentials or filesystem copies may stand in for real OS delivery.

Existing owner-performed single-file transfers and agent-observed Open/Reveal,
picker batch import and keyboard reorder remain passed baseline evidence. Any
changed native boundary needs a new native replay. If available controls cannot
perform a physical gesture, record that exact evidence gap and its consequence:
self-return failure risks duplicate imports; forwarding failure breaks internal
gestures; scope failure can target the wrong library. Do not label these optional
or ask the owner to close an implementation gap by testing.

## Sources

- [Tauri webview API source, 2.11.5](https://docs.rs/crate/tauri/2.11.5/source/src/webview/mod.rs): `disable_drag_drop_handler`, `with_webview`
- [Tauri plugin source, 2.11.5](https://docs.rs/crate/tauri/2.11.5/source/src/plugin.rs): webview lifecycle hooks
- [Runtime source, 2.11.4](https://docs.rs/crate/tauri-runtime-wry/2.11.4/source/src/lib.rs): `create_webview`, `Plugin::on_event`; package VCS revision `ca90b46b2e2cbbc981dae1b809f4af4343fe0558`
- [Wry macOS source, 0.55.1](https://docs.rs/crate/wry/0.55.1/source/src/wkwebview/drag_drop.rs): synchronous superclass forwarding and path collection
- [Wry Windows source, 0.55.1](https://docs.rs/crate/wry/0.55.1/source/src/webview2/drag_drop.rs) and [GTK source](https://docs.rs/crate/wry/0.55.1/source/src/webkitgtk/drag_drop.rs): distinct interception behavior
- [Desktop drag contract](../plans/03-macos-desktop-app.md#6-drag-out--drag-in), [ADR-0013](0013-library-write-mode.md), [verification record](../desktop-file-integration-verification.md)
