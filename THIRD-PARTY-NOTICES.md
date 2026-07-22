# Third-party notices

Cairndex's own source code is licensed under the MIT License; see
[LICENSE](LICENSE). This file covers third-party software **redistributed
inside a Cairndex release artifact**, which carries obligations that MIT does
not.

Nothing here applies to a Cairndex you built yourself from source, or to the
Docker image, which uses the base image's own ffmpeg rather than a bundled one.

---

## FFmpeg (ffmpeg, ffprobe) — bundled in the macOS desktop app

The macOS desktop app ships `ffmpeg` and `ffprobe` inside
`Cairndex.app/Contents/Resources/`. Cairndex invokes them as separate
executables via `subprocess` (`apps/server/src/cairndex/media/ffmpeg_exec.py`)
and does not link against the FFmpeg libraries. That is the standard
aggregation case, so bundling does not affect Cairndex's own MIT license — but
**distributing the binaries does carry the GPL's source obligations**, which is
what this notice discharges (see
[ADR-0019](docs/adr/0019-open-source-distribution-model.md) §3).

| | |
| --- | --- |
| Version | FFmpeg 8.1.2 |
| License | **GPL-3.0-or-later** |
| Copyright | © 2000–2026 the FFmpeg developers |
| Project | <https://ffmpeg.org/> |
| Binaries built and signed by | Martin Riedl (<https://ffmpeg.martin-riedl.de/>) |

The build is GPL rather than LGPL because it enables `--enable-gpl` and
`--enable-version3`. Cairndex needs `libx264` for its HLS transcode ladder
(`media/hls.py`; only the remux path is `-c:v copy`), and any practical static
build carrying libx264 is GPL. The build does **not** use `--enable-nonfree`,
which is what makes it redistributable at all.

### Configure options

```text
--prefix=/Volumes/ffmpeg_arm64/out --pkg-config-flags=--static
--extra-version='https://www.martin-riedl.de' --enable-gray --enable-libxml2
--enable-version3 --enable-gpl --enable-openssl --enable-libfreetype
--enable-fontconfig --enable-libharfbuzz --enable-libsnappy --enable-libsrt
--enable-libvmaf --enable-libass --enable-libklvanc --enable-libzimg
--enable-libzvbi --enable-libaom --enable-libdav1d --enable-libopenh264
--enable-libopenjpeg --enable-librav1e --enable-libsvtav1 --enable-libvpx
--enable-libvvenc --enable-libwebp --enable-libx264 --enable-libx265
--enable-libmp3lame --enable-libopus --enable-libvorbis --enable-libtheora
```

Reproduce it from any bundled copy with:

```bash
/Applications/Cairndex.app/Contents/Resources/cairndex-sidecar/ffmpeg -buildconf
```

### Exact binaries redistributed

`apps/server/packaging/ffmpeg-manifest.json` is the authoritative pin. As of
FFmpeg 8.1.2:

| Platform | Tool | SHA-256 of the binary |
| --- | --- | --- |
| macOS arm64 | ffmpeg | `eaf91238e104dd0e262bc6510e25061855cc99a6955a721b0ac99660d58c473d` |
| macOS arm64 | ffprobe | `ed9dc5871914b466b96b402c9ec0ba68ce4f836e72faa464b1b4e279835bd4a6` |
| macOS x86_64 | ffmpeg | `1ca59dda73668c59898a0b305afd8a88817a989187f222ec62d64e775d614d23` |
| macOS x86_64 | ffprobe | `bdb6aff0f1f414382effd97040f7862dc85e67996ac296cb4288beed0e06498f` |

Upstream download URLs, archive checksums, and the component version list are
recorded in that manifest.

### Written offer for the corresponding source

The corresponding source for the FFmpeg version above is FFmpeg 8.1.2 as
published at <https://ffmpeg.org/releases/> (`ffmpeg-8.1.2.tar.xz`), configured
with the options listed above. The versions of every statically linked
component are published alongside the binaries as `versions.txt` — the pinned
copy is linked from `ffmpeg-manifest.json`.

For three years from the date you received a Cairndex release artifact, the
Cairndex project will provide, on request and for no more than the cost of
physically performing source distribution, a complete machine-readable copy of
the corresponding source for the FFmpeg binaries in that artifact. Open an
issue at <https://github.com/allpan3/cairndex/issues> to request it.

---

## Bundled Python runtime and dependencies

The desktop app also bundles a frozen Python interpreter and Cairndex's Python
dependencies (PyInstaller one-dir; ADR-0019 §2), under
`Cairndex.app/Contents/Resources/cairndex-sidecar/`. The interpreter is under
the PSF License and the direct dependencies are permissive: FastAPI, SQLAlchemy,
Pydantic, pydantic-settings and python-ulid are MIT, uvicorn is BSD-3-Clause,
and Pillow is MIT-CMU. The authoritative set is `apps/server/pyproject.toml`
plus its lockfile.

**One item is unresolved and should be confirmed before the first release.**
`pillow-heif` — which is what makes HEIC files viewable at all — declares
`BSD-3-Clause`, but its published metadata also carries a GPLv2 classifier, and
its binary wheels bundle **libheif**, which is LGPL-3.0-or-later. LGPL
redistribution is workable (Cairndex does not modify libheif, and the wheel
ships it as a separate shared library), but it carries its own relinking and
notice obligations that this file does not yet discharge. Flagged rather than
assumed away, in keeping with ADR-0019 §3: this is a recorded constraint, not
legal advice.
