"""Validate retained source-operation intent without submitting filesystem work."""

from typing import Literal

from pydantic import Field

from cairndex.replicas.protocol import StrictModel, Token


class SourceRequest(StrictModel):
    operation: Token
    action: Literal["copy", "rename", "move", "trash", "undo", "restore"]
    source: str = Field(default="", max_length=4096)
    destination: str = Field(default="", max_length=4096)
    collision: Literal["fail", "skip", "suffix", "replace"] = "fail"
    prior: Token | None = None
    upload: Token | None = None
    version: Literal["source", "destination", "output"] = "source"
    byte_limit: int = Field(default=128 * 1024**3, ge=1, le=1024**4)
