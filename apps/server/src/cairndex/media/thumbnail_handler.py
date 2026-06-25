"""Thumbnail job handler: pre-generate thumbnails for a storage root."""

from typing import Any

from cairndex.jobs.worker import JobContext
from cairndex.media.thumbnails import generate_for_root


def thumbnail_job_handler(ctx: JobContext) -> dict[str, Any]:
    root_id = ctx.payload["storage_root_id"]
    force = bool(ctx.payload.get("force", False))

    summary = generate_for_root(
        ctx.session,
        root_id,
        force=force,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
    )
    return {"generated": summary.generated, "failed": summary.failed}
