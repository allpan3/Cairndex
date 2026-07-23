"""Reading ``ffmpeg-manifest.json`` (ADR-0019 §3).

Shared by ``fetch_ffmpeg.py`` and ``build_sidecar.py`` so the checksum gate is
defined once. It is the only thing standing between a swapped download and a
published binary, so two scripts disagreeing about how to read a pin would be a
security hole rather than an inconsistency.

Pins are per-platform because a release ships both Apple Silicon and Intel
artifacts; a single flat digest map would let one architecture's checksum
"verify" the other architecture's binary.
"""

import hashlib
import json
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Parsed JSON: the values stay `Any` because the file is arbitrary JSON, and the
# readers below narrow each field they use rather than trusting the shape.
JsonObject = dict[str, Any]

PACKAGING_DIR = Path(__file__).resolve().parent
MANIFEST = PACKAGING_DIR / "ffmpeg-manifest.json"

MEDIA_TOOLS = ("ffmpeg", "ffprobe")

_ARCH_ALIASES = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x86_64", "amd64": "x86_64"}


class ManifestError(RuntimeError):
    """A manifest that cannot be used as written."""


@dataclass(frozen=True)
class Pin:
    """One pinned tool for one platform."""

    tool: str
    url: str
    sha256: str
    archive_member: str | None
    archive_sha256: str | None

    @property
    def is_archive(self) -> bool:
        return self.archive_member is not None


def current_platform() -> str:
    system = platform.system().lower()
    arch = _ARCH_ALIASES.get(platform.machine().lower(), platform.machine().lower())
    if system == "darwin":
        return f"macos-{arch}"
    return f"{system}-{arch}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load(manifest_path: Path = MANIFEST) -> JsonObject:
    if not manifest_path.is_file():
        raise ManifestError(f"no manifest at {manifest_path}")
    try:
        parsed: object = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ManifestError(f"{manifest_path.name} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ManifestError(f"{manifest_path.name} must contain a JSON object")
    return parsed


def _object(value: object, what: str) -> JsonObject:
    if not isinstance(value, dict):
        raise ManifestError(f"{what} must be a JSON object, got {type(value).__name__}")
    return value


def _text(entry: JsonObject, key: str, what: str, *, required: bool) -> str | None:
    """Read a string field, refusing anything that is present but unusable.

    Types are checked rather than assumed because this module decides whether a
    binary may be published: a digest that arrived as a number, or a url that
    arrived as a list, must be a loud error and not a silent comparison against
    something that can never match.
    """
    value = entry.get(key)
    if value is None:
        if required:
            raise ManifestError(f"{what} pin is missing `{key}`")
        return None
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{what} pin has an unusable `{key}`: {value!r}")
    return value


def _pin(tool: str, entry: JsonObject) -> Pin:
    url = _text(entry, "url", tool, required=True)
    digest = _text(entry, "sha256", tool, required=True)
    assert url is not None and digest is not None  # required=True guarantees both
    member = _text(entry, "archive_member", tool, required=False)
    archive_digest = _text(entry, "archive_sha256", tool, required=False)
    # An archive is verified before it is unpacked, so a pin that names a member
    # without a digest for the thing being unpacked is refused rather than
    # quietly downgraded to trusting the extracted file alone.
    if member and not archive_digest:
        raise ManifestError(f"{tool} pins `archive_member` but no `archive_sha256`")
    return Pin(
        tool=tool,
        url=url,
        sha256=digest,
        archive_member=member,
        archive_sha256=archive_digest,
    )


def pins_for(target: str, manifest: JsonObject | None = None) -> dict[str, Pin]:
    """Return ``{tool: Pin}`` for ``target``.

    Raises ``ManifestError`` when the platform is unknown or unpinned. Callers
    that can proceed without bundled binaries — a Linux build, say, where the
    sidecar falls back to a system ffmpeg — catch it rather than pre-checking,
    so the reason lands in one place.
    """
    manifest = load() if manifest is None else manifest
    platforms = _object(manifest.get("platforms", {}), "`platforms`")
    if target not in platforms:
        known = ", ".join(sorted(platforms)) or "none"
        raise ManifestError(f"{target} is not listed in the manifest (known: {known})")

    entries = _object(platforms[target] or {}, f"`platforms.{target}`")
    missing = [tool for tool in MEDIA_TOOLS if not entries.get(tool)]
    if missing:
        raise ManifestError(
            f"{target} has no pinned build for {', '.join(missing)}.\n"
            "Populate the manifest with a url and both digests per tool, or build with\n"
            "--skip-ffmpeg — the sidecar then relies on a system ffmpeg, which works on a\n"
            "developer machine but not on a user's (ADR-0019 §3)."
        )
    return {tool: _pin(tool, _object(entries[tool], f"`{target}.{tool}`")) for tool in MEDIA_TOOLS}
