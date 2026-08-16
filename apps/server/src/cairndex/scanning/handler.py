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
    # Discovery on its own is a legitimate thing to ask for, and it is what the
    # "Scan new files" action means. Grouping is the reviewable step next to it
    # in the same menu, so running it here regardless made one menu item do the
    # other's work and open its dialog (owner-reported, 2026-08-15).
    suggest_grouping = bool(ctx.payload.get("suggest_grouping", True))

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
    # Nothing new, moved, or missing means every suggestion over the unbundled
    # files is the one already on the open plan — so keep it, rather than writing a
    # few hundred identical rows and discarding the owner's selections with the
    # plan they were made on. On a network-hosted library that rewrite was seven
    # minutes per Update (owner-reported, 2026-08-13).
    plan = plan_store.reusable_open_plan(ctx.session) if suggest_grouping else None
    if suggest_grouping and plan is None:
        ctx.set_phase(JobPhase.GROUPING, "Matching filenames")
        data = suggest_for_session(ctx.session)
        ctx.set_phase(JobPhase.GROUPING, "Writing grouping suggestions")
        plan = plan_store.persist_plan(
            ctx.session,
            data,
            scan_job_id=ctx.job_id,
            on_progress=lambda written, total: ctx.progress(written, total),
        )
    # Outside the branch above, and after the plan the caller is waiting for is
    # already in. It used to run only when a new plan had been written, so the
    # steady state — Update finding nothing changed and keeping the open plan —
    # never pruned, and the backlog only ever grew (135 plans, 5.6 MB, owner's
    # library 2026-08-14). Cheap enough to run every time now that plans are local.
    # Runs for a scan-only pass too: it prunes plans this scan just obsoleted.
    plan_store.prune_obsolete_plans(ctx.session)
    ctx.set_phase(JobPhase.FINALIZING)
    return {
        "discovered": summary.discovered,
        "created": summary.created,
        "updated": summary.updated,
        "missing": summary.missing,
        "missing_total": summary.missing_total,
        "repaired": summary.repaired,
        # Null on a scan-only pass. The client opens grouping review off these
        # two keys, so a scan that was not asked to suggest must not report a
        # plan — not even an older open one it happened to leave alone.
        "grouping_plan_id": plan.id if plan is not None else None,
        "grouping_proposal_count": len(plan.proposals) if plan is not None else 0,
    }
