"""drop bundle source_url; rename file source_url to source

Revision ID: 27eb9a803ffb
Revises: b7c4b2f1f3a2
Create Date: 2026-06-26 06:52:12.579744+00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "27eb9a803ffb"
down_revision: str | None = "b7c4b2f1f3a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Bundles no longer carry a hyperlink.
    with op.batch_alter_table("asset_bundles") as batch:
        batch.drop_column("source_url")
    # A file's origin is a generic "source" (URL, magnet:, ed2k:, …), not a URL.
    with op.batch_alter_table("asset_files") as batch:
        batch.alter_column("source_url", new_column_name="source")


def downgrade() -> None:
    with op.batch_alter_table("asset_files") as batch:
        batch.alter_column("source", new_column_name="source_url")
    with op.batch_alter_table("asset_bundles") as batch:
        batch.add_column(sa.Column("source_url", sa.Text(), nullable=True))
