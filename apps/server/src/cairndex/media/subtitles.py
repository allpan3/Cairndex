"""Pure subtitle helpers: extension/format recognition and filename parsing.

No I/O and no DB — these back both the scanner (recognizing external subtitle
files) and the auto-link heuristic (ADR-0003 §3). Kept dependency-free so they
are trivially unit-testable.
"""

from __future__ import annotations

import posixpath
from dataclasses import dataclass

# External subtitle containers we recognize as AssetFiles.
SUBTITLE_EXTENSIONS: frozenset[str] = frozenset({"srt", "vtt", "ass", "ssa", "sub", "sbv"})

# Subtitle extension → logical format token stored on the track.
_FORMAT_BY_EXT: dict[str, str] = {
    "srt": "srt",
    "vtt": "vtt",
    "ass": "ass",
    "ssa": "ass",
    "sub": "subviewer",
    "sbv": "sbv",
}

# Common ISO 639-1/639-2 codes (and a few English language names) used as
# trailing filename tokens. Curated so we don't misread tokens like "part1" or
# "cd2" as a language. Lowercase.
_LANGUAGE_TOKENS: frozenset[str] = frozenset(
    {
        "en",
        "eng",
        "english",
        "es",
        "spa",
        "spanish",
        "fr",
        "fre",
        "fra",
        "french",
        "de",
        "ger",
        "deu",
        "german",
        "it",
        "ita",
        "italian",
        "pt",
        "por",
        "portuguese",
        "ru",
        "rus",
        "russian",
        "ja",
        "jpn",
        "japanese",
        "ko",
        "kor",
        "korean",
        "zh",
        "chi",
        "zho",
        "chinese",
        "ar",
        "ara",
        "arabic",
        "nl",
        "dut",
        "nld",
        "dutch",
        "sv",
        "swe",
        "swedish",
        "no",
        "nor",
        "norwegian",
        "da",
        "dan",
        "danish",
        "fi",
        "fin",
        "finnish",
        "pl",
        "pol",
        "polish",
        "tr",
        "tur",
        "turkish",
        "hi",
        "hin",
        "hindi",
        "cs",
        "cze",
        "ces",
        "czech",
        "el",
        "gre",
        "ell",
        "greek",
        "he",
        "heb",
        "hebrew",
        "th",
        "tha",
        "thai",
        "uk",
        "ukr",
        "ukrainian",
        "vi",
        "vie",
        "vietnamese",
        "id",
        "ind",
        "indonesian",
    }
)

# Flag tokens that modify a track but are not languages.
_FLAG_TOKENS: frozenset[str] = frozenset({"forced", "sdh", "cc", "hi"})
# Note: "hi" is both Hindi and "hearing-impaired". We treat it as a language
# token (the common case); explicit SDH uses "sdh"/"cc".
_FORCED_TOKENS: frozenset[str] = frozenset({"forced"})


def extension_of(relative_path: str) -> str:
    """Lowercased extension without the dot (``a/b.EN.SRT`` → ``srt``)."""
    return posixpath.splitext(relative_path)[1].lstrip(".").lower()


def is_subtitle_path(relative_path: str) -> bool:
    return extension_of(relative_path) in SUBTITLE_EXTENSIONS


def format_for_path(relative_path: str) -> str | None:
    return _FORMAT_BY_EXT.get(extension_of(relative_path))


@dataclass(frozen=True)
class ParsedSubtitleName:
    """The video this subtitle targets, plus language/forced parsed from the name."""

    video_stem: str  # basename of the target video, sans extension
    language: str | None
    is_forced: bool


def parse_subtitle_name(filename: str) -> ParsedSubtitleName:
    """Split a subtitle basename into (video stem, language, forced).

    Peels trailing dot-delimited language/flag tokens:
    ``movie.en.forced.srt`` → stem ``movie``, language ``en``, forced ``True``.
    Tokens that are neither a known language nor a flag stop the peeling, so
    ``the.matrix.srt`` keeps the full stem ``the.matrix``.
    """
    stem = posixpath.splitext(posixpath.basename(filename))[0]
    parts = stem.split(".")
    language: str | None = None
    forced = False

    # Peel from the right while tokens are flags or a single language code.
    while len(parts) > 1:
        token = parts[-1].lower()
        if token in _FLAG_TOKENS:
            if token in _FORCED_TOKENS:
                forced = True
            parts.pop()
            continue
        if token in _LANGUAGE_TOKENS and language is None:
            language = token
            parts.pop()
            continue
        break

    return ParsedSubtitleName(video_stem=".".join(parts), language=language, is_forced=forced)
