import time
import asyncio
from typing import Any, Dict, Tuple, Optional


class TTLCache:
    def __init__(self, default_ttl_seconds: float = 1.0) -> None:
        self._store: Dict[str, Tuple[float, Any]] = {}
        self._lock = asyncio.Lock()
        self._default_ttl = default_ttl_seconds

    async def get(self, key: str) -> Optional[Any]:
        async with self._lock:
            item = self._store.get(key)
            if item is None:
                return None
            expires_at, value = item
            if expires_at < time.time():
                self._store.pop(key, None)
                return None
            return value

    async def set(self, key: str, value: Any, ttl_seconds: Optional[float] = None) -> None:
        ttl = ttl_seconds if ttl_seconds is not None else self._default_ttl
        expires_at = time.time() + ttl
        async with self._lock:
            self._store[key] = (expires_at, value)

    async def expire(self, key: str) -> None:
        async with self._lock:
            self._store.pop(key, None)


