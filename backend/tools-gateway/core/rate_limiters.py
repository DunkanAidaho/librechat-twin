from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Deque


class RateLimiter:
    def __init__(self, max_requests_per_second: int = 50) -> None:
        self.max_requests = max_requests_per_second
        self.requests: Deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                now = time.time()
                while self.requests and self.requests[0] <= now - 1:
                    self.requests.popleft()
                if len(self.requests) < self.max_requests:
                    self.requests.append(now)
                    return
                sleep_time = (self.requests[0] + 1) - now
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)
            else:
                await asyncio.sleep(0)


class MinuteRateLimiter:
    def __init__(self, max_requests_per_minute: int = 10) -> None:
        self.max_requests = max_requests_per_minute
        self.requests: Deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                now = time.time()
                while self.requests and self.requests[0] <= now - 60:
                    self.requests.popleft()
                if len(self.requests) < self.max_requests:
                    self.requests.append(now)
                    return
                sleep_time = (self.requests[0] + 60) - now
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)
            else:
                await asyncio.sleep(0)
