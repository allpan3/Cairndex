"""Server-side library registry (ADR-0008).

A separate, server-local database (``{CAIRNDEX_DATA_DIR}/registry.db``) that
tracks registered libraries and the runtime job queue. This is *not* portable
library metadata — each library's own content metadata lives in its
``.cairndex/library.db``. Keep this package independent of the content
persistence layer so the two databases evolve separately.
"""
