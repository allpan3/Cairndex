"""Probe job handler: ffprobe every eligible file in a library."""

from typing import Any

from cairndex.jobs.worker import JobContext
from cairndex.media.probe_service import probe_library


def probe_job_handler(ctx: JobContext) -> dict[str, Any]:
    reprobe = bool(ctx.payload.get("reprobe", False))

    summary = probe_library(
        ctx.session,
        reprobe=reprobe,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
    )
    return {"probed": summary.probed, "skipped": summary.skipped, "failed": summary.failed}
