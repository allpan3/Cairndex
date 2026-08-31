"""Release identity shared by OpenAPI, health diagnostics, and packaging."""

from importlib.metadata import PackageNotFoundError, version


def _package_version() -> str:
    """Read the installed distribution version without duplicating metadata."""
    try:
        return version("cairndex-server")
    except PackageNotFoundError:
        return "0.0.0+unknown"


APP_VERSION = _package_version()
