from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Set, Tuple

import websockets

from app.utils.logger import get_logger
from app.utils.websocket_manager import manager as ws_manager


logger = get_logger()

TickerKey = Tuple[str, str, str]  # exchange, symbol, category


@dataclass
class TickerSnapshot:
    exchange: str
    symbol: str
    category: str
    price: float
    timestamp: int
    source: str


class ChartTickerStream:
    """Streams public latest prices for 1-second chart aggregation."""

    def __init__(self) -> None:
        self._client_subscriptions: Dict[int, Set[TickerKey]] = {}
        self._ref_counts: Dict[TickerKey, int] = {}
        self._provider_subscriptions: Dict[str, Set[TickerKey]] = {}
        self._latest: Dict[TickerKey, TickerSnapshot] = {}
        self._provider_tasks: Dict[str, asyncio.Task] = {}
        self._provider_ws: Dict[str, Any] = {}
        self._broadcast_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def subscribe_client(self, client_id: int, raw_subscriptions: Iterable[Dict[str, Any]]) -> None:
        new_keys = {
            key
            for key in (self._parse_subscription(item) for item in raw_subscriptions)
            if key is not None
        }

        to_add: Set[TickerKey] = set()
        to_remove: Set[TickerKey] = set()

        async with self._lock:
            previous = self._client_subscriptions.get(client_id, set())
            to_add = new_keys - previous
            to_remove = previous - new_keys
            self._client_subscriptions[client_id] = new_keys

            for key in to_add:
                self._add_ref_locked(key)
            for key in to_remove:
                self._remove_ref_locked(key)

            self._ensure_broadcast_task_locked()

        for key in to_add:
            await self._send_provider_subscribe(key)
        for key in to_remove:
            await self._send_provider_unsubscribe(key)

    async def unsubscribe_client(self, client_id: int, raw_subscriptions: Optional[Iterable[Dict[str, Any]]] = None) -> None:
        async with self._lock:
            existing = self._client_subscriptions.get(client_id, set())
            if raw_subscriptions is None:
                to_remove = existing
                self._client_subscriptions.pop(client_id, None)
            else:
                requested = {
                    key
                    for key in (self._parse_subscription(item) for item in raw_subscriptions)
                    if key is not None
                }
                to_remove = existing & requested
                remaining = existing - to_remove
                if remaining:
                    self._client_subscriptions[client_id] = remaining
                else:
                    self._client_subscriptions.pop(client_id, None)

            for key in to_remove:
                self._remove_ref_locked(key)

        for key in to_remove:
            await self._send_provider_unsubscribe(key)

    def _parse_subscription(self, item: Dict[str, Any]) -> Optional[TickerKey]:
        exchange = str(item.get("exchange") or "").lower().strip()
        symbol = str(item.get("symbol") or "").upper().strip()
        category = self._normalize_category(str(item.get("category") or item.get("type") or "spot"))

        if not exchange or not symbol:
            return None

        return exchange, symbol, category

    def _add_ref_locked(self, key: TickerKey) -> None:
        self._ref_counts[key] = self._ref_counts.get(key, 0) + 1
        provider_key = self._provider_key(key)
        self._provider_subscriptions.setdefault(provider_key, set()).add(key)
        self._ensure_provider_task_locked(provider_key)

    def _remove_ref_locked(self, key: TickerKey) -> None:
        current = self._ref_counts.get(key, 0)
        if current <= 1:
            self._ref_counts.pop(key, None)
            self._latest.pop(key, None)
            provider_key = self._provider_key(key)
            provider_subs = self._provider_subscriptions.get(provider_key)
            if provider_subs is not None:
                provider_subs.discard(key)
        else:
            self._ref_counts[key] = current - 1

    def _ensure_provider_task_locked(self, provider_key: str) -> None:
        task = self._provider_tasks.get(provider_key)
        if task is None or task.done():
            self._provider_tasks[provider_key] = asyncio.create_task(self._provider_loop(provider_key))

    def _ensure_broadcast_task_locked(self) -> None:
        if self._broadcast_task is None or self._broadcast_task.done():
            self._broadcast_task = asyncio.create_task(self._broadcast_loop())

    async def _provider_loop(self, provider_key: str) -> None:
        while True:
            async with self._lock:
                has_subscriptions = bool(self._provider_subscriptions.get(provider_key))
            if not has_subscriptions:
                await asyncio.sleep(1)
                continue

            try:
                url = self._provider_url(provider_key)
                if not url:
                    logger.warning("chart_ticker_provider_unsupported", provider=provider_key)
                    await asyncio.sleep(5)
                    continue

                async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
                    self._provider_ws[provider_key] = ws
                    logger.info("chart_ticker_ws_connected", provider=provider_key)

                    if not self._provider_uses_url_streams(provider_key):
                        for key in list(self._provider_subscriptions.get(provider_key, set())):
                            await self._send_subscribe_message(provider_key, ws, key)

                    async for raw_message in ws:
                        await self._handle_provider_message(provider_key, raw_message)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("chart_ticker_ws_error", provider=provider_key, error=str(exc))
                await asyncio.sleep(2)
            finally:
                self._provider_ws.pop(provider_key, None)

    async def _send_provider_subscribe(self, key: TickerKey) -> None:
        provider_key = self._provider_key(key)
        ws = self._provider_ws.get(provider_key)
        if ws is None:
            return
        if self._provider_uses_url_streams(provider_key):
            await ws.close()
            return
        await self._send_subscribe_message(provider_key, ws, key)

    async def _send_provider_unsubscribe(self, key: TickerKey) -> None:
        provider_key = self._provider_key(key)
        ws = self._provider_ws.get(provider_key)
        if ws is None:
            return
        if self._provider_uses_url_streams(provider_key):
            await ws.close()
            return
        await self._send_unsubscribe_message(provider_key, ws, key)

    async def _send_subscribe_message(self, provider_key: str, ws: Any, key: TickerKey) -> None:
        payload = self._subscription_payload(provider_key, key, subscribe=True)
        if payload is not None:
            await ws.send(json.dumps(payload))

    async def _send_unsubscribe_message(self, provider_key: str, ws: Any, key: TickerKey) -> None:
        payload = self._subscription_payload(provider_key, key, subscribe=False)
        if payload is not None:
            await ws.send(json.dumps(payload))

    def _subscription_payload(self, provider_key: str, key: TickerKey, subscribe: bool) -> Optional[Dict[str, Any]]:
        exchange, symbol, category = key
        op = "subscribe" if subscribe else "unsubscribe"

        if exchange == "bybit":
            return {"op": op, "args": [f"tickers.{symbol}"]}

        if exchange == "binance":
            method = "SUBSCRIBE" if subscribe else "UNSUBSCRIBE"
            return {
                "method": method,
                "params": [f"{symbol.lower()}@ticker"],
                "id": int(time.time() * 1000000),
            }

        if exchange == "okx":
            return {
                "op": op,
                "args": [{
                    "channel": "tickers",
                    "instId": self._format_okx_symbol(symbol, category),
                }],
            }

        if exchange == "bitget":
            return {
                "op": op,
                "args": [{
                    "instType": "SPOT" if category == "spot" else "USDT-FUTURES",
                    "channel": "ticker",
                    "instId": symbol,
                }],
            }

        if exchange == "aster":
            method = "SUBSCRIBE" if subscribe else "UNSUBSCRIBE"
            return {
                "method": method,
                "params": [f"{symbol.lower()}@ticker"],
                "id": int(time.time() * 1000000),
            }

        return None

    async def _handle_provider_message(self, provider_key: str, raw_message: Any) -> None:
        if isinstance(raw_message, bytes):
            raw_message = raw_message.decode("utf-8")

        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            return

        if "result" in message or message.get("event") in {"subscribe", "unsubscribe"}:
            return
        if message.get("op") in {"subscribe", "unsubscribe"}:
            return
        if "stream" in message and isinstance(message.get("data"), dict):
            message = message["data"]

        exchange = provider_key.split(":", 1)[0]
        if exchange == "bybit":
            self._handle_bybit_message(provider_key, message)
        elif exchange == "binance":
            self._handle_binance_message(provider_key, message)
        elif exchange == "okx":
            self._handle_okx_message(message)
        elif exchange == "bitget":
            self._handle_bitget_message(message)
        elif exchange == "aster":
            self._handle_aster_message(provider_key, message)

    def _handle_bybit_message(self, provider_key: str, message: Dict[str, Any]) -> None:
        topic = str(message.get("topic") or "")
        if not topic.startswith("tickers."):
            return
        data = message.get("data") or {}
        if isinstance(data, list):
            data = data[0] if data else {}
        symbol = topic.split(".", 1)[1].upper()
        price = self._to_float(data.get("lastPrice"))
        timestamp = int(message.get("ts") or time.time() * 1000)
        category = provider_key.split(":", 1)[1] if ":" in provider_key else "linear"
        self._set_latest(("bybit", symbol, category), price, timestamp, "bybit:ticker")

    def _handle_binance_message(self, provider_key: str, message: Dict[str, Any]) -> None:
        if message.get("status") == 200 and "result" in message:
            result = message.get("result") or {}
            if isinstance(result, dict):
                symbol = str(result.get("symbol") or "").upper()
                price = self._to_float(result.get("price"))
                timestamp = int(result.get("time") or time.time() * 1000)
                self._set_latest(("binance", symbol, "linear"), price, timestamp, "binance:ticker.price")
            return

        event_type = message.get("e")
        if event_type not in {"24hrTicker", "aggTrade"}:
            return
        symbol = str(message.get("s") or "").upper()
        price = self._to_float(message.get("c") if event_type == "24hrTicker" else message.get("p"))
        timestamp = int(message.get("T") or message.get("E") or time.time() * 1000)
        category = provider_key.split(":", 1)[1] if ":" in provider_key else "spot"
        self._set_latest(("binance", symbol, category), price, timestamp, f"binance:{event_type}")

    def _handle_okx_message(self, message: Dict[str, Any]) -> None:
        arg = message.get("arg") or {}
        inst_id = str(arg.get("instId") or "")
        rows = message.get("data") or []
        if not inst_id or not rows:
            return
        row = rows[0]
        price = self._to_float(row.get("last"))
        timestamp = int(row.get("ts") or time.time() * 1000)
        key = self._find_key("okx", inst_id)
        if key:
            self._set_latest(key, price, timestamp, "okx:tickers")

    def _handle_bitget_message(self, message: Dict[str, Any]) -> None:
        arg = message.get("arg") or {}
        inst_id = str(arg.get("instId") or "").upper()
        inst_type = str(arg.get("instType") or "").upper()
        rows = message.get("data") or []
        if not inst_id or not rows:
            return
        row = rows[0]
        price = self._to_float(row.get("lastPr") or row.get("lastPrice") or row.get("last"))
        timestamp = int(row.get("ts") or row.get("systemTime") or time.time() * 1000)
        key = self._find_key("bitget", f"{inst_type}:{inst_id}")
        if key:
            self._set_latest(key, price, timestamp, "bitget:ticker")

    def _handle_aster_message(self, provider_key: str, message: Dict[str, Any]) -> None:
        payload = message.get("data") if isinstance(message.get("data"), dict) else message
        event_type = payload.get("e")
        if event_type not in {"24hrTicker", "aggTrade"}:
            return
        symbol = str(payload.get("s") or "").upper()
        price = self._to_float(payload.get("c") if event_type == "24hrTicker" else payload.get("p"))
        timestamp = int(payload.get("T") or payload.get("E") or time.time() * 1000)
        category = provider_key.split(":", 1)[1] if ":" in provider_key else "linear"
        self._set_latest(("aster", symbol, category), price, timestamp, f"aster:{event_type}")

    def _set_latest(self, key: TickerKey, price: Optional[float], timestamp: int, source: str) -> None:
        if price is None or price <= 0:
            return
        if key not in self._ref_counts:
            return
        exchange, symbol, category = key
        self._latest[key] = TickerSnapshot(exchange, symbol, category, price, timestamp, source)

    async def _broadcast_loop(self) -> None:
        while True:
            await asyncio.sleep(1)
            now = int(time.time() * 1000)

            async with self._lock:
                active_keys = set(self._ref_counts.keys())
                if not active_keys:
                    self._broadcast_task = None
                    return
                snapshots = [
                    self._latest[key]
                    for key in active_keys
                    if key in self._latest and now - self._latest[key].timestamp <= 10000
                ]

            for snapshot in snapshots:
                payload = json.dumps({
                    "type": "chartTickerUpdate",
                    "timestamp": now,
                    "data": {
                        "exchange": snapshot.exchange,
                        "symbol": snapshot.symbol,
                        "category": snapshot.category,
                        "price": snapshot.price,
                        "timestamp": now,
                        "providerTimestamp": snapshot.timestamp,
                        "source": snapshot.source,
                    },
                })
                await ws_manager.broadcast(payload)

    def _provider_key(self, key: TickerKey) -> str:
        exchange, _, category = key
        if exchange in {"bybit", "binance", "aster"}:
            return f"{exchange}:{category}"
        return exchange

    def _provider_uses_url_streams(self, provider_key: str) -> bool:
        return provider_key in {"binance:linear", "aster:linear", "aster:spot"}

    def _provider_url(self, provider_key: str) -> Optional[str]:
        exchange, _, category = provider_key.partition(":")

        if exchange == "bybit":
            channel = "spot" if category == "spot" else "linear"
            return f"wss://stream.bybit.com/v5/public/{channel}"
        if exchange == "binance":
            if category == "spot":
                return "wss://stream.binance.com:9443/ws"
            streams = self._build_url_streams(provider_key)
            return f"wss://fstream.binance.com/market/stream?streams={streams}" if streams else None
        if exchange == "okx":
            return "wss://ws.okx.com:8443/ws/v5/public"
        if exchange == "bitget":
            return "wss://ws.bitget.com/v2/ws/public"
        if exchange == "aster":
            streams = self._build_url_streams(provider_key)
            base_url = "wss://stream.asterdex.com" if category == "spot" else "wss://fstream.asterdex.com"
            return f"{base_url}/stream?streams={streams}" if streams else None
        return None

    def _build_url_streams(self, provider_key: str) -> str:
        keys = sorted(
            self._provider_subscriptions.get(provider_key, set()),
            key=lambda item: item[1],
        )
        return "/".join(f"{symbol.lower()}@ticker" for _, symbol, _ in keys)

    def _find_key(self, exchange: str, external_id: str) -> Optional[TickerKey]:
        for key in self._ref_counts.keys():
            key_exchange, symbol, category = key
            if key_exchange != exchange:
                continue
            if exchange == "okx" and self._format_okx_symbol(symbol, category) == external_id:
                return key
            if exchange == "bitget":
                inst_type = "SPOT" if category == "spot" else "USDT-FUTURES"
                if f"{inst_type}:{symbol}" == external_id:
                    return key
        return None

    def _format_okx_symbol(self, symbol: str, category: str) -> str:
        symbol = symbol.upper().strip()
        if "-" in symbol:
            return symbol
        quote = "USDT" if symbol.endswith("USDT") else "USD" if symbol.endswith("USD") else symbol[-4:]
        base = symbol[: -len(quote)] if quote and symbol.endswith(quote) else symbol
        if category == "spot":
            return f"{base}-{quote}"
        return f"{base}-{quote}-SWAP"

    def _normalize_category(self, category: str) -> str:
        category = category.lower().strip()
        if category in {"linear", "future", "futures", "perp", "swap"}:
            return "linear"
        return "spot"

    def _to_float(self, value: Any) -> Optional[float]:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None


chart_ticker_stream = ChartTickerStream()
