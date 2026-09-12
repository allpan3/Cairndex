# Playback reliability review — S09 / I14–I16

Scope: shared playback controls, source lifecycle, local diagnostics and bounded
HLS timeline correctness on `fix/library-ownership-lifecycle`, implementation
checkpoint `65274532`.

## Behavior

Playback intent drives Play/Pause through buffering, seeking and source changes.
Actual pause and buffering remain separately observable. Loading-time video keys
retain the selected file; queued commands wait for media metadata. New selections
reset intent, while same-file replacements retain explicit pause. Old play
promises, teardown events and trailing seeks cannot affect a replacement source.
The initial decision receives saved-moment/resume time, including explicit zero.
A delayed replacement attaches at the latest playhead.

HLS windows preserve absolute source timestamps. The MP4 muxer keeps earlier
fragment time with `frag_discont` and `output_ts_offset`; copied streams exclude
seek preroll with `copypriorss=0`. Bounds, codec decisions, bitrate ladder, cache
policy and transport defaults remain intact. An incomplete native HLS end enters
bounded recovery while retaining full source duration and playback intent.

Viewer Info exposes an in-memory journal capped at 600 observations. No source
names, URLs, library/file IDs, credentials or subtitle text enter the snapshot.
There is no telemetry or server persistence. [Playback behavior](../playback.md)
describes commands, completion and diagnostic limits.

## Reproduced defects

- During buffering, the control displayed Play while its handler paused playback.
- Explicit pause was lost when the same media received a replacement source.
- A rejected old play promise and a queued trailing seek reached a replacement.
- ArrowRight during a delayed video decision selected its neighboring image.
- A seek during a delayed quality decision was overwritten by its earlier time.
- Native HLS treated each restarted fragment window as a new zero-based timeline.
  A synthetic 150-second MKV reported duration/end at 35.915 seconds, then advanced
  to its neighboring image with no player input. A resumed single-file run also
  ended near 96 seconds. Real FFmpeg tests independently observed restarted
  windows near zero instead of their expected source timestamps.

The fixed native sequence retains duration 150.021 seconds, advances from 38.071
through 105.329 seconds over 67.257 seconds without player input, and stays on the
video. It later emits its normal end at 150.08 seconds and advances to the image.
No early end, recovery event or dropped frames occurs in that measured interval.

This reproduces the same symptom class without user interaction. The owner's
historical session has no matching event/transport capture, so attribution of
that original observation remains unresolved. The loading-key reproduction is
separate evidence and does not imply that the owner pressed a key.

## Real-media qualification

All media is generated: 150-second moving test patterns with AAC tones, two-second
keyframes, a short end-of-file fixture, an external SRT and a yellow image.
All six originals and six synthetic copies match their baseline hashes after
testing. Disposable libraries and normal APIs provide single-file and ordered
multi-file bundles.

| Input | Chromium decision/output | Production WKWebView decision/output |
| --- | --- | --- |
| H.264, 960×540, 8-bit MP4 | Direct, 960×540 | Direct, 960×540 |
| H.264/AAC copy in MKV, 960×540 | Remux HLS, 960×540 | Native HLS remux, 960×540 |
| HEVC, 1620×1080, 10-bit MP4 | H.264 transcode; selected 720p is 1080×720 | Direct, 1620×1080; selected 720p is 1080×720 |
| Paused resolution replacement | 854×480 for 16:9 input; 720×480 for 3:2 input | HEVC-to-H.264 replacement at 720×480 remains paused |

Browser runs use fresh contexts and the production web build served directly by
an isolated backend. Requests confirm progressive ranges or real playlists/init/
media fragments. This is client-context isolation, not a claim of cold server or
OS caches. Tests cover more than 60 seconds without input, changing canvas pixels
and screenshots, forward/backward/rapid seeks, paused seeks/replacements, delayed
quality changes, loading input, saved moments/resume, subtitle cues, repeated file
changes and natural end-of-file advancement. HLS clients run serially for final
measurements because the unchanged server limit is two sessions.

The final serial browser matrix passes all three cases after resetting synthetic
saved progress through the normal API. Each interval spans about 65.16 seconds,
contains 13 distinct picture hashes and has no ended event or page error.

| Input | Initial open to ready, advancing element | Hands-off source time |
| --- | --- | --- |
| H.264 direct | 1.107 s | 0.677 → 65.853 s |
| MKV remux | 1.200 s | 0.724 → 66.162 s |
| HEVC transcode | 1.108 s | 0.448 → 65.562 s |

Startup is measured before any manual resolution selection and includes the
polling interval; it is not first-frame latency or a cold-cache benchmark.
Seeks settle within the test's three-second position tolerance in 107–867 ms.
All three retain pause at 75 seconds during their 480p replacement and resume
after Play. The earlier matrix resumed two files near their end, leaving less
than 60 seconds to measure; those runs reached their full 150-second duration.

The native client is the normal source-built production `.app` with its own
bundle identifier, deep-link scheme and data directory. It uses the same backend
and fixtures through the normal server chooser. AX/keyboard controls and
window-only screenshots provide evidence; no alternate test UI or installed-app
replacement is used. Direct H.264 and HEVC, native remux and selected transcoding
have sustained progression checks. Native pause, seek, source replacement,
moment capture/recall and normal end are inspected separately.

Picture evidence is distinct from the playback clock and frame counters. Native
HLS frame callbacks can remain at zero even when screenshots show changing
pictures. One transcode run advanced with black window captures; an explicit
foreground fresh-file repeat advances from 1.740 to 71.004 seconds with changing
1080×720 pictures, no extra seeks/end and zero reported dropped frames.
Background/occluded presentation is not qualified. Earlier direct runs under
concurrent gates also reported dropped frames; no general smoothness or
picture-quality claim follows.
The isolated app's output audio was recorded separately: non-silent PCM with
RMS 0.0736 (−22.66 dBFS). Physical speaker listening is not verified.

## Gates and boundaries

Frontend lint, formatting, types, production build and 1,177 tests pass. The full
browser suite passes 155 tests. Backend Ruff, formatting, mypy and 1,436 tests pass;
one existing zscale-dependent test is skipped. The real FFmpeg regressions cover
remux/transcode window timestamps, forwards/backwards jumps and a cached first
init. Rust formatting, clippy and 124 tests pass; all 18 real managed-sidecar tests
pass against the rebuilt ARM package. Desktop launcher tests, the self-contained
ARM sidecar build/smoke, production `.app` build and signature verification pass.

All browser contexts and the isolated native app are closed. HLS session count
is zero; the disposable backend has exited and its port is closed. Synthetic
libraries, server data and native identity directories are removed. Private
logs, diagnostic snapshots, captured audio and reviewed synthetic screenshots
remain outside the repository. Build artifacts remain in ignored build directories.

Docker/NAS validation is explicitly deferred. Ubuntu, Windows, notarization,
real providers, owner libraries, large/high-bitrate media and representative NAS
performance remain unqualified. No deployment, publication, history rewrite or
owner source-file operation is included. The group's committed-range privacy gate
passes; the full branch gate remains blocked by cumulative new-blob volume above
8 MiB. History is preserved. The next proposed group is S10 everyday
keyboard/loading UX, subject to its own scope and authorization.
