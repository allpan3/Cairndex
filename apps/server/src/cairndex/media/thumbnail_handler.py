"""Thumbnail job handler: pre-generate thumbnails for a library."""

from typing import Any

from cairndex.domain.enums import JobPhase
from cairndex.jobs.worker import JobContext
from cairndex.media.thumbnails import generate_for_library


def thumbnail_job_handler(ctx: JobContext) -> dict[str, Any]:
    force = bool(ctx.payload.get("force", False))

    ctx.set_phase(JobPhase.THUMBNAILING, "Generating thumbnails")
    summary = generate_for_library(
        ctx.session,
        force=force,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
    )
    return {"generated": summary.generated, "failed": summary.failed}
