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

Both architectures are built with the same options, differing only in
`--prefix` (`/Volumes/ffmpeg_arm64/out` and `/Volumes/ffmpeg_amd64/out`):

```text
--prefix=/Volumes/ffmpeg_<arch>/out --pkg-config-flags=--static
--extra-version='https://www.martin-riedl.de' --enable-gray --enable-libxml2
--enable-version3 --enable-gpl --enable-openssl --enable-libfreetype
--enable-fontconfig --enable-libharfbuzz --enable-libsnappy --enable-libsrt
--enable-libvmaf --enable-libass --enable-libklvanc --enable-libzimg
--enable-libzvbi --enable-libaom --enable-libdav1d --enable-libopenh264
--enable-libopenjpeg --enable-librav1e --enable-libsvtav1 --enable-libvpx
--enable-libvvenc --enable-libwebp --enable-libx264 --enable-libx265
--enable-libmp3lame --enable-libopus --enable-libvorbis --enable-libtheora
```

The verbatim line for each architecture, plus the version of every statically
linked component, is committed in this repository:

- [`apps/server/packaging/ffmpeg-build-info/macos-arm64-8.1.2-versions.txt`](apps/server/packaging/ffmpeg-build-info/macos-arm64-8.1.2-versions.txt)
- [`apps/server/packaging/ffmpeg-build-info/macos-x86_64-8.1.2-versions.txt`](apps/server/packaging/ffmpeg-build-info/macos-x86_64-8.1.2-versions.txt)

These are committed rather than linked on purpose: the offer below runs three
years, and it must not depend on a third-party server still serving those files
then.

Reproduce either from a bundled copy with:

```bash
/Applications/Cairndex.app/Contents/Resources/cairndex-sidecar/ffmpeg -buildconf
```

### Exact binaries redistributed

`apps/server/packaging/ffmpeg-manifest.json` is the authoritative pin. As of
FFmpeg 8.1.2:

| Platform | Tool | SHA-256 of the binary | In releases? |
| --- | --- | --- | --- |
| macOS arm64 | ffmpeg | `eaf91238e104dd0e262bc6510e25061855cc99a6955a721b0ac99660d58c473d` | yes |
| macOS arm64 | ffprobe | `ed9dc5871914b466b96b402c9ec0ba68ce4f836e72faa464b1b4e279835bd4a6` | yes |
| macOS x86_64 | ffmpeg | `1ca59dda73668c59898a0b305afd8a88817a989187f222ec62d64e775d614d23` | no — pinned only |
| macOS x86_64 | ffprobe | `bdb6aff0f1f414382effd97040f7862dc85e67996ac296cb4288beed0e06498f` | no — pinned only |

Releases have shipped Apple Silicon only since v0.1.0, so the x86_64 rows are a
pin rather than something distributed — they apply to an Intel app you build
yourself. The obligations below attach to whatever a given artifact actually
contains; they are stated for both because the pin makes either possible, and
the corresponding source is the same either way.

Upstream download URLs, archive checksums, and the component version list are
recorded in that manifest.

### Written offer for the corresponding source

The corresponding source for the FFmpeg version above is FFmpeg 8.1.2 as
published at <https://ffmpeg.org/releases/> (`ffmpeg-8.1.2.tar.xz`), configured
with the options listed above, against the component versions recorded in the
committed `versions.txt` files.

For three years from the date you received a Cairndex release artifact, the
Cairndex project will provide, on request and for no more than the cost of
physically performing source distribution, a complete machine-readable copy of
the corresponding source for the FFmpeg binaries in that artifact. Open an
issue at <https://github.com/allpan3/cairndex/issues> to request it.

Everything needed to answer that request — the exact FFmpeg version, each
architecture's configure line, and every component version — is in this
repository rather than only on the upstream build server, so the offer stays
fulfillable for its full term regardless of what that server does. The one
thing not mirrored here is the upstream FFmpeg source tarball itself, which is
distributed by the FFmpeg project; should <https://ffmpeg.org/releases/> ever
stop carrying 8.1.2, honouring the offer means supplying that tarball from an
archived copy.

---

## Bundled Python runtime and dependencies

The desktop app also bundles a frozen Python interpreter and Cairndex's Python
dependencies (PyInstaller one-dir; ADR-0019 §2), under
`Cairndex.app/Contents/Resources/cairndex-sidecar/`. The interpreter is under
the PSF License and the direct dependencies are permissive: FastAPI, SQLAlchemy,
Pydantic, pydantic-settings and python-ulid are MIT, uvicorn is BSD-3-Clause,
Pillow is MIT-CMU, and `pi-heif` is BSD-3-Clause (its bundled native libraries
are covered separately below). The authoritative set is
`apps/server/pyproject.toml` plus its lockfile.

## HEIF decoding (`pi-heif`) — bundled in the macOS desktop app

HEIC files are made viewable by `pi-heif`, whose wheel bundles two native
libraries. Both ship inside `Cairndex.app/Contents/Resources/cairndex-sidecar/`:

| Library | Version | License | Role |
| --- | --- | --- | --- |
| libheif | 1.23.0 | LGPL-3.0-or-later | HEIF container |
| libde265 | 0.2.0 | LGPL-3.0-or-later | HEVC decoder |

They are loaded as separate shared libraries and are not modified, which is the
ordinary LGPL §4 case. Their corresponding sources are published at
<https://github.com/strukturag/libheif> and
<https://github.com/strukturag/libde265> at the versions above, and the same
three-year written offer stated for FFmpeg applies to them.

**Why `pi-heif` and not `pillow-heif`** (same maintainer, same codebase): the
`pillow-heif` wheel additionally bundles **libx265**, an HEVC *encoder* under
**GPL-2.0-or-later**, and `libheif` names it in a load command rather than a
lazy `dlopen` — so importing it pulls GPL code into the sidecar process. That is
also why `pillow-heif` publishes a **GPLv2** classifier alongside its
`BSD-3-Clause` declaration, while `pi-heif` publishes **LGPLv3**; the
classifiers describe the wheels accurately.

Cairndex only ever decodes HEIC — `media/previews.py` calls
`register_heif_opener()` and nothing else — so that encoder was 8.6 MB of
copyleft obligation buying nothing. `pillow-heif` remains a **development**
dependency, because writing the smoke test's HEIC fixture needs an encoder; it
runs in the test process, the PyInstaller spec excludes the package, and
`build_sidecar.py` fails the build if `libx265` appears in a bundle at all.

This records constraints, not legal advice (ADR-0019 §3).
