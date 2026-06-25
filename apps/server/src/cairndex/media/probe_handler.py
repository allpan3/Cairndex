"""Probe job handler: ffprobe every eligible file in a storage root."""

from typing import Any

from cairndex.jobs.worker import JobContext
from cairndex.media.probe_service import probe_storage_root


def probe_job_handler(ctx: JobContext) -> dict[str, Any]:
    root_id = ctx.payload["storage_root_id"]
    reprobe = bool(ctx.payload.get("reprobe", False))

    summary = probe_storage_root(
        ctx.session,
        root_id,
        reprobe=reprobe,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
    )
    return {"probed": summary.probed, "skipped": summary.skipped, "failed": summary.failed}
