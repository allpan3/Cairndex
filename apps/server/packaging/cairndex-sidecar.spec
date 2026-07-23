# PyInstaller spec for the desktop local-server sidecar (ADR-0019 §2).
#
# One-dir, not one-file: one-file re-extracts its whole payload to a temp
# directory on every launch, and this process is spawned on demand when a user
# opens a library folder. One-dir starts immediately and can be inspected when
# something goes wrong.
#
# Build with `python packaging/build_sidecar.py`, which passes the paths below.
#
# The hidden imports exist because PyInstaller finds imports by reading source,
# so anything resolved at runtime is invisible to it. Each entry below is a real
# runtime resolution, not defensive padding — see the comments.

# `hiddenimports` is deliberately empty, and that was established by testing
# rather than assumed either way.
#
# The first draft of this spec listed uvicorn's submodules, SQLAlchemy's sqlite
# dialect, Pillow's plugins, and the whole `cairndex` package, with comments
# claiming each was a runtime resolution PyInstaller could not see. Removing
# each group in turn and re-running `smoke_test.py` showed every one of them was
# redundant: PyInstaller 6.x ships `hook-PIL.py` and `hook-sqlalchemy.py`,
# uvicorn's "auto" modules resolve through literal imports inside try blocks
# that static analysis does follow, and `cairndex` is imported normally.
#
# Listing them anyway would not be free. Unnecessary hidden imports mask the
# thing that actually protects this bundle — a smoke test that runs it — by
# making a future genuine gap look already handled.
#
# `pi_heif` was the one real candidate, since `media/previews.py` imports it
# inside a function. It also proved unnecessary, and the smoke test now renders
# a HEIC preview to keep that honest: excluding `pi_heif` fails the test.
#
# `pillow_heif` is in `excludes` below and must stay there. It is installed as a
# development dependency (the smoke test needs an encoder to write its HEIC
# fixture), and its wheel bundles libx265 — GPL-2.0-or-later — which libheif
# names in a load command. Letting it into a bundle would put a copyleft
# encoder, which nothing in Cairndex calls, into a published binary. The
# exclude is what makes "dev-only" a fact rather than an intention.
#
# If a new dependency ever does need an entry here, the smoke test is what will
# say so. Add the entry with the failure it fixes named in a comment.

analysis = Analysis(
    ["sidecar_entry.py"],
    pathex=["../src"],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    # Trimming what a media server will never use. alembic is a development
    # migration tool (the registry and library DBs bootstrap with create_all),
    # and the rest are test/tooling imports pulled in transitively.
    excludes=["tkinter", "pytest", "mypy", "ruff", "alembic", "IPython", "pillow_heif"],
    noarchive=False,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="cairndex-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX-compressed binaries trip macOS code signing and Gatekeeper
    console=True,  # stdout is the port-announcement channel to the shell
)

COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="cairndex-sidecar",
)
