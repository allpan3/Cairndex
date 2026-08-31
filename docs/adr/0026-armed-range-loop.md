# ADR-0026: An armed range loop confines ordinary playback

- Status: accepted
- Date: 2026-08-29
- Branch/PR: `feat/moments` (plan 7)

## Context

On 2026-08-16, while the clip range shipped (plan 1 M11), the owner rejected a
design where a marked span redefined what the play button did:

> the span is something you play, not a mode that quietly redefines the play
> button

That decision is why `useClipPlayback` was built as a **session**: Play Range
confines playback to the span, and *any* pause ends the session, so Space is
always ordinary unconfined playback afterwards. It is recorded in the plan and in
that module's own doc comment, and a test pins it.

[Plan 7](../plans/07-moments-and-range-loop.md) then asked for range looping, on
the observation that a range moment *is* an loop pair. An range loop is the
opposite of a session: it stays until you turn it off, and pausing to look at
something is not turning it off. Implementing it without touching the 2026-08-16
boundary would mean a range loop that cannot survive a pause — which is not a
loop.

## Decision

**A third mode, `armed`, is added beside `off` and `session`. While it is armed,
all playback — Space included — is confined to the marked span and repeats at the
out-point, and a pause does not disarm it.**

The 2026-08-16 decision is read as prohibiting a **quiet** redefinition of play,
not any redefinition. Armed is not quiet, and that is load-bearing rather than a
rationalisation:

- the clip bar is open, with the span's In and Out printed;
- the Loop control is lit and `aria-pressed`, and its tooltip says how to end it;
- the band is drawn on the seek track and on the magnified track;
- one click on that control ends it, and changing file or closing the bar also
  disarms.

Two further rules keep it usable rather than merely correct:

- **Only the out-point is enforced.** A playhead *before* the in-point is left
  alone, so seeking inside an armed loop works and the run-up into a span can be
  watched. Yanking it forward would make the mode a trap.
- **Arming starts it.** "Loop this span" is an action, not a preference about
  some later press, so it seeks to the in-point and plays. Disarming leaves
  playback running, simply no longer confined.

Play Range keeps its old meaning exactly: one run of the span, stop at the
out-point, any pause ends it. So the two are an action and a mode that are
genuinely different, rather than one control wearing two hats.

## Alternatives considered

- **Hold the 2026-08-16 boundary exactly: range loop confines only playback started
  from the loop control.** Rejected as not delivering the feature — this is
  today's session behaviour with a different label, and the first pause ends the
  loop. Recorded here because it is the fallback if the owner would rather keep
  the older rule; it is a two-line change (drop the `armed` arm of the pause
  handler).
- **A separate loop model beside the marked range.** Rejected. The owner asked for
  the infrastructure to be the same, plan 1 §10 predicted this consumer when the
  span was made shared, and a second span model would need its own marks, its own
  arithmetic, and its own band on the seek bar.
- **Keep `loop` as a modifier on Play Range and add a third control for the
  mode.** Rejected: the clip strip was already too crowded to read (owner,
  2026-08-16), and "repeat the span once" versus "repeat the span until I stop
  it" is not a distinction worth two controls.

## Consequences

The mode model gets *simpler*, not more complex: `useClipPlayback` went from two
booleans (`playing`, `loop`) to one three-valued mode, because "confine, do not
repeat, and survive a pause" was never a state that meant anything. The four
combinations it could previously express included two that were unreachable.

Easier:

- A saved range moment can be looped from its row in the inspector, with no
  new machinery — it loads the span into the live marks and arms.
- Loop appears in the settings menu beside Loop file, where plan 1 said the loop
  toggle would live, and explains itself when there is nothing marked yet.

Harder, and accepted:

- There is now a state in which Space does not mean "play the file". It is
  visible in four places at once and one click ends it, but it is a state, and
  that is the cost of the feature.
- The auto-advance-at-end path had to learn about it: an armed loop owns the end
  of the file, so reaching it must repeat rather than step to the next item. That
  was already true of a Play Range session (owner-reported, 2026-08-16), so the
  guard widened from "a span is playing" to "playback is confined".

## References

- [Plan 7 §2 and §4.2](../plans/07-moments-and-range-loop.md) — the design
- [Plan 1 §10](../plans/01-web-media-player-and-viewer.md) — the shared span, and
  the loop consumer it predicted
- [ADR-0025](0025-moment-tag-propagation.md) — the other decision in plan 7
