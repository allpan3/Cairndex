from fastapi import APIRouter

from cairndex.api.v1 import health, storage_roots

router = APIRouter(prefix="/api/v1")
router.include_router(health.router)
router.include_router(storage_roots.router)
