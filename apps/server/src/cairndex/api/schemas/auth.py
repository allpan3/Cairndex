from pydantic import BaseModel, ConfigDict, Field


class AuthStatus(BaseModel):
    """Lock state of a library for the current session (ADR-0010)."""

    access_settings_version: int = 0
    private_recovery_version: int = 0
    protected: bool  # library has an owner passphrase configured
    unlocked: bool  # this session has a valid unlock for it (always True if unprotected)


class UnlockRequest(BaseModel):
    passphrase: str = Field(min_length=1)


class AccessSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_passphrase: str | None = Field(default=None, max_length=1024)
    passphrase: str | None = Field(max_length=1024, min_length=1)
