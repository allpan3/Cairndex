from fastapi import APIRouter

from cairndex.api.v1 import (
    bundles,
    collections,
    eagle,
    filters,
    health,
    jobs,
    libraries,
    library_collections,
    playback,
    smart_collections,
    storage_roots,
    tag_groups,
    tags,
)

router = APIRouter(prefix="/api/v1")
router.include_router(health.router)
router.include_router(libraries.router)
router.include_router(library_collections.router)
router.include_router(storage_roots.router)
router.include_router(bundles.router)
router.include_router(tags.router)
router.include_router(tag_groups.router)
router.include_router(collections.router)
router.include_router(smart_collections.router)
router.include_router(filters.router)
router.include_router(playback.router)
router.include_router(eagle.router)
router.include_router(jobs.router)
