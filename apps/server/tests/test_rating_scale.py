"""The 0–5 half-star rating scale and its backward compatibility.

Half stars were added without a migration by widening what a rating *value* may
be rather than changing what the column *counts* (see ``cairndex.domain.rating``).
The tests here pin the two things that makes load-bearing: an off-grid value is
refused, and a library created before half stars existed — whose ``rating``
column is declared ``INTEGER`` and carries a ``CHECK (rating >= 0 AND rating <= 5)``
that SQLite cannot alter in place — still stores and queries one correctly.
"""

import pytest
from sqlalchemy import Column, Float, MetaData, String, Table, create_engine, select, text

from cairndex.domain.rating import UNRATED_KEY, is_valid_rating, rating_facet_key


# --- The scale ---------------------------------------------------------------
@pytest.mark.parametrize("value", [0, 0.5, 1, 2.5, 3.5, 4.5, 5])
def test_half_star_values_are_valid(value: float) -> None:
    assert is_valid_rating(value)


@pytest.mark.parametrize("value", [-0.5, 0.25, 3.3, 4.75, 5.5, 6])
def test_off_grid_and_out_of_range_values_are_invalid(value: float) -> None:
    assert not is_valid_rating(value)


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, UNRATED_KEY), (0, "0"), (0.5, "0.5"), (4, "4"), (4.0, "4"), (3.5, "3.5"), (5, "5")],
)
def test_facet_keys_are_canonical(value: float | None, expected: str) -> None:
    """Whole stars never key as ``"4.0"``, whichever storage class they arrive in."""
    assert rating_facet_key(value) == expected


# --- Compatibility with a pre-half-star library ------------------------------
LEGACY_DDL = """
CREATE TABLE asset_bundles (
    id VARCHAR(26) NOT NULL PRIMARY KEY,
    rating INTEGER,
    CONSTRAINT rating_range CHECK (rating >= 0 AND rating <= 5)
)
"""


def test_half_star_survives_the_legacy_integer_column() -> None:
    """The premise of the no-migration design, exercised against the old DDL.

    SQLite's INTEGER affinity narrows a REAL only when the conversion is lossless,
    so 3.5 is stored as REAL while 4.0 becomes INTEGER 4 — and the range CHECK,
    which is baked into every existing library and cannot be dropped without
    rebuilding the table, is satisfied by both.
    """
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text(LEGACY_DDL))

    # Bound through SQLAlchemy's Float type, exactly as the ORM model now does.
    legacy = Table(
        "asset_bundles",
        MetaData(),
        Column("id", String(26), primary_key=True),
        Column("rating", Float, nullable=True),
    )
    with engine.begin() as conn:
        conn.execute(
            legacy.insert(),
            [
                {"id": "half", "rating": 3.5},
                {"id": "whole", "rating": 4.0},
                {"id": "lowest", "rating": 0.5},
                {"id": "unrated", "rating": None},
            ],
        )

    with engine.connect() as conn:
        stored = dict(conn.execute(select(legacy.c.id, legacy.c.rating)).all())
        assert stored == {"half": 3.5, "whole": 4.0, "lowest": 0.5, "unrated": None}

        # Storage classes differ, which is precisely why facet keys are formatted.
        classes = dict(
            conn.execute(text("SELECT id, typeof(rating) FROM asset_bundles")).all()  # noqa: S608
        )
        assert classes == {
            "half": "real",
            "whole": "integer",
            "lowest": "real",
            "unrated": "null",
        }

        # Comparisons span both storage classes.
        at_least_three_and_a_half = set(
            conn.scalars(select(legacy.c.id).where(legacy.c.rating >= 3.5))
        )
        assert at_least_three_and_a_half == {"half", "whole"}
        assert set(conn.scalars(select(legacy.c.id).where(legacy.c.rating == 4))) == {"whole"}


def test_legacy_check_constraint_still_bounds_the_range() -> None:
    """Out-of-range values are refused by the old CHECK, not only by the schema."""
    from sqlalchemy.exc import IntegrityError

    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text(LEGACY_DDL))
        with pytest.raises(IntegrityError):
            conn.execute(text("INSERT INTO asset_bundles VALUES ('too-high', 5.5)"))
