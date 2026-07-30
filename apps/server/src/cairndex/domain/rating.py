"""The bundle rating scale: 0–5 stars in half-star steps.

A rating is stored as a **number of stars** (``3.5``), not as a count of
half-star units (``7``). That choice is what lets half stars arrive without a
migration, which matters because there is no migration chain — library DBs are
bootstrapped with ``create_all`` and patched additively on open
(``persistence.engine.ensure_content_indexes``):

- ``asset_bundles.rating`` keeps its ``CHECK (rating >= 0 AND rating <= 5)``,
  which is baked into every library created before half stars existed and cannot
  be altered in SQLite without rebuilding the table;
- every whole-star value already in a library keeps its meaning, so nothing has
  to be rewritten in place;
- so does every rating literal baked into a saved Smart Collection's
  ``filter_json`` — ``rating >= 4`` still means four stars.

SQLite's dynamic typing carries the rest: the declared ``INTEGER`` affinity on an
existing column stores ``3.5`` as REAL (the conversion to integer would be
lossy), stores ``4.0`` back as INTEGER 4, and compares and groups the two
storage classes numerically. Half steps are exactly representable in binary
floating point, so equality filters and facet grouping stay exact.
"""

RATING_MIN = 0.0
RATING_MAX = 5.0
# Half a star. Also the reason this scale is safe in floating point: 0.5 is a
# power of two, so every valid rating is exact and `rating == 3.5` never misses.
RATING_STEP = 0.5

# The "unrated" bucket key for rating facets (JSON keys are strings; None → this).
UNRATED_KEY = "unrated"


def is_valid_rating(value: float) -> bool:
    """Whether ``value`` is within 0–5 and lands on a half-star boundary."""
    if not RATING_MIN <= value <= RATING_MAX:
        return False
    return float(value * 2).is_integer()


def rating_facet_key(value: float | None) -> str:
    """Canonical facet-bucket key for a rating (``None`` → ``"unrated"``).

    Whole stars key as ``"4"`` rather than ``"4.0"``, which is what clients and
    existing libraries already use; half stars key as ``"3.5"``. Routing every
    key through one function matters because SQLite hands back ``4`` as an int
    and ``3.5`` as a float from the same column, so raw ``str()`` would produce
    both spellings depending on what happens to be stored.
    """
    if value is None:
        return UNRATED_KEY
    return str(int(value)) if float(value).is_integer() else str(float(value))
