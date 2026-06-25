"""The application's job-handler registry.

Handlers are registered here as each subsystem lands (scan in this phase;
probe/thumbnail next). The worker is constructed with whatever this returns.
"""

from cairndex.domain.enums import JobType
from cairndex.jobs.worker import HandlerRegistry
from cairndex.media.probe_handler import probe_job_handler
from cairndex.scanning.handler import scan_job_handler


def build_registry() -> HandlerRegistry:
    registry: HandlerRegistry = {
        JobType.SCAN: scan_job_handler,
        JobType.PROBE: probe_job_handler,
    }
    return registry
