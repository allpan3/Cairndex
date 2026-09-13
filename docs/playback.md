# Playback behavior

The web and desktop viewers share playback controls. The server chooses direct
play, copy-only HLS remux, or HLS transcoding from the source and client
capabilities. Info shows that decision alongside source dimensions and codecs.
Resolution choices preserve aspect ratio and never upscale.

Video cover commands retain the displayed file's read basis when opened. An
accepted selection supplies the basis for the next reset; a peer change after
opening the command remains a conflict requiring review.

## Commands and source changes

Playback intent, the media element's paused state, and buffering are separate.
Play/Pause labels describe the next command: a buffering player that still wants
to play offers Pause. A pause remains in force through seeks, resolution/audio
changes and session recovery. Selecting another file starts that file normally.

Video keyboard commands apply while its playback decision is pending. Seek and
pause commands wait for the selected source and metadata; they do not navigate
to a neighboring image. Replacements discard queued trailing seeks and stale
play results. A decision uses the requested position to prepare server media,
then attaches its source at the current playhead so intervening seeks win.
Saved moments and resume positions seed the initial decision; an explicit zero
starts at the beginning. Ordinary moment seeks preserve pause.

## HLS timeline and completion

HLS uses a complete VOD playlist and bounded FFmpeg windows. Every window keeps
absolute source timestamps, including when the client caches the first init
fragment. Copy seeks exclude earlier keyframe/audio packets. Generation-specific
init publication and the existing process/session bounds remain in force.

An HLS end more than two seconds before the known source duration is a session
failure. It retains playback intent and enters bounded recovery without advancing
the playlist or reporting the shortened media duration as completed progress.
A normal end follows the configured range/file-loop and playlist behavior.

## Local diagnostics

Viewer Info → Playback diagnostics → Capture diagnostics exposes a copyable
snapshot. The viewer keeps at most 600 observations in memory and reports how
many older observations were evicted. Closing the viewer discards the journal.
Nothing is uploaded or persisted by this feature.

The snapshot records relative timings, playlist index/media kind, source/decision
state, playback intent, selected keyboard/pointer commands, media events and
one-second media samples. Samples include element time/duration, readiness,
buffering, decoded dimensions, available frame counters and active subtitle-track
counts. Filenames, URLs, file/library IDs, credentials and subtitle text are omitted.

Frame callbacks and counters describe presentation/decode activity; they do not
prove visible picture quality or audible output. Input logging covers viewer DOM
commands; it is not a complete operating-system input recorder. Use synthetic
media and actual media-request records to distinguish client cache behavior,
server preparation and native rendering. See the
[reliability review](proposals/playback-reliability-review.md) for measured scope.
