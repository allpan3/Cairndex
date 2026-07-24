"""Write-mode gate schemas (ADR-0013 §1)."""

from pydantic import BaseModel, Field


class WriteModeRead(BaseModel):
    """The write-mode state of one library, and why it is what it is."""

    # The library's stored opt-in flag.
    enabled: bool
    # The deployment master switch (``CAIRNDEX_WRITE_MODE``). False forces every
    # library read-only regardless of ``enabled``.
    allowed_by_deployment: bool
    # Whether write operations are permitted right now — both gates agreeing.
    effective: bool
    # Whether enabling will ask for the library's passphrase (ADR-0010).
    requires_passphrase: bool


class WriteModeUpdate(BaseModel):
    """Turn write mode on or off for one library."""

    enabled: bool
    # Required to *enable* a passphrase-protected library; ignored otherwise.
    # Never logged, never stored, and never echoed back.
    passphrase: str | None = Field(default=None, min_length=1)
