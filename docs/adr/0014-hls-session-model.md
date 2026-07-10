# ADR-0014: HLS playback session model and transcode-cache location

- Status: proposed (accepted-pending-owner-ratification)
- Date: 2026-07-09
- Branch/PR: `feat/playback-sessions`

> House-style note: this ADR is recorded at implementation time as required by
> plan 1 §12 and ADR-0012's follow-up list. It is marked **proposed**; owner
> ratification is pending. It documents decisions already implemented in
> milestone M6 (server-side playback decisions + HLS session foundation) so
> later milestones (M7 web integration, the TV client, the video wall) do not
> re-litigate them.

## Context

Cairndex must "play everything" across web, desktop, and TV clients whose codec
and container support varies. ADR-0012 already chose a **server-centric media
platform**: clients send a capability profile and obey a server decision of
`direct` / `remux` / `transcode`, with remux/transcode delivered as **bounded,
interactive HLS sessions** written to server-local ephemeral storage — not the
portable library package. ADR-0012 explicitly deferred the concrete HLS
session/transcode design to a follow-up ADR "at implementation time"; this is
that ADR.

Milestone M6 implements the server side only (the web hls.js integration is M7):

- a pure decision matrix (`media/playback.decide_playback`) driven by M1
  `tech_metadata` (container + video/audio codecs vs. the client's caps);
- `POST .../files/{id}/playback-decision` returning the method plus the metadata
  a player needs up front (duration, audio streams, subtitles, chapters,
  storyboard, resume progress) and, for non-direct methods, a started session;
- an in-process HLS **session manager** (`media/hls.py`) with
  `POST/GET/DELETE .../files/{id}/playback-sessions[...]`.

Constraints carried in: AGENTS.md's "no complex distributed job system" and
"no full scans / no ffmpeg on request hot paths without bounds/timeouts"; the
metadata-first, non-destructive rules (never write into a library package);
ADR-0010 library-session gating; and the M3 lesson that every ffmpeg call must
have a timeout and be killed on teardown.

## Decision

1. **Sessions are in-process interactive state, not jobs.** The session
   registry is a plain `dict` guarded by locks inside the API process
   (`SessionManager`), *not* the registry `job_queue`. Sessions are interactive
   and short-lived; routing them through the single background worker would let
   a running scan queue-block playback and vice-versa. This keeps AGENTS.md's
   "no Redis/Celery/distributed jobs" intact.

2. **Output is server-local and ephemeral:**
   `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/`. Sessions are
   non-reproducible throwaway state and must never bloat a portable
   `.cairndex/` package. This resolves the long-standing STATUS open question
   ("cache policy for future large transcodes: `inside_library` vs
   server-local") in favor of server-local — reproducible per-file artifacts
   (thumbnails, previews, storyboards, converted subtitles) stay in
   `.cairndex/cache/`; sessions do not.

3. **VOD playlist computed up front; restart on far seek.** The playlist is a
   full `#EXT-X-PLAYLIST-TYPE:VOD` fMP4/CMAF playlist with `N = ceil(duration/6)`
   6-second segments, computed by the server from the probed duration (not by
   ffmpeg). One ffmpeg per session writes `init.mp4` + `{n}.m4s` segments
   sequentially. Serving segment `n`: exists → serve; within a small window
   ahead of the encoder frontier → bounded async wait; before the current run
   or far ahead → kill ffmpeg and restart at `t = n*6` (`-ss` input seek +
   `-start_number n`). Transcode uses `-force_key_frames` for exact 6 s
   boundaries; remux copies video and **accepts keyframe drift** as a documented
   MVP trade-off (hls.js and Safari tolerate it). Audio is copied only when the
   source is already AAC, else transcoded to stereo AAC (fMP4-safe fallback).

4. **Bounds, reaper, and teardown.** `CAIRNDEX_TRANSCODE_MAX_SESSIONS`
   (default 2) caps concurrent sessions; starting one beyond the bound returns a
   structured **429** (`capacity_exhausted`). An idle reaper kills + deletes any
   session with no playlist/segment fetch for `CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`
   seconds (default 60). Sessions are also torn down by `DELETE` (player close,
   beacon-deliverable) and on server shutdown. Every ffmpeg process is spawned
   with stdio to `DEVNULL` (no pipe-deadlock), terminated then SIGKILLed on
   teardown/restart.

5. **Security.** Session routes use the same `LibrarySession` gating as direct
   streams (ADR-0010). Session ids are random (`secrets.token_hex`) and scoped
   to the issuing library (a session id is only valid under its library's
   URLs). ffmpeg args are built only from server-side-resolved paths validated
   against the active library root; no client-supplied path ever reaches ffmpeg.

6. **Optional hardware-accelerated decode.** `CAIRNDEX_FFMPEG_HWACCEL`
   (`vaapi|qsv|videotoolbox`, default none) is applied as an ffmpeg `-hwaccel`
   *decode* prefix for transcode sessions only; encoding stays `libx264` for
   portability in this MVP. Full hardware encode pipelines are out of scope.

## Alternatives considered

- **Transcode output inside `.cairndex/cache/`** — rejected (ADR-0012 already
  leaned this way): sessions are non-reproducible ephemeral runtime state and
  would bloat portable libraries.
- **Sessions on the registry job queue** — rejected: interactive playback must
  not contend with background scans/probes on a single worker, and job rows are
  durable state these throwaway sessions don't want.
- **Live/event playlist that grows as ffmpeg encodes** — rejected: a VOD
  playlist from the known duration gives instant total duration and free native
  seeking, and pairs naturally with restart-on-far-seek.
- **Keyframe-exact remux playlist** (probe every keyframe, emit exact EXTINF) —
  deferred: copy-mux keyframe drift is tolerated by players; revisit only if the
  drift proves annoying in M7.
- **Full hardware encode (VAAPI/QSV/VideoToolbox encoders)** — deferred: fragile
  per-platform filter pipelines; decode-only hwaccel plus `libx264` is the
  portable MVP.

## Consequences

- The API process now manages live ffmpeg subprocesses (spawn, bounded wait,
  restart, kill, idle-reap) — the largest new operational surface. It stays off
  the job queue and off request hot paths (only session serving touches the
  filesystem, and that is bounded).
- A new server-local directory `{CAIRNDEX_DATA_DIR}/transcode/` must be writable
  and is safe to wipe between runs; deployment docs should mount it on the app
  data volume.
- New tunables: `CAIRNDEX_TRANSCODE_MAX_SESSIONS`,
  `CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`, `CAIRNDEX_FFMPEG_HWACCEL`.
- New domain error `capacity_exhausted` → HTTP 429.
- M7 wires the web `PlaybackEngine`/hls.js to the decision + session endpoints;
  the video wall (M10) may raise the session bound via config.
- If the owner rejects any decision here, a superseding ADR is required; until
  ratification this ADR is **proposed**.

## References

- `docs/plans/01-web-media-player-and-viewer.md` §6, §12 (draft rationale)
- ADR-0012 (client platform strategy; deferred this design), ADR-0008 (library
  packages), ADR-0010 (passphrase / library-session gating)
- `apps/server/src/cairndex/media/{playback.py,hls.py}`,
  `apps/server/src/cairndex/api/v1/playback_sessions.py`
