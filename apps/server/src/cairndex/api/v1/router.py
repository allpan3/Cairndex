from fastapi import APIRouter

from cairndex.api.v1 import (
    bundles,
    folders,
    health,
    jobs,
    storage_roots,
    tag_groups,
    tags,
)

router = APIRouter(prefix="/api/v1")
router.include_router(health.router)
router.include_router(storage_roots.router)
router.include_router(bundles.router)
router.include_router(tags.router)
router.include_router(tag_groups.router)
router.include_router(folders.router)
router.include_router(jobs.router)
