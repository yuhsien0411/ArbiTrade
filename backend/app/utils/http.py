from __future__ import annotations

import asyncio
from typing import Optional

import httpx

_client_lock = asyncio.Lock()
_client: Optional[httpx.AsyncClient] = None


async def get_http_client() -> httpx.AsyncClient:
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            limits = httpx.Limits(max_keepalive_connections=20, max_connections=100)
            timeout = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)
            _client = httpx.AsyncClient(limits=limits, timeout=timeout, headers={"User-Agent": "arbi-backend/1.0"})
    return _client


async def close_http_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


