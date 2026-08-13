"""Scan job handler: runs a library scan under the job worker.

Progress is reported through ``ctx.checkpoint``, which also raises
``JobCancelled`` when a cancel is requested — so a long scan stops promptly
while keeping everything already committed. The library root comes from the
registry via ``ctx.library_root`` (ADR-0008).
"""

from typing import Any

from cairndex.domain.enums import JobPhase
from cairndex.grouping import plan_store
from cairndex.grouping.service import suggest_for_session
from cairndex.jobs.worker import JobContext
from cairndex.scanning.scanner import scan_library


# Run discovery, then persist a reviewable grouping plan without applying it
def scan_job_handler(ctx: JobContext) -> dict[str, Any]:
    batch_size = int(ctx.payload.get("batch_size", 200))

    # ctx.progress, not ctx.checkpoint: the scanner now reports every file and
    # commits on its own batch schedule, so this must not force a commit per
    # call. Both throttle their registry writes identically.
    summary = scan_library(
        ctx.session,
        ctx.library_root,
        on_progress=lambda processed, total: ctx.progress(processed, total),
        on_phase=lambda name: ctx.set_phase(JobPhase(name)),
        batch_size=batch_size,
    )
    # Two steps with their own messages, because grouping is the one phase that
    # used to be a single opaque call: on a large library the bar sat animating
    # with nothing to say for it, which reads as a hang (owner-reported,
    # 2026-08-13). Suggesting has no count to offer — it recurses a directory
    # tree — so it says what it is doing; writing counts its rows.
    ctx.set_phase(JobPhase.GROUPING, "Matching filenames")
    data = suggest_for_session(ctx.session)
    ctx.set_phase(JobPhase.GROUPING, "Writing grouping suggestions")
    plan = plan_store.persist_plan(
        ctx.session,
        data,
        scan_job_id=ctx.job_id,
        on_progress=lambda written, total: ctx.progress(written, total),
    )
    ctx.set_phase(JobPhase.FINALIZING)
    return {
        "discovered": summary.discovered,
        "created": summary.created,
        "updated": summary.updated,
        "missing": summary.missing,
        "missing_total": summary.missing_total,
        "repaired": summary.repaired,
        "grouping_plan_id": plan.id,
        "grouping_proposal_count": len(plan.proposals),
    }
