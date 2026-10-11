"""Signing configuration must survive rebuilds and refuse silent identity changes."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGING_DIR = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING_DIR))

import macos_signing as signing  # noqa: E402

FINGERPRINT = "1" * 40


@pytest.fixture
def local_config(tmp_path, monkeypatch):
    monkeypatch.setattr(signing.sys, "platform", "darwin")
    keychain = tmp_path / "login.keychain-db"
    keychain.touch()
    config = tmp_path / "build-signing.json"
    monkeypatch.setattr(signing, "default_config", lambda: config)
    monkeypatch.setattr(
        signing, "_run", lambda *args, **kwargs: f'  1) {FINGERPRINT} "Local signing"\n'
    )
    return config, keychain


def write_config(config, location, **changes):
    data = {"version": 1, "certificate_sha1": FINGERPRINT, "keychain": str(location)}
    data.update(changes)
    config.write_text(json.dumps(data))


def test_no_opt_in_keeps_the_existing_build_model(local_config):
    assert signing.configured_identity(environ={}) is None


def test_local_signer_is_bound_to_the_exact_certificate_and_keychain(local_config):
    config, keychain = local_config
    write_config(config, keychain)
    identity = signing.configured_identity(environ={})
    assert identity == signing.SigningIdentity(FINGERPRINT, keychain)
    assert (
        identity.requirement
        == f'identifier "dev.cairndex.sidecar" and certificate leaf = H"{FINGERPRINT}"'
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"version": 2},
        {"certificate_sha1": "Local signing"},
        {"certificate_sha1": None},
        {"keychain": "relative.keychain"},
        {"unexpected": True},
    ],
)
def test_invalid_configuration_never_falls_back_to_ad_hoc(local_config, changes):
    config, keychain = local_config
    write_config(config, keychain, **changes)
    with pytest.raises(signing.SigningError, match="configuration is invalid"):
        signing.configured_identity(environ={})


def test_explicitly_missing_configuration_is_an_error(local_config):
    config, _ = local_config
    with pytest.raises(signing.SigningError, match="configuration is missing"):
        signing.configured_identity(environ={signing.CONFIG_ENV: str(config)})


def test_missing_signer_does_not_generate_a_replacement(local_config, monkeypatch):
    config, keychain = local_config
    write_config(config, keychain)
    monkeypatch.setattr(signing, "_run", lambda *args, **kwargs: "0 identities found")
    with pytest.raises(signing.SigningError, match="missing or ambiguous"):
        signing.configured_identity(environ={})


def test_ci_ignores_workstation_configuration_unless_explicit(local_config):
    config, keychain = local_config
    write_config(config, keychain)
    assert signing.configured_identity(environ={"CI": "true"}) is None
    assert (
        signing.configured_identity(environ={"CI": "true", signing.CONFIG_ENV: str(config)})
        is not None
    )


def test_release_identity_takes_precedence_over_local_configuration(local_config):
    config, keychain = local_config
    write_config(config, keychain, certificate_sha1="2" * 40)
    identity = signing.configured_identity(environ={"APPLE_SIGNING_IDENTITY": "Local signing"})
    assert identity == signing.SigningIdentity(FINGERPRINT, timestamp=True)
    assert signing.configured_identity(environ={"APPLE_SIGNING_IDENTITY": "-"}) is None


def test_non_macos_does_not_query_keychain_or_configuration(local_config, monkeypatch):
    monkeypatch.setattr(signing.sys, "platform", "linux")
    assert signing.configured_identity(environ={signing.CONFIG_ENV: "/not/a/config"}) is None


def test_ambiguous_identity_names_are_refused(local_config, monkeypatch):
    monkeypatch.setattr(
        signing,
        "_run",
        lambda *args, **kwargs: f'1) {FINGERPRINT} "Same name"\n2) {"2" * 40} "Same name"\n',
    )
    with pytest.raises(signing.SigningError, match="ambiguous"):
        signing.configured_identity(environ={"APPLE_SIGNING_IDENTITY": "Same name"})


def test_signing_changes_only_the_backend_and_checks_the_result(tmp_path, monkeypatch):
    binary = tmp_path / "cairndex-sidecar"
    binary.write_bytes(b"synthetic executable")
    keychain = tmp_path / "signing.keychain-db"
    identity = signing.SigningIdentity(FINGERPRINT, keychain)
    checks = iter([False, True])
    monkeypatch.setattr(signing, "signature_matches", lambda *args: next(checks))
    calls = []
    monkeypatch.setattr(signing, "_run", lambda arguments: calls.append(arguments))
    signing.sign_sidecar(binary, identity)
    assert len(calls) == 1
    command = calls[0]
    assert command[-1] == str(binary)
    assert command[command.index("--identifier") + 1] == "dev.cairndex.sidecar"
    assert command[command.index("--keychain") + 1] == str(keychain)
    assert "--timestamp=none" in command
    assert "--deep" not in command
    assert "--preserve-metadata=entitlements" in command


def test_failed_signature_verification_is_not_reported_as_success(tmp_path, monkeypatch):
    binary = tmp_path / "cairndex-sidecar"
    binary.touch()
    monkeypatch.setattr(signing, "signature_matches", lambda *args: False)
    monkeypatch.setattr(signing, "_run", lambda *args: "")
    with pytest.raises(signing.SigningError, match="does not satisfy"):
        signing.sign_sidecar(binary, signing.SigningIdentity(FINGERPRINT))


def test_signature_check_checks_signed_bytes_and_exact_identity(tmp_path, monkeypatch):
    binary = tmp_path / "cairndex-sidecar"
    binary.touch()
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(signing.subprocess, "run", run)
    identity = signing.SigningIdentity(FINGERPRINT)
    assert signing.signature_matches(binary, identity)
    assert calls == [
        ["/usr/bin/codesign", "--verify", "--strict", "-R", "=" + identity.requirement, str(binary)]
    ]


def test_signing_refuses_symlinks(tmp_path):
    target = tmp_path / "external"
    target.touch()
    binary = tmp_path / "cairndex-sidecar"
    binary.symlink_to(target)
    with pytest.raises(signing.SigningError, match="symbolic link"):
        signing.sign_sidecar(binary, signing.SigningIdentity(FINGERPRINT))


def test_repeating_setup_reuses_the_identity(local_config):
    config, keychain = local_config
    write_config(config, keychain)
    before = config.read_bytes()
    assert signing.create_local_identity(config) == signing.SigningIdentity(FINGERPRINT, keychain)
    assert config.read_bytes() == before


def test_security_failure_does_not_echo_sensitive_stdin(monkeypatch):
    monkeypatch.setattr(
        signing.subprocess,
        "run",
        lambda args, **kwargs: subprocess.CompletedProcess(args, 1, "", kwargs["input"]),
    )
    with pytest.raises(signing.SigningError) as failure:
        signing._run(["/usr/bin/security", "-i"], input_text="synthetic-wrapping-password")
    assert "synthetic-wrapping-password" not in str(failure.value)


def test_setup_keeps_private_material_out_of_config_and_arguments(local_config, monkeypatch):
    config, keychain = local_config
    calls = []

    def run(arguments, *, input_text=None):
        calls.append((arguments, input_text))
        if arguments[1] == "default-keychain":
            return json.dumps(str(keychain))
        if arguments[1] == "req":
            Path(arguments[arguments.index("-keyout") + 1]).write_text("synthetic private key")
        return ""

    monkeypatch.setattr(signing, "_run", run)
    monkeypatch.setattr(
        signing.subprocess,
        "run",
        lambda args, **kwargs: subprocess.CompletedProcess(args, 0, b"certificate"),
    )
    fingerprint = hashlib.sha1(b"certificate").hexdigest().upper()
    monkeypatch.setattr(signing, "_resolve_identity", lambda *args: fingerprint)
    identity = signing.create_local_identity(config)
    data = json.loads(config.read_text())
    assert data == {"version": 1, "certificate_sha1": fingerprint, "keychain": str(keychain)}
    assert identity.fingerprint == fingerprint
    assert config.stat().st_mode & 0o777 == 0o600
    import_input = next(text for args, text in calls if args == ["/usr/bin/security", "-i"])
    assert " -x " in import_input and " -T /usr/bin/codesign" in import_input
    assert " -A" not in import_input
    password = import_input.split(" -P ")[1].split()[0]
    assert password not in json.dumps([args for args, _ in calls])
    assert password not in config.read_text()
    assert all(
        not Path(args[args.index("-keyout") + 1]).exists() for args, _ in calls if "-keyout" in args
    )
