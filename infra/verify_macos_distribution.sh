#!/usr/bin/env bash
# Verify that a macOS app or DMG carries every required distribution license
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "usage: $0 <Cairndex.app|Cairndex.dmg>" >&2
    exit 2
fi

ARTIFACT="$1"
MOUNT_DIR=""

# Detach only the temporary DMG mount created by this run
cleanup() {
    if [[ -n "$MOUNT_DIR" ]]; then
        hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
        rmdir "$MOUNT_DIR" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# Check the exact resource paths and identifying text inside one app bundle
verify_app() {
    local app="$1"
    local licenses="$app/Contents/Resources/licenses"
    local required=(
        "Cairndex-MIT.txt"
        "THIRD-PARTY-NOTICES.md"
        "GPL-3.0.txt"
        "LGPL-3.0.txt"
    )

    for filename in "${required[@]}"; do
        if [[ ! -s "$licenses/$filename" ]]; then
            echo "LICENSE FAIL: missing or empty $licenses/$filename" >&2
            return 1
        fi
    done

    grep -Fq "MIT License" "$licenses/Cairndex-MIT.txt"
    grep -Fq "GPL-3.0-or-later" "$licenses/THIRD-PARTY-NOTICES.md"
    grep -Fq "GNU GENERAL PUBLIC LICENSE" "$licenses/GPL-3.0.txt"
    grep -Fq "GNU LESSER GENERAL PUBLIC LICENSE" "$licenses/LGPL-3.0.txt"
    echo "LICENSE OK: $app contains MIT, third-party, GPLv3, and LGPLv3 notices"
}

case "$ARTIFACT" in
    *.app)
        verify_app "$ARTIFACT"
        ;;
    *.dmg)
        if ! command -v hdiutil >/dev/null 2>&1; then
            echo "LICENSE FAIL: hdiutil is required to inspect a DMG" >&2
            exit 1
        fi
        MOUNT_DIR=$(mktemp -d)
        hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$ARTIFACT" >/dev/null
        verify_app "$MOUNT_DIR/Cairndex.app"
        ;;
    *)
        echo "LICENSE FAIL: expected a .app bundle or .dmg: $ARTIFACT" >&2
        exit 2
        ;;
esac
