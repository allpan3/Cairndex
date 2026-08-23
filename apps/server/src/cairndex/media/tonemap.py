"""Tone mapping an HDR source down to SDR for a transcode.

A transcode ends in ``-pix_fmt yuv420p`` with no colour conversion, which is
correct for an SDR source and wrong for an HDR one: PQ or HLG code values get
interpreted as BT.709 gamma, so the picture arrives washed out and flat. Fixing
it means an explicit chain — linearize, tone map, re-encode the result as
BT.709 — and that chain needs a filter that is **not present in every ffmpeg
build**, which is the whole reason this module exists rather than a hardcoded
``-vf`` string.

Measured, because guessing here produces either a broken command line or a
needless refusal:

- the macOS sidecar's pinned static build (martin-riedl 8.1.2) **has** ``zscale``
  and lacks ``libplacebo``;
- Homebrew's ffmpeg has **neither**, so a dev machine can be the one place this
  does not work;
- the Docker image installs Debian's ``ffmpeg`` package, which was not verifiable
  here (no daemon) — hence detection at runtime rather than an assumption. It
  costs one ``ffmpeg -filters`` call per process.

**Dolby Vision is deliberately excluded.** Profile 8.1 carries an
HDR10-compatible base layer and would tone map correctly, but profile 5 is IPT
and this chain would turn it green and magenta — worse than the flat picture it
replaced. ``ffprobe._hdr`` reports only ``"dv"``, not the profile, so the two
cannot be told apart yet; recording ``dv_profile`` is the prerequisite for
treating them differently.
"""

from __future__ import annotations

import subprocess
from functools import lru_cache

from cairndex.core.config import get_settings
from cairndex.media.tool_paths import ffmpeg_path

# Transfer characteristics this chain handles. `dv` is absent on purpose — see
# the module docstring; a wrong-colour picture is not an improvement.
TONE_MAPPABLE = frozenset({"hdr10", "hlg"})

# Reference display peak luminance, in nits, for the linear intermediate. 100 is
# the SDR reference white the BT.709 output is graded against.
_NOMINAL_PEAK = 100

# Hable rolls the highlights off gently and is the least surprising default for
# mixed content; `desat=0` keeps ffmpeg from washing out saturated highlights,
# which is the failure mode people notice on skies and neon.
_TONEMAP_OPERATOR = "hable"


@lru_cache(maxsize=1)
def _filters() -> frozenset[str]:
    """Filter names this ffmpeg build advertises, or empty if it cannot be asked.

    Cached for the process. An empty set means "assume nothing is available",
    which degrades to today's behaviour rather than emitting a command line the
    build will reject.
    """
    exe = ffmpeg_path()
    if exe is None:
        return frozenset()
    try:
        result = subprocess.run(
            [exe, "-hide_banner", "-filters"],
            capture_output=True,
            timeout=10.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    names: set[str] = set()
    for line in result.stdout.decode(errors="replace").splitlines():
        # ` .S name  V->V  description`. The arrow column is the discriminator,
        # not the flags: those are three characters on ffmpeg 7 and earlier and
        # two on 8, so keying on their width silently matches nothing.
        parts = line.split()
        if len(parts) >= 3 and "->" in parts[2]:
            names.add(parts[1])
    return frozenset(names)


def available() -> bool:
    """Whether this build can tone map at all."""
    return "zscale" in _filters()


def enabled() -> bool:
    """Whether tone mapping is switched on *and* possible."""
    return get_settings().ffmpeg_tonemap != "off" and available()


def chain() -> list[str]:
    """The filter steps that turn an HDR frame into a BT.709 SDR one.

    Returned as separate steps so the caller can place them in a wider ``-vf``
    graph. Kept as one linear pipeline: linearize to float, tone map, then land
    back on limited-range BT.709 for the encoder.
    """
    return [
        f"zscale=t=linear:npl={_NOMINAL_PEAK}",
        # float32 gives the tone-map operator headroom; anything narrower bands
        # visibly in gradients, which is where HDR content lives.
        "format=gbrpf32le",
        "zscale=p=bt709",
        f"tonemap=tonemap={_TONEMAP_OPERATOR}:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
    ]


def reason(hdr: str | None) -> str | None:
    """Why an HDR source's colour will or will not be corrected, for the UI.

    ``None`` for an SDR source: there is nothing to explain. Everything else
    returns a sentence, because "the picture looks wrong" is otherwise a mystery
    the owner cannot act on.
    """
    if not hdr:
        return None
    key = hdr.strip().lower()
    if key == "dv":
        return "Dolby Vision colour is not converted yet, so the picture may look flat"
    if key not in TONE_MAPPABLE:
        return None
    if get_settings().ffmpeg_tonemap == "off":
        return "HDR tone mapping is switched off, so the picture may look flat"
    if not available():
        return "this ffmpeg has no zscale filter, so HDR cannot be tone mapped"
    return "HDR is tone mapped to SDR"
