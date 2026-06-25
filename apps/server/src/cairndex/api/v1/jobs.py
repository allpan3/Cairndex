from fastapi import APIRouter

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.jobs import JobRead
from cairndex.services import jobs as service

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=Page[JobRead])
def list_jobs(db: DbSession, page: Pagination) -> Page[JobRead]:
    rows, next_cursor = service.list_jobs(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[JobRead.model_validate(j) for j in rows], next_cursor=next_cursor)


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: str, db: DbSession) -> JobRead:
    return JobRead.model_validate(service.get_job(db, job_id))


@router.post("/{job_id}/cancel", response_model=JobRead)
def cancel_job(job_id: str, db: DbSession) -> JobRead:
    return JobRead.model_validate(service.request_cancel(db, job_id))
