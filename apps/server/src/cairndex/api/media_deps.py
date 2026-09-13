"""Allowlisted media access selects legacy ownership or the private catalog adapter"""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import Cookie, Depends, Header, Request
from sqlalchemy.orm import Session

from cairndex.api.deps import (
    LibraryAccess,
    RegistryAccessDep,
    authorize_library,
    get_library_access,
)
from cairndex.auth import SESSION_COOKIE
from cairndex.registry import services
from cairndex.registry.library_package import read_manifest
from cairndex.replicas import service
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.protocol import ReplicaError

MediaContext = Session | ReplicaMedia


# Streaming holds no registry or content connection after its short resolution scope
@dataclass
class MediaAccess:
    legacy: LibraryAccess | None = None
    replica: ReplicaMedia | None = None

    # Lifecycle middleware owns the entire request including its streamed response
    @contextmanager
    def session(self) -> Iterator[MediaContext]:
        if self.replica is not None:
            yield self.replica
        else:
            assert self.legacy is not None
            with self.legacy.session() as db:
                yield db


# Only routes explicitly selecting this dependency can access replica media
def get_media_access(
    library_id: str,
    registry_access: RegistryAccessDep,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> MediaAccess:
    with registry_access.session() as registry:
        library = services.get_library(registry, library_id)
        root = Path(library.root_path)
        manifest = read_manifest(root)
        if manifest.replica is not None:
            authorize_library(
                registry,
                library_id=library_id,
                root=root,
                session_cookie=session_cookie,
                authorization=authorization,
            )
            store = service.get_store(library)
            if not isinstance(store, CatalogStore):
                raise ReplicaError("Local media requires the complete authored catalog capability")
            return MediaAccess(replica=ReplicaMedia(store, root, library_id))
    return MediaAccess(
        legacy=get_library_access(
            library_id,
            registry_access,
            session_cookie,
            authorization,
        )
    )


MediaAccessDep = Annotated[MediaAccess, Depends(get_media_access)]


# JSON media handlers keep the established legacy session transaction behavior
def get_media_context(access: MediaAccessDep, request: Request) -> Iterator[MediaContext]:
    with access.session() as db:
        if isinstance(db, Session):
            from cairndex.api.metadata import begin_metadata_request

            begin_metadata_request(request, db)
        yield db


MediaSession = Annotated[MediaContext, Depends(get_media_context)]
