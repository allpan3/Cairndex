"""Regression coverage for bounded lazy media request work"""

import asyncio
import threading

from anyio import to_thread

from cairndex.api.media_work import run_derivative


# Admit expensive media work before it can exhaust AnyIO's shared worker pool
def test_derivative_admission_preserves_shared_worker_capacity() -> None:
    async def scenario() -> None:
        release = threading.Event()
        four_entered = threading.Event()
        lock = threading.Lock()
        entered = 0

        def block_derivative() -> None:
            nonlocal entered
            with lock:
                entered += 1
                if entered == 4:
                    four_entered.set()
            assert release.wait(5)

        tasks = [asyncio.create_task(run_derivative(block_derivative)) for _ in range(44)]
        try:
            assert await asyncio.to_thread(four_entered.wait, 1)
            assert entered == 4
            assert await asyncio.wait_for(to_thread.run_sync(lambda: "available"), 1) == "available"
        finally:
            release.set()
            await asyncio.gather(*tasks)

    asyncio.run(scenario())
