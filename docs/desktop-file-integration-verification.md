# Desktop file integration verification

Scope: the production macOS shell on `fix/library-ownership-lifecycle`, using
disposable libraries and Finder. Native gesture results require visible outcomes
and matching destination bytes; command dispatch or selection alone is insufficient.

## Verified

| Check | Evidence |
| --- | --- |
| Single-file drag-out and drag-in | Owner performed both gestures; destination SHA-256 values match their sources, and all six original files remain unchanged |
| Import persistence | The incoming copy has a completed `IMPORT` journal entry |
| Mapped Open | Preview's document URL and visible image match before/after library switching, after a server round trip, and after recovery from missing files/roots |
| Bundle Open after failed server switching | Failed connection leaves the local workspace selected; the bundle context action opens its correct local cover in Preview |
| Mapped Reveal | Previously verified visible target after a library switch |
| Missing file and wrong portable identity | Packaged Open shows the corresponding rejection without opening the file |
| Unavailable mapped root | Packaged Open and Reveal show “Volume not mounted”; restoring the root restores Open |
| Unmapped remote library | A second disposable server shows its own library and no Open/Reveal buttons; cancelling Locate leaves it unmapped |
| Navigation protection | The reproduced drag/layout sequence retains the SPA in the final package |
| Automated checks | Rust format/Clippy and 129 tests; 57 initial and 111 additional targeted frontend tests; 175 backend path/operation tests; eight browser drag/import regressions; production build and signature verification |

The additional frontend checks cover server activation and failure recovery,
mapping setup, import sequencing/collision/cancellation, modifier-state changes,
file-menu permissions, selection-aware drag sources and reorder calculations.
They do not establish native gesture delivery. No executable code changed during
this verification follow-through; full frontend/backend suites were not repeated.

## Prepared manual session

Use **Cairndex File Check**, not an installed app or an owner library. The fixture
root is `/private/tmp/cairndex-file-integration`; Finder's **Go → Go to Folder**
can open it directly.

- **Library A** is writable. **Drag Check** contains `Amber.png` and `Blue.png`,
  in that order, and belongs only to **Drag Source**. **Drag Target** is empty.
- **Library B** is read-only and contains only `Shared.png`.
- **External** contains the named synthetic inputs below. Its files are copies.
- **Receiver** contains a separate empty subfolder for each outgoing check.
  Its existing root-level `Amber.png` is the earlier verified transfer.
- The saved second server at port **18973** serves **Library Remote**. It is
  unmapped and contains a blue `Shared.png`. Port **18974** is the deliberately
  unavailable connection used for failure recovery; ignore it.

Run the checks in order. M6 temporarily renames the two original bundle files;
M7 then adds files to the bundle. Report each ID as pass/fail and
describe the visible error or unexpected result. The agent can check bytes,
journal entries, bundle order and collection membership afterward.

## Remaining manual checks

| ID | Action | Expected result |
| --- | --- | --- |
| M1a | Library A → Files: select Amber and Blue together, then drag from either selected row into `Receiver/Multi Out` | Both files arrive; originals remain |
| M1b | Repeat from the File Browser's **Card** layout, using `Receiver/Card Out` | Both files arrive; selection matches what was carried |
| M1c | Drag `External/Batch One.png` and `Batch Two.png` together into Library A → Files | Both appear in Library A; external originals remain |
| M2a | Files: select Amber and drag its **filename at the top of the right inspector** into `Receiver/Inspector Out` | Only Amber arrives |
| M2b | Bundles: select Drag Check and drag the **large cover in the right inspector** into `Receiver/Cover Out` | Amber and Blue arrive |
| M2c | Right-click Drag Check → **Open Bundle**; select both album tiles and drag one into `Receiver/Album Out` | Both selected files arrive |
| M2d | In Drag Check's **Files in bundle** inspector list, hold Option before dragging Blue into `Receiver/Option Out` | Only Blue arrives; bundle order does not change |
| M3a | Start dragging a file toward `Receiver/Cancel Out`, press Escape before releasing, then release | Receiver stays empty; app remains responsive |
| M3b | Start dragging `External/Cancelled.png` into Library A, press Escape before dropping, then perform a fresh ordinary drag of that file | Cancel creates nothing; the next genuine drop imports normally |
| M4 | Switch to Library B and drop `External/Rejected.png` into Files | No file is created; the app stays on its own UI and explains the unavailable import target |
| M5 | Library A: drag Amber toward Finder, return to blank space inside Files and release; repeat from the bundle inspector cover back into the app | No duplicate import, collision prompt or navigation away; unrelated later imports still work |
| M6 | In Finder temporarily rename Library A's Blue.png to Blue.held. Drag Drag Check's cover into `Receiver/Partial Out`. Then temporarily rename Amber.png to Amber.held and repeat into `Receiver/Unavailable Out`. Restore both original names immediately afterward | Before M7 adds files: first drag carries only Amber; second reports that no files are available and writes nothing. After names are restored, normal actions work again |
| M7a | Drop `External/Bundle Add.png` on Drag Check's **bundle card**; cancel the destination dialog. Repeat and choose the library root | Cancel changes nothing; acceptance copies the file and links it once to Drag Check |
| M7b | Drop `External/Inspector Add.png` onto the **right Bundle Inspector** and choose the library root | The second file is copied and linked once to Drag Check |
| M8a | Without modifiers, drag Blue above Amber in **Files in bundle**; select another item and return | New order persists; no OS copy/import starts |
| M8b | Open Drag Source and drag Drag Check's **bundle card** onto Drag Target without Option | Membership moves: absent from Source, present in Target; disk files stay put |
| M8c | From Drag Target, start dragging the card back to Source, then press and hold Option mid-drag through release | Membership copies: bundle remains in Target and also appears in Source |
| M8d | In the inspector remove the Source membership. From Target, start an Option-drag to Source, release Option while still dragging, then drop | Final state is a move: Source contains the bundle, Target does not |
| M9 | Servers → port 18973 → Settings → Libraries → Locate. First choose Library A, then choose Library Remote | Wrong folder is rejected with no mapping; correct folder enables Open/Reveal. Open shows the blue specimen; Reveal selects Library Remote's Shared.png. Switching back to This Computer restores Library A's own mapping |

For M6, do not run Update or accept moved-file repair while the two names are
temporarily changed. Test it before M7, or use a separate two-file bundle: once
M7 adds other files, those files are also valid drag-out members.

## Limits

Computer Use currently reports `noWindowsAvailable` for some drag coordinates,
and earlier native sequences completed at unintended later interactions. Its
folder-picker attempt selected a folder while **Open** remained disabled. These
are inconclusive automation observations; M9 establishes ordinary user behavior.

The shipping HTML import route does not activate native reverse mapping or the
deterministic native self-drop route. Restoring that integration remains an
engineering decision requiring internal gestures to keep working. Native Linux,
Windows and development-server smoke tests, other receiving applications, and
real NAS disconnect latency are not qualified by these macOS local-fixture checks.
