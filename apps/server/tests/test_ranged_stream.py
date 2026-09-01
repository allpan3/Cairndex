"""Range-aware media streaming with playback-sized chunks and byte patches.

The tests lock down the Range arithmetic, bounded chunk size, response headers,
and absolute patch offsets used by direct video playback.
"""

from __future__ import annotations

from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route
from starlette.testclient import TestClient

from cairndex.media import ranged_stream
from cairndex.media.ranged_stream import ranged_file_response

BODY = bytes(range(256)) * 8  # 2048 deterministic bytes


# Exercise the custom byte-patched response without changing fixture content
def _identity(chunk: bytes, _offset: int) -> bytes:
    return chunk


def _client(  # type: ignore[no-untyped-def]
    path: Path, patch=_identity, filename=None
) -> TestClient:
    def endpoint(request: Request) -> Response:
        return ranged_file_response(
            path,
            media_type="video/mp4",
            range_header=request.headers.get("range"),
            patch=patch,
            filename=filename,
        )

    return TestClient(Starlette(routes=[Route("/f", endpoint)]))


def _fixture(tmp_path: Path) -> Path:
    path = tmp_path / "clip.mp4"
    path.write_bytes(BODY)
    return path


def test_no_range_serves_the_whole_body(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path)).get("/f")

    assert response.status_code == 200
    assert response.content == BODY
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == str(len(BODY))
    assert "content-range" not in response.headers


def test_filename_preserves_file_response_content_disposition(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path), filename="clip sample.mp4").get("/f")

    assert response.headers["content-disposition"] == (
        "attachment; filename*=utf-8''clip%20sample.mp4"
    )


def test_a_range_serves_exactly_that_span(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "bytes=100-199"})

    assert response.status_code == 206
    assert response.content == BODY[100:200]
    assert response.headers["content-range"] == f"bytes 100-199/{len(BODY)}"
    assert response.headers["content-length"] == "100"


def test_an_open_ended_range_runs_to_the_end(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "bytes=2000-"})

    assert response.status_code == 206
    assert response.content == BODY[2000:]
    assert response.headers["content-range"] == f"bytes 2000-2047/{len(BODY)}"


def test_a_suffix_range_serves_the_last_bytes(tmp_path: Path) -> None:
    # How a player reads an MP4 whose `moov` sits at the end of the file.
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "bytes=-64"})

    assert response.status_code == 206
    assert response.content == BODY[-64:]


def test_a_range_past_the_end_is_unsatisfiable(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "bytes=99999-"})

    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{len(BODY)}"


def test_an_end_past_the_size_is_clamped_rather_than_refused(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "bytes=2040-99999"})

    assert response.status_code == 206
    assert response.content == BODY[2040:]


def test_a_multi_range_request_gets_the_whole_body(tmp_path: Path) -> None:
    # Legal, and honest: multipart ranges are untested here, so they are not
    # claimed. No media element asks for them.
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "bytes=0-99,200-299"})

    assert response.status_code == 200
    assert response.content == BODY


def test_a_malformed_range_gets_the_whole_body(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path)).get("/f", headers={"Range": "furlongs=0-99"})

    assert response.status_code == 200
    assert response.content == BODY


def test_large_media_streams_in_one_mib_chunks(tmp_path: Path) -> None:
    path = tmp_path / "large.mp4"
    path.write_bytes(b"x" * (2 * 1024 * 1024 + 17))

    response = ranged_file_response(path, media_type="video/mp4")
    chunks = list(ranged_stream._stream(path, 0, path.stat().st_size - 1, _mark_offsets()))

    assert response.chunk_size == 1024 * 1024  # type: ignore[attr-defined]
    assert [len(chunk) for chunk in chunks] == [1024 * 1024, 1024 * 1024, 17]


# --- the patch ---------------------------------------------------------------
def _mark_offsets(*offsets: int):  # type: ignore[no-untyped-def]
    """A patch that writes 0xFF at the given absolute file offsets."""

    def patch(chunk: bytes, start: int) -> bytes:
        out = bytearray(chunk)
        for offset in offsets:
            if start <= offset < start + len(chunk):
                out[offset - start] = 0xFF
        return bytes(out)

    return patch


def test_the_patch_applies_at_absolute_offsets(tmp_path: Path) -> None:
    expected = bytearray(BODY)
    expected[7] = 0xFF
    expected[1500] = 0xFF

    response = _client(_fixture(tmp_path), _mark_offsets(7, 1500)).get("/f")

    assert response.content == bytes(expected)


def test_the_patch_lands_inside_a_range_that_contains_it(tmp_path: Path) -> None:
    # The offset is absolute in the file, not relative to the range — getting
    # that wrong would corrupt every seek.
    response = _client(_fixture(tmp_path), _mark_offsets(1500)).get(
        "/f", headers={"Range": "bytes=1400-1599"}
    )

    expected = bytearray(BODY[1400:1600])
    expected[100] = 0xFF
    assert response.status_code == 206
    assert response.content == bytes(expected)


def test_a_range_that_misses_the_patch_is_untouched(tmp_path: Path) -> None:
    response = _client(_fixture(tmp_path), _mark_offsets(1500)).get(
        "/f", headers={"Range": "bytes=0-99"}
    )

    assert response.content == BODY[0:100]


def test_the_patch_survives_a_chunk_boundary(tmp_path: Path) -> None:
    """A patch straddling the read size must still land — the file is chunked."""
    big = tmp_path / "big.mp4"
    payload = bytes(range(256)) * (12 * 1024)  # 3 MiB, several chunks
    big.write_bytes(payload)
    # Either side of the 1 MiB chunk boundary
    offsets = (1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1)

    response = _client(big, _mark_offsets(*offsets)).get("/f")

    expected = bytearray(payload)
    for offset in offsets:
        expected[offset] = 0xFF
    assert response.content == bytes(expected)
