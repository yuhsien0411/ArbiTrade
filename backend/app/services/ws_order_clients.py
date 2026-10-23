from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Any, Dict, Optional

import websockets


class AsyncTokenBucket:
    def __init__(self, rate_per_second: float = 10.0, capacity: int = 10) -> None:
        self.rate_per_second = rate_per_second
        self.capacity = float(capacity)
        self._tokens = float(capacity)
        self._updated_at = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                now = time.monotonic()
                elapsed = now - self._updated_at
                self._updated_at = now
                self._tokens = min(self.capacity, self._tokens + elapsed * self.rate_per_second)
                if self._tokens >= 1:
                    self._tokens -= 1
                    return

                wait_for = (1 - self._tokens) / self.rate_per_second

            await asyncio.sleep(wait_for)


class WebSocketOrderError(Exception):
    pass


class BybitWsOrderClient:
    def __init__(self, api_key: str, api_secret: str, testnet: bool = False, logger: Any = None) -> None:
        self.api_key = api_key
        self.api_secret = api_secret
        self.testnet = testnet
        self.logger = logger
        self.url = "wss://stream-testnet.bybit.com/v5/trade" if testnet else "wss://stream.bybit.com/v5/trade"
        self._ws = None
        self._reader_task: Optional[asyncio.Task] = None
        self._connect_lock = asyncio.Lock()
        self._pending: Dict[str, asyncio.Future] = {}
        self._rate_limiter = AsyncTokenBucket(10, 10)

    async def create_order(self, order_params: Dict[str, Any], timeout: float = 5.0) -> Dict[str, Any]:
        await self._rate_limiter.acquire()
        await self._ensure_connected()

        req_id = f"arb-{uuid.uuid4().hex[:28]}"
        timestamp = str(int(time.time() * 1000))
        payload = {
            "reqId": req_id,
            "header": {
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-RECV-WINDOW": "5000",
            },
            "op": "order.create",
            "args": [order_params],
        }
        return await self._send_request(req_id, payload, timeout)

    async def _ensure_connected(self) -> None:
        if self._ws is not None and not self._ws.closed:
            return

        async with self._connect_lock:
            if self._ws is not None and not self._ws.closed:
                return

            await self._close()
            self._ws = await websockets.connect(self.url, ping_interval=20, ping_timeout=10)
            await self._authenticate()
            self._reader_task = asyncio.create_task(self._reader_loop())

    async def _authenticate(self) -> None:
        expires = int((time.time() + 10) * 1000)
        signature = hmac.new(
            self.api_secret.encode("utf-8"),
            f"GET/realtime{expires}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        await self._ws.send(json.dumps({"op": "auth", "args": [self.api_key, expires, signature]}))
        raw = await asyncio.wait_for(self._ws.recv(), timeout=5.0)
        data = json.loads(raw)
        ok = data.get("retCode") == 0 or data.get("success") is True
        if not ok:
            raise WebSocketOrderError(f"Bybit WS auth failed: {data}")

    async def _send_request(self, req_id: str, payload: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[req_id] = future
        try:
            await self._ws.send(json.dumps(payload))
            data = await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

        if data.get("retCode") != 0:
            raise WebSocketOrderError(data.get("retMsg") or str(data))
        return data.get("data", {})

    async def _reader_loop(self) -> None:
        try:
            async for raw in self._ws:
                data = json.loads(raw)
                req_id = data.get("reqId")
                if req_id and req_id in self._pending:
                    future = self._pending[req_id]
                    if not future.done():
                        future.set_result(data)
        except Exception as exc:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(exc)
            self._pending.clear()
            await self._close(clear_reader=False)

    async def _close(self, clear_reader: bool = True) -> None:
        if clear_reader and self._reader_task:
            self._reader_task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None


class OKXWsOrderClient:
    def __init__(
        self,
        api_key: str,
        api_secret: str,
        password: str,
        testnet: bool = False,
        logger: Any = None,
    ) -> None:
        self.api_key = api_key
        self.api_secret = api_secret
        self.password = password
        self.testnet = testnet
        self.logger = logger
        self.url = "wss://wspap.okx.com:8443/ws/v5/private" if testnet else "wss://ws.okx.com:8443/ws/v5/private"
        self._ws = None
        self._reader_task: Optional[asyncio.Task] = None
        self._connect_lock = asyncio.Lock()
        self._pending: Dict[str, asyncio.Future] = {}
        self._rate_limiter = AsyncTokenBucket(10, 10)

    async def place_order(self, params: Dict[str, Any], timeout: float = 5.0) -> Dict[str, Any]:
        await self._rate_limiter.acquire()
        await self._ensure_connected()

        req_id = uuid.uuid4().hex[:32]
        payload = {"id": req_id, "op": "order", "args": [params]}
        data = await self._send_request(req_id, payload, timeout)
        rows = data.get("data") or []
        first = rows[0] if rows else {}
        if data.get("code") != "0" or first.get("sCode", "0") != "0":
            raise WebSocketOrderError(first.get("sMsg") or data.get("msg") or str(data))
        return first

    async def _ensure_connected(self) -> None:
        if self._ws is not None and not self._ws.closed:
            return
        async with self._connect_lock:
            if self._ws is not None and not self._ws.closed:
                return
            await self._close()
            self._ws = await websockets.connect(self.url, ping_interval=20, ping_timeout=10)
            await self._login()
            self._reader_task = asyncio.create_task(self._reader_loop())

    async def _login(self) -> None:
        timestamp = str(time.time())
        message = f"{timestamp}GET/users/self/verify"
        signature = base64.b64encode(
            hmac.new(self.api_secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()
        ).decode()
        payload = {
            "op": "login",
            "args": [
                {
                    "apiKey": self.api_key,
                    "passphrase": self.password,
                    "timestamp": timestamp,
                    "sign": signature,
                }
            ],
        }
        await self._ws.send(json.dumps(payload))
        raw = await asyncio.wait_for(self._ws.recv(), timeout=5.0)
        data = json.loads(raw)
        if data.get("event") != "login" or data.get("code") != "0":
            raise WebSocketOrderError(f"OKX WS login failed: {data}")

    async def _send_request(self, req_id: str, payload: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[req_id] = future
        try:
            await self._ws.send(json.dumps(payload))
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise WebSocketOrderError(f"OKX WS request timed out after {timeout}s: id={req_id}") from exc
        finally:
            self._pending.pop(req_id, None)

    async def _reader_loop(self) -> None:
        try:
            async for raw in self._ws:
                if raw == "pong":
                    continue
                data = json.loads(raw)
                req_id = data.get("id")
                if req_id and req_id in self._pending:
                    future = self._pending[req_id]
                    if not future.done():
                        future.set_result(data)
                elif data.get("event") == "error" or data.get("code") not in (None, "0"):
                    if len(self._pending) == 1:
                        future = next(iter(self._pending.values()))
                        if not future.done():
                            future.set_exception(WebSocketOrderError(f"OKX WS error: {data}"))
                    elif self.logger:
                        self.logger.warning("okx_ws_unmatched_error", data=data)
        except Exception as exc:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(exc)
            self._pending.clear()
            await self._close(clear_reader=False)

    async def _close(self, clear_reader: bool = True) -> None:
        if clear_reader and self._reader_task:
            self._reader_task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None
