"""The application's job-handler registry.

Handlers are registered here as each subsystem lands (scan in this phase;
probe/thumbnail next). The worker is constructed with whatever this returns.
"""

from cairndex.jobs.worker import HandlerRegistry


def build_registry() -> HandlerRegistry:
    registry: HandlerRegistry = {}
    return registry
