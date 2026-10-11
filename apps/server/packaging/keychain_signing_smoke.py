"""Verify macOS Keychain access across changed builds using disposable credentials.

Creates no owner-library data, changes no trust settings and removes its temporary
Keychain. All reads disable user interaction, so a passing read cannot hide a prompt.
"""

import hashlib
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from secrets import token_hex

from macos_signing import SigningIdentity, _run, create_local_identity, sign_sidecar

_SOURCE = r"""
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    SecKeychainRef keychain = NULL;
    SecKeychainSetUserInteractionAllowed(false);
    OSStatus status = SecKeychainOpen(argv[2], &keychain);
    if (status) return 3;
    const char *service = "cairndex-signing-verification";
    const char *account = "synthetic-account";
    const char *value = "synthetic-not-a-real-password";
    if (!strcmp(argv[1], "create")) {
        status = SecKeychainAddGenericPassword(keychain, strlen(service), service,
            strlen(account), account, strlen(value), value, NULL);
    } else {
        UInt32 length = 0; void *data = NULL;
        status = SecKeychainFindGenericPassword(keychain, strlen(service), service,
            strlen(account), account, &length, &data, NULL);
        if (!status && (length != strlen(value) || memcmp(data, value, length))) status = -1;
        if (data) SecKeychainItemFreeContent(NULL, data);
    }
    CFRelease(keychain);
    printf("version=%d status=%d\n", VERSION, (int)status);
    return status ? 1 : 0;
}
"""


def _compile(source: Path, version: int) -> Path:
    binary = source.parent / f"reader-{version}"
    _run(
        [
            "/usr/bin/xcrun",
            "clang",
            "-Wno-deprecated-declarations",
            f"-DVERSION={version}",
            str(source),
            "-framework",
            "Security",
            "-framework",
            "CoreFoundation",
            "-o",
            str(binary),
        ]
    )
    return binary


def _denied(binary: Path, keychain: Path) -> None:
    result = subprocess.run([str(binary), "read", str(keychain)], capture_output=True, text=True)
    assert result.returncode == 1 and "status=-25293" in result.stdout, result.stdout


def verify(work: Path, keychain: Path) -> None:
    config = work / "build-signing.json"
    identity = create_local_identity(config, keychain=keychain)
    assert create_local_identity(config) == identity, "Repeated setup changed the identity"
    source = work / "reader.c"
    source.write_text(_SOURCE)
    first, second = _compile(source, 1), _compile(source, 2)
    sign_sidecar(first, identity)
    sign_sidecar(second, identity)
    assert (
        hashlib.sha256(first.read_bytes()).digest() != hashlib.sha256(second.read_bytes()).digest()
    )
    _run([str(first), "create", str(keychain)])
    _run([str(first), "read", str(keychain)])
    _run([str(second), "read", str(keychain)])
    print("PASS: changed builds retain access with user interaction disabled", flush=True)

    unrelated = _compile(source, 3)
    _run(
        [
            "/usr/bin/codesign",
            "--force",
            "--sign",
            identity.fingerprint,
            "--keychain",
            str(keychain),
            "--identifier",
            "dev.cairndex.unrelated-verification",
            "--timestamp=none",
            str(unrelated),
        ]
    )
    _denied(unrelated, keychain)
    other_identity = create_local_identity(work / "other-signing.json", keychain=keychain)
    other = _compile(source, 4)
    sign_sidecar(other, SigningIdentity(other_identity.fingerprint, keychain))
    _denied(other, keychain)
    ad_hoc = _compile(source, 5)
    _run(
        [
            "/usr/bin/codesign",
            "--force",
            "--sign",
            "-",
            "--identifier",
            "dev.cairndex.sidecar",
            str(ad_hoc),
        ]
    )
    _denied(ad_hoc, keychain)
    print("PASS: wrong identifiers, other certificates and ad-hoc copies are denied", flush=True)


def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("Keychain signing verification requires macOS")
    before = _run(["/usr/bin/security", "list-keychains", "-d", "user"])
    # Spaces also exercise security's interactive argument quoting.
    with tempfile.TemporaryDirectory(prefix="cairndex signing verification ") as directory:
        work = Path(directory)
        keychain = work / "disposable.keychain-db"
        try:
            _run(
                ["/usr/bin/security", "-i"],
                input_text=shlex.join(
                    [
                        "create-keychain",
                        "-p",
                        token_hex(32),
                        str(keychain),
                    ]
                )
                + "\n",
            )
            assert keychain.is_file(), "Temporary Keychain was not created"
            verify(work, keychain)
        finally:
            if keychain.exists():
                _run(["/usr/bin/security", "delete-keychain", str(keychain)])
    assert before == _run(["/usr/bin/security", "list-keychains", "-d", "user"])
    print("PASS: temporary Keychain removed; original search list retained", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
