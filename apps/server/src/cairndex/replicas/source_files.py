"""Validate library-relative paths retained in source recovery records."""

from cairndex.core.paths import normalize_relative_path
from cairndex.file_ops.paths import validate_name
from cairndex.replicas.protocol import ReplicaError


def source_path(raw: str) -> str:
    """Reject hidden paths and noncanonical names before any filesystem access."""
    normalized = normalize_relative_path(raw)
    if not normalized or normalized != raw or len(raw.split("/")) > 64:
        raise ReplicaError("A canonical library-relative source path is required")
    for part in raw.split("/"):
        if validate_name(part) != part:
            raise ReplicaError("Source path contains an unsupported name")
    return normalized
