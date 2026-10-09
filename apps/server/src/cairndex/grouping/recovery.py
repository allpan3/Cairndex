"""Finish committed acceptance in disposable plans using the existing request receipt"""

import json

from sqlalchemy.orm import Session

from cairndex.core.time import utcnow
from cairndex.domain.enums import GroupingPlanStatus
from cairndex.persistence.models import GroupingPlan


# Retire accepted rows only; recovery never reapplies or reconstructs library metadata
def settle_plan(session: Session, plan: GroupingPlan, accepted: set[str], selected: bool) -> None:
    from cairndex.grouping.apply import _retire_applied_proposals

    if selected:
        _retire_applied_proposals(session, plan, accepted)
        session.flush()
        session.expire(plan, ["proposals"])
    if not selected or not any(p.files for p in plan.proposals):
        plan.status = GroupingPlanStatus.APPLIED
        plan.applied_at = utcnow()
    session.flush()


# Called under BEGIN IMMEDIATE; a false result leaves that reservation with the caller
def recover_pending(session: Session) -> bool:
    from cairndex.metadata.session import read_basis

    connection = session.connection()
    receipt = connection.exec_driver_sql(
        "SELECT operation, grouping_settlement FROM metadata_receipts "
        "WHERE grouping_settlement IS NOT NULL LIMIT 1"
    ).first()
    if receipt is None:
        return False
    effect = json.loads(receipt.grouping_settlement)
    # This is committed housekeeping, never a new edit authorized by an old browser basis
    connection.info["metadata_context"] = None
    session.info.pop("metadata_edit", None)
    plan = session.get(GroupingPlan, effect["plan_id"])
    epoch = connection.exec_driver_sql(
        "SELECT epoch FROM plans.metadata_clock WHERE id=1"
    ).scalar_one()
    if plan is not None and epoch == effect["epoch"]:
        settle_plan(session, plan, set(effect["accepted"]), effect["selected"])
    session.commit()  # Only the disposable plan is written in this transaction
    connection = session.connection()
    connection.exec_driver_sql("BEGIN IMMEDIATE")
    connection.exec_driver_sql(
        "UPDATE metadata_receipts SET grouping_settlement=NULL, basis=? WHERE operation=?",
        (read_basis(connection), receipt.operation),
    )
    session.commit()  # Forget the intent only after plan retirement is durable
    return True


# Reads recover before taking their coherent snapshot; ordinary reads never reserve a writer
def recover_before_read(session: Session) -> None:
    pending = (
        session.connection()
        .exec_driver_sql(
            "SELECT 1 FROM metadata_receipts WHERE grouping_settlement IS NOT NULL LIMIT 1"
        )
        .first()
    )
    if pending is None:
        return
    session.rollback()
    while True:
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        if not recover_pending(session):
            session.rollback()
            return
