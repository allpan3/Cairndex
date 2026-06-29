"""Bundle grouping suggester (ADR-0009).

A read-only heuristic that proposes how scan-discovered files should be grouped
into bundles and logical containers. It never writes — applying a plan is a
separate, conflict-aware step (ADR-0009 phase 3).
"""

from cairndex.grouping.suggester import (
    SUGGESTER_RULE_VERSION,
    FileObservation,
    GroupingPlan,
    GroupingProposal,
    ProposalKind,
    ProposedFile,
    suggest_grouping,
)

__all__ = [
    "SUGGESTER_RULE_VERSION",
    "FileObservation",
    "GroupingPlan",
    "GroupingProposal",
    "ProposalKind",
    "ProposedFile",
    "suggest_grouping",
]
