"""Scan job handler: runs a storage-root scan under the job worker.

Progress is reported through ``ctx.checkpoint``, which also raises
``JobCancelled`` when a cancel is requested — so a long scan stops promptly
while keeping everything already committed.
"""

from typing import Any

from cairndex.jobs.worker import JobContext
from cairndex.scanning.scanner import scan_storage_root


def scan_job_handler(ctx: JobContext) -> dict[str, Any]:
    root_id = ctx.payload["storage_root_id"]
    batch_size = int(ctx.payload.get("batch_size", 200))

    summary = scan_storage_root(
        ctx.session,
        root_id,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
        batch_size=batch_size,
    )
    return {
        "discovered": summary.discovered,
        "created": summary.created,
        "updated": summary.updated,
        "missing": summary.missing,
    }
