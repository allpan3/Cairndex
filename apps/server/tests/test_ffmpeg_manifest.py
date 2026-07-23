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

import build_sidecar as bs  # noqa: E402
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


class TestVendorScoping:
    """A release builds both architectures; their downloads share filenames."""

    def test_each_platform_gets_its_own_directory(self) -> None:
        arm = fm.vendor_dir("macos-arm64")
        intel = fm.vendor_dir("macos-x86_64")
        assert arm != intel
        assert arm.name == "macos-arm64"
        assert arm.parent == intel.parent

    def test_vendor_dirs_stay_under_packaging(self) -> None:
        assert fm.VENDOR.is_relative_to(fm.PACKAGING_DIR)
        assert fm.vendor_dir("macos-arm64").is_relative_to(fm.VENDOR)


class TestBundleArchitecture:
    """`--platform` selects a pin; it cannot change what PyInstaller froze."""

    def test_reads_arm64_and_x86_64_mach_o_headers(self, tmp_path: Path) -> None:
        cases = {"arm64": 0x0100000C, "x86_64": 0x01000007}
        for name, cputype in cases.items():
            binary = tmp_path / name
            binary.write_bytes(b"\xcf\xfa\xed\xfe" + cputype.to_bytes(4, "little") + b"\x00" * 24)
            assert bs.macho_arch(binary) == name

    def test_non_macho_is_not_guessed_at(self, tmp_path: Path) -> None:
        # A Linux ELF or a truncated file must report unknown, not a wrong arch.
        elf = tmp_path / "elf"
        elf.write_bytes(b"\x7fELF" + b"\x00" * 28)
        assert bs.macho_arch(elf) is None
        short = tmp_path / "short"
        short.write_bytes(b"\xcf\xfa")
        assert bs.macho_arch(short) is None

    def test_unknown_cpu_type_is_unknown(self, tmp_path: Path) -> None:
        binary = tmp_path / "ppc"
        binary.write_bytes(b"\xcf\xfa\xed\xfe" + (0x12345678).to_bytes(4, "little") + b"\x00" * 24)
        assert bs.macho_arch(binary) is None


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


class TestMalformedManifest:
    """Field types are checked, not assumed — this module decides what ships."""

    @pytest.mark.parametrize("bad", [123, ["a" * 64], {}, ""])
    def test_a_digest_that_is_not_a_string_is_refused(self, bad: object) -> None:
        # Never a silent comparison against something that can never match.
        manifest = _manifest(**{"macos-arm64": {"ffmpeg": _entry(sha256=bad), "ffprobe": _entry()}})
        with pytest.raises(fm.ManifestError, match="sha256"):
            fm.pins_for("macos-arm64", manifest)

    def test_a_non_object_platform_entry_is_refused(self) -> None:
        with pytest.raises(fm.ManifestError, match="must be a JSON object"):
            fm.pins_for("macos-arm64", _manifest(**{"macos-arm64": "ffmpeg.zip"}))

    def test_a_non_object_tool_entry_is_refused(self) -> None:
        manifest = _manifest(**{"macos-arm64": {"ffmpeg": "https://x.test/f", "ffprobe": _entry()}})
        with pytest.raises(fm.ManifestError, match="must be a JSON object"):
            fm.pins_for("macos-arm64", manifest)

    def test_invalid_json_names_the_file(self, tmp_path: Path) -> None:
        broken = tmp_path / "ffmpeg-manifest.json"
        broken.write_text("{not json", encoding="utf-8")
        with pytest.raises(fm.ManifestError, match="not valid JSON"):
            fm.load(broken)


class TestManifestFileShape:
    def test_is_valid_json_with_a_source_record(self) -> None:
        """The source block is what the GPL offer in the release notes refers to."""
        manifest = json.loads(fm.MANIFEST.read_text(encoding="utf-8"))
        source = manifest["source"]
        assert source["ffmpeg_version"]
        assert source["license"].startswith("GPL")
        assert source["homepage"].startswith("https://")

    def test_component_manifests_are_committed_not_just_linked(self) -> None:
        """The GPL offer runs three years; it cannot depend on a third-party host.

        Both architectures, because their configure lines differ.
        """
        manifest = json.loads(fm.MANIFEST.read_text(encoding="utf-8"))
        components = manifest["source"]["components"]
        assert set(components) == {"macos-arm64", "macos-x86_64"}
        for target, relative in components.items():
            path = fm.PACKAGING_DIR / relative
            assert path.is_file(), f"{target} component list is missing at {relative}"
            text = path.read_text(encoding="utf-8")
            assert "--enable-libx264" in text
            assert "x264" in text
