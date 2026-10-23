"""
Aster WebSocket 訂單簿數據流管理器
使用 @bookTicker 流獲取最優買賣價信息
"""

import asyncio
import json
import time
from typing import Dict, Optional

import websockets

from .base import BaseOrderBookFeed, TopOfBookSnapshot, OrderBookDepth
from ...utils.logger import get_logger

logger = get_logger()


class AsterOrderBookFeed(BaseOrderBookFeed):
    """Aster WebSocket 最優買賣價數據流管理器"""

    def __init__(self, depth: OrderBookDepth = OrderBookDepth.TOP_1):
        super().__init__("Aster", depth)
        self.ws_url = "wss://fstream.asterdex.com/ws"
        self._ws = None
        self._request_id = 1
        self._id_lock = asyncio.Lock()
        self._ws_loop_task = None

    async def start(self):
        """啟動 WebSocket 連接"""
        if self._running:
            return

        self._running = True
        self._reconnect_attempts = 0
        self._ws_loop_task = asyncio.create_task(self._ws_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        logger.info("aster_orderbook_feed_started", ws_url=self.ws_url)

    async def stop(self):
        """停止 WebSocket 連接"""
        self._running = False

        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass

        if self._ws_loop_task:
            self._ws_loop_task.cancel()

        if self._heartbeat_task:
            self._heartbeat_task.cancel()

        logger.info("aster_orderbook_feed_stopped")

    async def subscribe(self, symbol: str):
        """訂閱交易對最優買賣價"""
        symbol = self._normalize_symbol(symbol)
        if symbol in self._subscribed_symbols:
            return

        self._subscribed_symbols.add(symbol)

        if self._ws and not self._ws.closed:
            await self._send_subscribe([symbol])

        logger.info("aster_orderbook_subscribed", symbol=symbol)

    async def unsubscribe(self, symbol: str):
        """取消訂閱交易對"""
        symbol = self._normalize_symbol(symbol)
        if symbol not in self._subscribed_symbols:
            return

        self._subscribed_symbols.discard(symbol)

        if self._ws and not self._ws.closed:
            await self._send_unsubscribe([symbol])

        self._cleanup_symbol_data(symbol)
        logger.info("aster_orderbook_unsubscribed", symbol=symbol)

    async def _next_request_id(self) -> int:
        async with self._id_lock:
            self._request_id += 1
            return self._request_id

    async def _ws_loop(self):
        """WebSocket 主循環（含重連與重訂閱）"""
        while self._running:
            try:
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    self._ws = ws
                    self._reconnect_attempts = 0

                    logger.info("aster_orderbook_ws_connected")

                    if self._subscribed_symbols:
                        await self._send_subscribe(list(self._subscribed_symbols))

                    async for message in ws:
                        if not self._running:
                            break
                        await self._handle_message(message)

            except websockets.exceptions.ConnectionClosed:
                logger.warning("aster_orderbook_ws_connection_closed")
                if self._running:
                    await self._handle_reconnect(Exception("Aster ws closed"))
            except Exception as e:
                logger.error("aster_orderbook_ws_error", error=str(e))
                if self._running:
                    await self._handle_reconnect(e)
            finally:
                self._ws = None

    async def _send_subscribe(self, symbols: list[str]):
        if not self._ws or self._ws.closed or not symbols:
            return

        params = [f"{symbol.lower()}@bookTicker" for symbol in symbols]
        req_id = await self._next_request_id()
        payload = {"method": "SUBSCRIBE", "params": params, "id": req_id}
        await self._ws.send(json.dumps(payload))
        logger.debug("aster_orderbook_subscribe_sent", params=params, id=req_id)

    async def _send_unsubscribe(self, symbols: list[str]):
        if not self._ws or self._ws.closed or not symbols:
            return

        params = [f"{symbol.lower()}@bookTicker" for symbol in symbols]
        req_id = await self._next_request_id()
        payload = {"method": "UNSUBSCRIBE", "params": params, "id": req_id}
        await self._ws.send(json.dumps(payload))
        logger.debug("aster_orderbook_unsubscribe_sent", params=params, id=req_id)

    async def _send_heartbeat(self):
        """
        發送心跳。
        Aster 文檔要求客戶端可回 pong 保活；websockets 會自動回覆 ping，
        這裡額外主動送 pong 作為保險。
        """
        try:
            if self._ws is not None and hasattr(self._ws, "open") and self._ws.open:
                await self._ws.pong()
                logger.debug("aster_orderbook_pong_sent")
        except Exception as e:
            logger.warning("aster_orderbook_heartbeat_error", error=str(e))

    async def _handle_message(self, message: str):
        try:
            data = json.loads(message)

            # 訂閱回覆/控制回覆
            if "result" in data and "id" in data:
                return

            # 可能是 combined stream 包裝
            if "data" in data and isinstance(data.get("data"), dict):
                payload = data["data"]
            else:
                payload = data

            if payload.get("e") == "bookTicker":
                await self._handle_book_ticker(payload)

        except json.JSONDecodeError:
            logger.error("aster_orderbook_json_decode_error", message=message[:120])
        except Exception as e:
            logger.error("aster_orderbook_message_error", error=str(e))

    async def _handle_book_ticker(self, payload: Dict):
        symbol = str(payload.get("s", "")).upper()
        if not symbol:
            return

        best_bid_price = float(payload.get("b", 0.0))
        best_bid_qty = float(payload.get("B", 0.0))
        best_ask_price = float(payload.get("a", 0.0))
        best_ask_qty = float(payload.get("A", 0.0))
        update_id = int(payload.get("u", 0))
        timestamp = int(payload.get("E", int(time.time() * 1000)))

        if best_bid_price <= 0 or best_ask_price <= 0:
            return

        top_book = TopOfBookSnapshot(
            symbol=symbol,
            best_bid_price=best_bid_price,
            best_bid_qty=best_bid_qty,
            best_ask_price=best_ask_price,
            best_ask_qty=best_ask_qty,
            timestamp=timestamp,
            update_id=update_id,
        )
        self._update_top_of_book(symbol, top_book)


# 全局單例
aster_orderbook_feed = AsterOrderBookFeed()

