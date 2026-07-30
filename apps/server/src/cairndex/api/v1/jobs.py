from typing import Annotated

from fastapi import APIRouter, Query

from cairndex.api.deps import Pagination, RegistryDbSession
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.jobs import JobRead
from cairndex.registry import jobs as service

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=Page[JobRead])
def list_jobs(db: RegistryDbSession, page: Pagination) -> Page[JobRead]:
    rows, next_cursor = service.list_jobs(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[JobRead.model_validate(j) for j in rows], next_cursor=next_cursor)


# Before /{job_id}, or "active" is read as a job id.
@router.get("/active", response_model=list[JobRead])
def list_active_jobs(
    db: RegistryDbSession, library_id: Annotated[str | None, Query()] = None
) -> list[JobRead]:
    """Jobs running or waiting, oldest first — what a client asks on load.

    Progress used to live only in the mutation that started a job, so reloading
    the page lost track of work that was still going: the owner reported coming
    back to a scan indicator that had simply vanished while the scan ran on
    (2026-07-30). The queue is server state, so a fresh client can pick it up.

    Unpaged: one job runs at a time and only a few ever queue behind it.
    """
    return [JobRead.model_validate(j) for j in service.list_active_jobs(db, library_id=library_id)]


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: str, db: RegistryDbSession) -> JobRead:
    return JobRead.model_validate(service.get_job(db, job_id))


@router.post("/{job_id}/cancel", response_model=JobRead)
def cancel_job(job_id: str, db: RegistryDbSession) -> JobRead:
    return JobRead.model_validate(service.request_cancel(db, job_id))
