"""Scan job handler: runs a library scan under the job worker.

Progress is reported through ``ctx.checkpoint``, which also raises
``JobCancelled`` when a cancel is requested — so a long scan stops promptly
while keeping everything already committed. The library root comes from the
registry via ``ctx.library_root`` (ADR-0008).
"""

from typing import Any

from cairndex.domain.enums import JobPhase
from cairndex.grouping import plan_store
from cairndex.jobs.worker import JobContext
from cairndex.scanning.scanner import scan_library


# Run discovery, then persist a reviewable grouping plan without applying it
def scan_job_handler(ctx: JobContext) -> dict[str, Any]:
    batch_size = int(ctx.payload.get("batch_size", 200))

    summary = scan_library(
        ctx.session,
        ctx.library_root,
        on_progress=lambda processed, total: ctx.checkpoint(processed, total),
        on_phase=lambda name: ctx.set_phase(JobPhase(name)),
        batch_size=batch_size,
    )
    ctx.set_phase(JobPhase.GROUPING, "Generating grouping suggestions")
    plan = plan_store.generate_plan(ctx.session, scan_job_id=ctx.job_id)
    ctx.set_phase(JobPhase.FINALIZING)
    return {
        "discovered": summary.discovered,
        "created": summary.created,
        "updated": summary.updated,
        "missing": summary.missing,
        "repaired": summary.repaired,
        "grouping_plan_id": plan.id,
        "grouping_proposal_count": len(plan.proposals),
    }
