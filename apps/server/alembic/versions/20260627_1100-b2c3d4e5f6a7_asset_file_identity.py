"""asset file filesystem identity

Adds filesystem identity columns (st_dev/st_ino + a trust flag) to ``asset_files``
for high-confidence moved-file repair during scans (AGENTS.md §5.3). Existing
rows get NULL identity and ``identity_available=False`` until the next scan
observes them.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-27 11:00:00.000000+00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("asset_files") as batch_op:
        batch_op.add_column(sa.Column("filesystem_device", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("filesystem_inode", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "identity_available",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("asset_files") as batch_op:
        batch_op.drop_column("identity_available")
        batch_op.drop_column("filesystem_inode")
        batch_op.drop_column("filesystem_device")
