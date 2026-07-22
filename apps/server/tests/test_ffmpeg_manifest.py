"""The ffmpeg pin is what stands between a swapped download and a published app.

``build_sidecar.py`` and ``fetch_ffmpeg.py`` only run during packaging, so
nothing else in the suite touches them; without these tests the checksum gate is
exercised for the first time by a release build. The cases below are the ways it
can fail *open* — a wrong-architecture digest that verifies, a pin missing the
digest for the file actually downloaded, an archive that writes outside the
vendor directory (ADR-0019 §3).
"""

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

PACKAGING_DIR = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING_DIR))

import ffmpeg_manifest as fm  # noqa: E402
from fetch_ffmpeg import extract_member  # noqa: E402


def _entry(**overrides: object) -> dict:
    entry = {
        "url": "https://example.test/ffmpeg.zip",
        "archive_member": "ffmpeg",
        "archive_sha256": "a" * 64,
        "sha256": "b" * 64,
    }
    entry.update(overrides)
    return entry


def _manifest(**platforms: object) -> dict:
    return {"platforms": platforms}


class TestShippedManifest:
    """The committed manifest, not a fixture — a bad pin here ships."""

    def test_release_targets_are_pinned(self) -> None:
        # Both macOS architectures, because a release ships both (plan 3 D7).
        for target in ("macos-arm64", "macos-x86_64"):
            pins = fm.pins_for(target)
            assert set(pins) == set(fm.MEDIA_TOOLS)
            for pin in pins.values():
                assert pin.url.startswith("https://")
                assert len(pin.sha256) == 64

    def test_architectures_pin_different_binaries(self) -> None:
        """The bug a flat digest map allowed: one arch's checksum verifying the other's."""
        arm = fm.pins_for("macos-arm64")
        intel = fm.pins_for("macos-x86_64")
        for tool in fm.MEDIA_TOOLS:
            assert arm[tool].sha256 != intel[tool].sha256

    def test_linux_is_unpinned_and_says_why(self) -> None:
        # Not an oversight: that builder's Linux artifacts are --enable-nonfree.
        with pytest.raises(fm.ManifestError, match="--skip-ffmpeg"):
            fm.pins_for("linux-x86_64")


class TestPinResolution:
    def test_unknown_platform_lists_the_known_ones(self) -> None:
        with pytest.raises(fm.ManifestError, match="macos-arm64"):
            fm.pins_for("solaris-sparc", _manifest(**{"macos-arm64": {}}))

    def test_partial_platform_names_the_missing_tool(self) -> None:
        manifest = _manifest(**{"macos-arm64": {"ffmpeg": _entry(), "ffprobe": None}})
        with pytest.raises(fm.ManifestError, match="ffprobe"):
            fm.pins_for("macos-arm64", manifest)

    def test_archive_member_without_archive_digest_is_refused(self) -> None:
        """The download is verified before it is unpacked, so this pin cannot be honoured."""
        manifest = _manifest(
            **{
                "macos-arm64": {
                    "ffmpeg": _entry(archive_sha256=None),
                    "ffprobe": _entry(),
                }
            }
        )
        with pytest.raises(fm.ManifestError, match="archive_sha256"):
            fm.pins_for("macos-arm64", manifest)

    def test_bare_binary_url_needs_no_archive_fields(self) -> None:
        manifest = _manifest(
            **{
                "macos-arm64": {
                    "ffmpeg": _entry(archive_member=None, archive_sha256=None),
                    "ffprobe": _entry(archive_member=None, archive_sha256=None),
                }
            }
        )
        pins = fm.pins_for("macos-arm64", manifest)
        assert pins["ffmpeg"].is_archive is False

    def test_missing_sha256_is_refused(self) -> None:
        manifest = _manifest(**{"macos-arm64": {"ffmpeg": _entry(sha256=""), "ffprobe": _entry()}})
        with pytest.raises(fm.ManifestError, match="sha256"):
            fm.pins_for("macos-arm64", manifest)


class TestPlatformNaming:
    """The manifest keys have to match what the fetch/build scripts compute."""

    @pytest.mark.parametrize(
        ("system", "machine", "expected"),
        [
            ("Darwin", "arm64", "macos-arm64"),
            ("Darwin", "x86_64", "macos-x86_64"),
            ("Linux", "aarch64", "linux-arm64"),
            ("Linux", "AMD64", "linux-x86_64"),
        ],
    )
    def test_platform_key(
        self, monkeypatch: pytest.MonkeyPatch, system: str, machine: str, expected: str
    ) -> None:
        monkeypatch.setattr(fm.platform, "system", lambda: system)
        monkeypatch.setattr(fm.platform, "machine", lambda: machine)
        assert fm.current_platform() == expected

    def test_current_platform_is_a_manifest_key(self) -> None:
        manifest = fm.load()
        assert fm.current_platform() in manifest["platforms"]


class TestArchiveExtraction:
    def _zip(self, path: Path, members: dict[str, bytes]) -> Path:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        path.write_bytes(buffer.getvalue())
        return path

    def test_extracts_the_named_member(self, tmp_path: Path) -> None:
        archive = self._zip(tmp_path / "a.zip", {"ffmpeg": b"binary-bytes"})
        out = tmp_path / "ffmpeg"
        extract_member(archive, "ffmpeg", out)
        assert out.read_bytes() == b"binary-bytes"

    def test_traversal_member_cannot_escape(self, tmp_path: Path) -> None:
        """Only the manifest's member name is extracted, to a path chosen by us.

        An archive carrying `../../evil` is inert because nothing extracts by the
        archive's own names — asking for the pinned member simply misses.
        """
        archive = self._zip(tmp_path / "a.zip", {"../../evil": b"pwned"})
        out = tmp_path / "ffmpeg"
        with pytest.raises(SystemExit, match="has no member"):
            extract_member(archive, "ffmpeg", out)
        assert not (tmp_path.parent.parent / "evil").exists()

    def test_missing_member_lists_what_is_there(self, tmp_path: Path) -> None:
        archive = self._zip(tmp_path / "a.zip", {"bin/ffmpeg": b"x"})
        with pytest.raises(SystemExit, match="bin/ffmpeg"):
            extract_member(archive, "ffmpeg", tmp_path / "ffmpeg")


class TestManifestFileShape:
    def test_is_valid_json_with_a_source_record(self) -> None:
        """The source block is what the GPL offer in the release notes refers to."""
        manifest = json.loads(fm.MANIFEST.read_text(encoding="utf-8"))
        source = manifest["source"]
        assert source["ffmpeg_version"]
        assert source["license"].startswith("GPL")
        assert source["homepage"].startswith("https://")
