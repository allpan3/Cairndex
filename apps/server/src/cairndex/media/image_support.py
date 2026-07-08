"""Image/openability support helpers kept free of decoder imports."""

from pathlib import Path

from cairndex.domain.enums import MediaKind

BROWSER_NATIVE_IMAGE_EXTENSIONS = frozenset({"jpg", "jpeg", "png", "gif", "webp"})
PREVIEW_IMAGE_EXTENSIONS = frozenset(
    {*BROWSER_NATIVE_IMAGE_EXTENSIONS, "bmp", "tif", "tiff", "heic", "heif", "psd"}
)


# Return the lowercase suffix without a leading dot
def extension_of(path: str) -> str:
    return Path(path).suffix.lower().removeprefix(".")


# True when an image can be displayed by the browser without server conversion
def is_browser_native_image(path: str) -> bool:
    return extension_of(path) in BROWSER_NATIVE_IMAGE_EXTENSIONS


# True when the preview pipeline can derive a browser-displayable WebP
def is_preview_capable_image(path: str) -> bool:
    return extension_of(path) in PREVIEW_IMAGE_EXTENSIONS


# True when Cairndex can show/play this file inside the web UI
def is_openable_media(kind: MediaKind | str | None, path: str) -> bool:
    if kind is None:
        return False
    media_kind = MediaKind(kind)
    if media_kind is MediaKind.IMAGE:
        return is_preview_capable_image(path)
    return media_kind in (MediaKind.VIDEO, MediaKind.AUDIO)
