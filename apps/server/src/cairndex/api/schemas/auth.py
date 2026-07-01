from pydantic import BaseModel, Field


class AuthStatus(BaseModel):
    """Lock state of a library for the current session (ADR-0010)."""

    protected: bool  # library has an owner passphrase configured
    unlocked: bool  # this session has a valid unlock for it (always True if unprotected)


class UnlockRequest(BaseModel):
    passphrase: str = Field(min_length=1)
