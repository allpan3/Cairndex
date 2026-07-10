from fastapi import APIRouter

from cairndex.api.v1 import (
    auth,
    bundles,
    filters,
    grouping,
    health,
    jobs,
    libraries,
    library_collections,
    library_files,
    manual_bundling,
    playback,
    playback_sessions,
    smart_collections,
    tag_groups,
    tags,
)

router = APIRouter(prefix="/api/v1")
# Global (registry) routes.
router.include_router(health.router)
router.include_router(libraries.router)
router.include_router(jobs.router)
# Per-library auth (reachable while locked — the way to unlock; not content-gated).
router.include_router(auth.router)
# Library-scoped content routes (/api/v1/libraries/{library_id}/...).
router.include_router(library_collections.router)
router.include_router(library_files.router)
router.include_router(bundles.router)
router.include_router(tags.router)
router.include_router(tag_groups.router)
router.include_router(smart_collections.router)
router.include_router(filters.router)
router.include_router(playback.router)
router.include_router(playback_sessions.router)
router.include_router(grouping.router)
router.include_router(manual_bundling.router)
