"""rename folders to collections

Renames the logical-grouping tables from the legacy "folder" terminology to
"collection" (AGENTS.md §4.7). No physical files are touched — this is a
metadata-only rename. Data (hierarchy, parent-child links, and bundle
memberships) is copied across verbatim, preserving every id.

  folders                -> collections
  asset_bundle_folders   -> asset_bundle_collections  (folder_id -> collection_id)

Revision ID: a1b2c3d4e5f6
Revises: bfa871853413
Create Date: 2026-06-27 09:00:00.000000+00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "bfa871853413"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Defer FK enforcement to commit so the self-referencing INSERT...SELECT
    # (a child collection may precede its parent in copy order) is accepted.
    op.execute("PRAGMA defer_foreign_keys=ON")

    op.create_table(
        "collections",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("parent_id", sa.String(length=26), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["collections.id"],
            name=op.f("fk_collections_parent_id_collections"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_collections")),
        sa.UniqueConstraint("parent_id", "name", name="parent_name"),
    )
    op.execute(
        "INSERT INTO collections (id, parent_id, name, sort_order, created_at, updated_at) "
        "SELECT id, parent_id, name, sort_order, created_at, updated_at FROM folders"
    )

    op.create_table(
        "asset_bundle_collections",
        sa.Column("bundle_id", sa.String(length=26), nullable=False),
        sa.Column("collection_id", sa.String(length=26), nullable=False),
        sa.ForeignKeyConstraint(
            ["bundle_id"],
            ["asset_bundles.id"],
            name=op.f("fk_asset_bundle_collections_bundle_id_asset_bundles"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["collections.id"],
            name=op.f("fk_asset_bundle_collections_collection_id_collections"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "bundle_id", "collection_id", name=op.f("pk_asset_bundle_collections")
        ),
    )
    op.execute(
        "INSERT INTO asset_bundle_collections (bundle_id, collection_id) "
        "SELECT bundle_id, folder_id FROM asset_bundle_folders"
    )

    op.drop_table("asset_bundle_folders")
    op.drop_table("folders")


def downgrade() -> None:
    op.execute("PRAGMA defer_foreign_keys=ON")

    op.create_table(
        "folders",
        sa.Column("id", sa.String(length=26), nullable=False),
        sa.Column("parent_id", sa.String(length=26), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["folders.id"],
            name=op.f("fk_folders_parent_id_folders"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_folders")),
        sa.UniqueConstraint("parent_id", "name", name="parent_name"),
    )
    op.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) "
        "SELECT id, parent_id, name, sort_order, created_at, updated_at FROM collections"
    )

    op.create_table(
        "asset_bundle_folders",
        sa.Column("bundle_id", sa.String(length=26), nullable=False),
        sa.Column("folder_id", sa.String(length=26), nullable=False),
        sa.ForeignKeyConstraint(
            ["bundle_id"],
            ["asset_bundles.id"],
            name=op.f("fk_asset_bundle_folders_bundle_id_asset_bundles"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["folder_id"],
            ["folders.id"],
            name=op.f("fk_asset_bundle_folders_folder_id_folders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("bundle_id", "folder_id", name=op.f("pk_asset_bundle_folders")),
    )
    op.execute(
        "INSERT INTO asset_bundle_folders (bundle_id, folder_id) "
        "SELECT bundle_id, collection_id FROM asset_bundle_collections"
    )

    op.drop_table("asset_bundle_collections")
    op.drop_table("collections")
