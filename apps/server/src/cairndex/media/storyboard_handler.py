"""Storyboard job handler: pre-generate trickplay sheets for a library."""

from typing import Any

from cairndex.domain.enums import JobPhase
from cairndex.jobs.worker import JobContext
from cairndex.media.storyboards import generate_for_library


# Run the library-wide storyboard job with progress reporting
def storyboard_job_handler(ctx: JobContext) -> dict[str, Any]:
    force = bool(ctx.payload.get("force", False))

    ctx.set_phase(JobPhase.STORYBOARDING, "Generating storyboards")
    summary = generate_for_library(
        ctx.session,
        force=force,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
    )
    return {"generated": summary.generated, "skipped": summary.skipped, "failed": summary.failed}
