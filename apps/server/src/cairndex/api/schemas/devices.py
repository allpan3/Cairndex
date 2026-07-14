from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from cairndex.auth.device_tokens import PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH


class PairStartRequest(BaseModel):
    device_name: str = Field(min_length=1, max_length=255)

    @field_validator("device_name")
    @classmethod
    def normalize_device_name(cls, value: str) -> str:
        """Trim the displayed name while rejecting whitespace-only values."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("device_name must not be empty")
        return normalized


class PairStartResponse(BaseModel):
    pair_code: str
    poll_key: str


class PairPollRequest(BaseModel):
    poll_key: str = Field(min_length=20, max_length=200)


class PairPollResponse(BaseModel):
    status: Literal["pending", "approved"]
    token: str | None = None


class PairApproveRequest(BaseModel):
    pair_code: str
    library_ids: list[str] = Field(min_length=1)

    @field_validator("pair_code")
    @classmethod
    def normalize_pair_code(cls, value: str) -> str:
        """Accept lowercase/spaced typing but retain the six-character alphabet."""
        normalized = "".join(value.upper().split())
        if len(normalized) != PAIR_CODE_LENGTH or any(
            character not in PAIR_CODE_ALPHABET for character in normalized
        ):
            raise ValueError("pair_code must be a valid six-character code")
        return normalized

    @field_validator("library_ids")
    @classmethod
    def unique_library_ids(cls, value: list[str]) -> list[str]:
        """Reject duplicate or empty scopes so the persisted grant is canonical."""
        if any(not library_id for library_id in value):
            raise ValueError("library_ids must not contain empty ids")
        if len(set(value)) != len(value):
            raise ValueError("library_ids must be unique")
        return value


class DeviceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    library_ids: list[str]
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None
