"""Catalog playlist reads and local retry/cursor state for the shared media viewer"""

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel

from cairndex.api.media_deps import MediaAccessDep
from cairndex.api.schemas.bundles import DirectoryMemberRead, FileRead
from cairndex.api.schemas.moments import MomentRead
from cairndex.api.schemas.playback import PlayableVideo, PlaybackProgressRead
from cairndex.core.errors import ValidationError
from cairndex.domain.enums import FileAvailability, MediaKind
from cairndex.media.playback import assess_playability
from cairndex.replicas.media import ReplicaMedia
from cairndex.replicas.protocol import ReplicaError

router = APIRouter(prefix="/libraries/{library_id}/replica/media", tags=["replica-media"])


# Explicit capability fence keeps protocol-one packages and ordinary catalog mutators separate
def replica_media(access: MediaAccessDep) -> ReplicaMedia:
    if access.replica is None:
        raise ReplicaError("This API requires a complete replica catalog")
    return access.replica


Media = Annotated[ReplicaMedia, Depends(replica_media)]


# The media view adds only device-local observations to the existing immutable catalog identity
class LocalMediaRead(BaseModel):
    file: FileRead
    generation: str | None
    state: str
    message: str | None
    playback: PlayableVideo | None


# Playlist metadata is paginated and does not touch source bytes or probe its members
class ReplicaPlaylist(BaseModel):
    bundle_id: str
    title: str
    cursor: str | None
    files: list[FileRead]
    directories: list[DirectoryMemberRead]
    moments: list[MomentRead]
    next_offset: int | None


# Resolve only this selected bundle's catalog rows, preserving folder-member playlist semantics
@router.get("/bundles/{bundle_id}", response_model=ReplicaPlaylist)
def playlist(
    bundle_id: str,
    media: Media,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
) -> ReplicaPlaylist:
    bundle = media.row("asset_bundles", bundle_id)
    with media.store.connection(readonly=True) as db:
        ids = [
            row[0]
            for row in db.execute(
                "SELECT c.entity FROM catalog_placements p JOIN catalog_rows c "
                "ON p.family=c.family AND p.entity=c.entity "
                "WHERE p.owner=? AND c.family='asset_files' "
                "ORDER BY CAST(json_extract(p.body,'$.sequence') AS INTEGER),c.entity "
                "LIMIT ? OFFSET ?",
                (f"asset_bundles/{bundle_id}/$members", limit + 1, offset),
            )
        ]
        cursor = db.execute(
            "SELECT file_id FROM local_cursors WHERE bundle_id=?", (bundle_id,)
        ).fetchone()
    return ReplicaPlaylist(
        bundle_id=bundle_id,
        title=bundle["title"] or "Media",
        cursor=cursor[0] if cursor else None,
        files=[FileRead.model_validate(media.file(identity)) for identity in ids[:limit]],
        directories=[
            DirectoryMemberRead.model_validate(row)
            for row in media.related("bundle_directory_members", f"asset_bundles/{bundle_id}")
        ],
        moments=[
            MomentRead.model_validate(row)
            for row in media.related("moments", f"asset_bundles/{bundle_id}")
        ],
        next_offset=offset + limit if len(ids) > limit else None,
    )


# A retry checks this single file and performs one bounded probe only when its generation changed
@router.get("/files/{file_id}", response_model=LocalMediaRead)
def local_file(file_id: str, media: Media) -> LocalMediaRead:
    from cairndex.api.v1.playback import _chapters, _track_read

    asset = media.file(file_id, inspect=True, probe=True)
    available = asset.availability == FileAvailability.AVAILABLE
    meta = asset.tech_metadata or {}
    cap = assess_playability(asset)
    progress = media.progress(file_id, asset.quick_fingerprint)
    with media.store.connection(readonly=True) as db:
        row = db.execute("SELECT error FROM local_media WHERE file_id=?", (file_id,)).fetchone()
    message = row[0] if row else None
    video = None
    if available and asset.media_kind == MediaKind.VIDEO and meta:
        video = PlayableVideo(
            file_id=file_id,
            display_title=asset.relative_path.rsplit("/", 1)[-1],
            playable=cap.playable,
            reason=cap.reason,
            mime_type=cap.mime_type,
            stream_url=f"/api/v1/libraries/{media.library_id}/files/{file_id}/stream?source_generation={asset.quick_fingerprint}",
            width=meta.get("width"),
            height=meta.get("height"),
            duration=meta.get("duration"),
            storyboard_url=None,
            chapters=_chapters(meta),
            progress=PlaybackProgressRead.model_validate(progress) if progress else None,
            subtitles=[
                _track_read(media, media.library_id, track) for track in media.tracks(file_id)
            ],
        )
    return LocalMediaRead(
        file=FileRead.model_validate(asset),
        generation=asset.quick_fingerprint,
        state="available" if available else "unavailable",
        message=message
        if available
        else "Media unavailable on this device. Make the local file readable, then retry.",
        playback=video,
    )


# Remember a catalog member without publishing an authored event or needing source availability
class ReplicaCursorUpdate(BaseModel):
    file_id: str


# Cursor validation and its write share the catalog snapshot so transfers cannot race the check
@router.put("/bundles/{bundle_id}/cursor", status_code=204)
def cursor(bundle_id: str, payload: ReplicaCursorUpdate, media: Media) -> Response:
    with media.store.connection() as db:
        row = db.execute(
            "SELECT body FROM catalog_rows WHERE family='asset_files' AND entity=?",
            (payload.file_id,),
        ).fetchone()
        if not row or json.loads(row[0])["bundle_id"] != bundle_id:
            raise ValidationError("Cursor must name a current member of this bundle")
        db.execute(
            "INSERT OR REPLACE INTO local_cursors VALUES (?, ?)", (bundle_id, payload.file_id)
        )
    return Response(status_code=204)
