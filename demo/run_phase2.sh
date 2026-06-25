#!/usr/bin/env bash
# Phase 2 demo: scan a generated library, probe it with ffprobe, thumbnail it.
# Prints real dimensions/duration/codecs and where thumbnails were cached.
# Requires ffmpeg/ffprobe on PATH (brew install ffmpeg).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/apps/server"
exec uv run python ../../demo/phase2_walkthrough.py
