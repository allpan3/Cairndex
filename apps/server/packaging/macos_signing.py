"""Keep the credential-reading sidecar's macOS signing identity across builds.

Local configuration contains only a certificate fingerprint and a Keychain path.
Private keys stay in Keychain; builds never create or replace an identity.
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

IDENTIFIER = "dev.cairndex.sidecar"
CONFIG_ENV = "CAIRNDEX_SIDECAR_SIGNING_CONFIG"
_FINGERPRINT = re.compile(r"[0-9A-Fa-f]{40}\Z")


class SigningError(RuntimeError):
    """Configured signing is unavailable; never fall back to another identity."""


@dataclass(frozen=True)
class SigningIdentity:
    fingerprint: str
    keychain: Path | None = None
    timestamp: bool = False

    @property
    def requirement(self) -> str:
        return f'identifier "{IDENTIFIER}" and certificate leaf = H"{self.fingerprint}"'


def default_config() -> Path:
    """Keep private build configuration outside source and application state."""
    return Path.home() / "Library/Application Support/Cairndex/build-signing.json"


def _run(arguments: Sequence[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        arguments, input=input_text, capture_output=True, text=True, check=False
    )
    if result.returncode:
        # Security's interactive mode can echo input containing a temporary password.
        raise SigningError(f"{Path(arguments[0]).name} failed during sidecar signing")
    return result.stdout


def _resolve_identity(selector: str, keychain: Path | None = None) -> str:
    command = ["/usr/bin/security", "find-identity", "-p", "codesigning"]
    if keychain is not None:
        command.append(str(keychain))
    # Self-signed certificates need no system trust for Keychain DR matching.
    # `-v` would incorrectly exclude these otherwise usable local identities.
    output = _run(command)
    identities = set(re.findall(r'\b([0-9A-Fa-f]{40}) "([^"\n]+)"', output))
    matches: set[str] = {
        fingerprint.upper()
        for fingerprint, name in identities
        if selector.upper() == fingerprint.upper() or selector == name
    }
    if len(matches) != 1:
        raise SigningError(
            "The configured signing identity is missing or ambiguous; restore it before building"
        )
    return matches.pop()


def configured_identity(
    *, environ: Mapping[str, str] | None = None, config: Path | None = None
) -> SigningIdentity | None:
    """Use an explicit release identity, then an opted-in local build identity."""
    if sys.platform != "darwin":
        return None
    env = os.environ if environ is None else environ
    explicit = env.get("APPLE_SIGNING_IDENTITY")
    if explicit is not None:
        if not explicit.strip():
            raise SigningError("APPLE_SIGNING_IDENTITY must not be empty")
        if explicit == "-":
            return None
        return SigningIdentity(_resolve_identity(explicit), timestamp=True)
    selected = config or (Path(env[CONFIG_ENV]).expanduser() if env.get(CONFIG_ENV) else None)
    if selected is None and env.get("CI", "").lower() not in ("", "0", "false"):
        return None
    path = selected or default_config()
    if not path.exists():
        if selected is not None:
            raise SigningError("The requested sidecar signing configuration is missing")
        return None
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or set(data) != {"version", "certificate_sha1", "keychain"}:
            raise ValueError
        fingerprint, keychain = data["certificate_sha1"], data["keychain"]
        if (
            type(data["version"]) is not int
            or data["version"] != 1
            or not isinstance(fingerprint, str)
            or not _FINGERPRINT.fullmatch(fingerprint)
        ):
            raise ValueError
        if (
            not isinstance(keychain, str)
            or not Path(keychain).is_absolute()
            or not Path(keychain).is_file()
        ):
            raise ValueError
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SigningError(
            "The sidecar signing configuration is invalid; restore it before building"
        ) from error
    return SigningIdentity(_resolve_identity(fingerprint, Path(keychain)), Path(keychain))


def signature_matches(binary: Path, identity: SigningIdentity) -> bool:
    """Check the signed bytes, stable identifier and exact certificate together."""
    if not binary.is_file() or binary.is_symlink():
        return False
    result = subprocess.run(
        [
            "/usr/bin/codesign",
            "--verify",
            "--strict",
            "-R",
            "=" + identity.requirement,
            str(binary),
        ],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def sign_sidecar(binary: Path, identity: SigningIdentity | None) -> None:
    """Sign only the backend executable; preserve ffmpeg and nested library signatures."""
    if identity is None:
        return
    if not binary.is_file() or binary.is_symlink():
        raise SigningError("The sidecar executable is missing or is a symbolic link")
    if signature_matches(binary, identity):
        return
    arguments = [
        "/usr/bin/codesign",
        "--force",
        "--sign",
        identity.fingerprint,
        "--identifier",
        IDENTIFIER,
        "--preserve-metadata=entitlements",
        "--timestamp" if identity.timestamp else "--timestamp=none",
    ]
    # Do not preserve the linker's ad-hoc flag when attaching a certificate.
    # Explicit Apple signing also signs PyInstaller's libraries with this runtime.
    if identity.timestamp:
        arguments.append("--options=runtime")
    if identity.keychain is not None:
        arguments.extend(["--keychain", str(identity.keychain)])
    _run([*arguments, str(binary)])
    if not signature_matches(binary, identity):
        raise SigningError("The sidecar does not satisfy its configured signing identity")


def create_local_identity(config: Path, *, keychain: Path | None = None) -> SigningIdentity:
    """Explicitly enroll a local signer without changing trust or existing item ACLs."""
    if sys.platform != "darwin":
        raise SigningError("Local sidecar signing requires macOS")
    if config.exists():
        identity = configured_identity(environ={}, config=config)
        assert identity is not None
        return identity
    if keychain is None:
        keychains = shlex.split(_run(["/usr/bin/security", "default-keychain", "-d", "user"]))
        if len(keychains) != 1:
            raise SigningError("An unlocked user Keychain is required to create the local signer")
        keychain = Path(keychains[0])
    if not keychain.is_absolute() or not keychain.is_file():
        raise SigningError("An unlocked user Keychain is required to create the local signer")
    config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="cairndex-signing-") as directory:
        work = Path(directory)
        options = work / "certificate.cnf"
        options.write_text(
            "[req]\nprompt=no\ndistinguished_name=name\nx509_extensions=extensions\n"
            "[name]\nCN=Cairndex Local Sidecar Signing\n[extensions]\n"
            "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
            "extendedKeyUsage=critical,codeSigning\n"
        )
        key, certificate, archive = (
            work / "key.pem",
            work / "certificate.pem",
            work / "identity.p12",
        )
        _run(
            [
                "/usr/bin/openssl",
                "req",
                "-new",
                "-x509",
                "-newkey",
                "rsa:3072",
                "-nodes",
                "-days",
                "3650",
                "-config",
                str(options),
                "-keyout",
                str(key),
                "-out",
                str(certificate),
            ]
        )
        key.chmod(0o600)
        der = subprocess.run(
            ["/usr/bin/openssl", "x509", "-in", str(certificate), "-outform", "DER"],
            capture_output=True,
            check=True,
        ).stdout
        fingerprint = hashlib.sha1(der).hexdigest().upper()
        password = secrets.token_hex(32)
        _run(
            [
                "/usr/bin/openssl",
                "pkcs12",
                "-export",
                "-in",
                str(certificate),
                "-inkey",
                str(key),
                "-out",
                str(archive),
                "-passout",
                "stdin",
            ],
            input_text=password + "\n",
        )
        # This grants only codesign access to the newly created, non-exportable key.
        # The wrapping password goes over stdin, never argv or build output.
        _run(
            ["/usr/bin/security", "-i"],
            input_text=shlex.join(
                [
                    "import",
                    str(archive),
                    "-k",
                    str(keychain),
                    "-x",
                    "-P",
                    password,
                    "-T",
                    "/usr/bin/codesign",
                ]
            )
            + "\n",
        )
        _resolve_identity(fingerprint, keychain)
    payload = {"version": 1, "certificate_sha1": fingerprint, "keychain": str(keychain)}
    # Exclusive creation prevents a second setup process from replacing a signer.
    try:
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(json.dumps(payload, indent=2) + "\n")
    except OSError:
        # A setup race must not leave an unused private key behind. This exact
        # fingerprint belongs only to the certificate created by this attempt.
        _run(["/usr/bin/security", "delete-identity", "-Z", fingerprint, str(keychain)])
        raise
    return SigningIdentity(fingerprint, keychain)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser(
        "create-local", help="create or reuse a private local signing identity"
    )
    setup.add_argument("--config", type=Path, default=default_config())
    for command in ("check", "sign"):
        commands.add_parser(command).add_argument("binary", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "create-local":
            create_local_identity(args.config)
            print("Local sidecar signing is configured; the private key remains in Keychain.")
        else:
            identity = configured_identity()
            if args.command == "check":
                return 0 if identity is None or signature_matches(args.binary, identity) else 1
            sign_sidecar(args.binary, identity)
        return 0
    except (SigningError, OSError, subprocess.CalledProcessError) as error:
        print(f"Sidecar signing failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
