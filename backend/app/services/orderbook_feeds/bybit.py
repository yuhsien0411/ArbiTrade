from __future__ import annotations

import threading
import time
from typing import Dict, List, Tuple, Optional

from ...utils.logger import get_logger
from .base import BaseOrderBookFeed, OrderBookSnapshot, TopOfBookSnapshot, OrderBookDepth

try:
    from pybit.unified_trading import WebSocket
except Exception:  # 避免在未安裝時中斷導入
    WebSocket = None  # type: ignore


class OrderbookBook:
    """維護單一標的的本地 orderbook（僅儲存指定深度）。"""

    def __init__(self, depth: int) -> None:
        self.depth = depth
        self.bids: Dict[float, float] = {}
        self.asks: Dict[float, float] = {}
        self.u: Optional[int] = None

    def apply_snapshot(self, bids: List[List[str]], asks: List[List[str]], u: Optional[int]) -> None:
        self.bids.clear()
        self.asks.clear()
        for price_str, qty_str in bids:
            price = float(price_str)
            qty = float(qty_str)
            if qty > 0:
                self.bids[price] = qty
        for price_str, qty_str in asks:
            price = float(price_str)
            qty = float(qty_str)
            if qty > 0:
                self.asks[price] = qty
        self.u = u
        self._trim()

    def apply_delta(self, bids: List[List[str]], asks: List[List[str]], u: Optional[int]) -> None:
        for price_str, qty_str in bids:
            price = float(price_str)
            qty = float(qty_str)
            if qty <= 0:
                self.bids.pop(price, None)
            else:
                self.bids[price] = qty
        for price_str, qty_str in asks:
            price = float(price_str)
            qty = float(qty_str)
            if qty <= 0:
                self.asks.pop(price, None)
            else:
                self.asks[price] = qty
        self.u = u
        self._trim()

    def _trim(self) -> None:
        # 僅保留前 depth 檔
        if len(self.bids) > self.depth:
            for p in sorted(self.bids.keys(), reverse=True)[self.depth:]:
                self.bids.pop(p, None)
        if len(self.asks) > self.depth:
            for p in sorted(self.asks.keys())[: -(self.depth)]:
                # 此寫法保險，實際上僅保留前 depth
                pass
            for p in sorted(self.asks.keys())[self.depth:]:
                self.asks.pop(p, None)

    def best_bid_ask(self) -> Tuple[Optional[float], Optional[float]]:
        best_bid = max(self.bids.keys()) if self.bids else None
        best_ask = min(self.asks.keys()) if self.asks else None
        return best_bid, best_ask


class BybitOrderbookFeed(BaseOrderBookFeed):
    """Bybit 訂單簿 WS 訂閱器。支援 snapshot/delta，維護本地頂檔。"""

    def __init__(self, depth: OrderBookDepth = OrderBookDepth.TOP_1) -> None:
        super().__init__("Bybit", depth)
        self.ws_linear: Optional[WebSocket] = None
        self.ws_spot: Optional[WebSocket] = None
        self._lock = threading.Lock()
        # key: (category, symbol, depth)
        self._books: Dict[Tuple[str, str, int], OrderbookBook] = {}
        self._subscribed: set[Tuple[str, str, int]] = set()

    def _ensure_ws(self, category: str) -> None:
        if WebSocket is None:
            raise RuntimeError("pybit 未安裝，無法使用 WebSocket")
        if category == "linear" and self.ws_linear is None:
            self.ws_linear = WebSocket(testnet=False, channel_type="linear")
        if category == "spot" and self.ws_spot is None:
            self.ws_spot = WebSocket(testnet=False, channel_type="spot")

    async def start(self):
        """啟動 WebSocket 連接"""
        if self._running:
            return
        self._running = True
        self.logger.info("bybit_orderbook_feed_started")
    
    async def stop(self):
        """停止 WebSocket 連接"""
        self._running = False
        # 關閉所有 WebSocket 連接
        if self.ws_linear:
            self.ws_linear.exit()
        if self.ws_spot:
            self.ws_spot.exit()
        self.logger.info("bybit_orderbook_feed_stopped")
    
    async def subscribe(self, symbol: str, category: str = "linear") -> None:
        """訂閱指定品種的 orderbook 數據"""
        symbol = self._normalize_symbol(symbol)
        depth = 1  # 強制 1 檔
        self._ensure_ws(category)
        key = (category, symbol, depth)
        
        with self._lock:
            if key not in self._books:
                self._books[key] = OrderbookBook(depth=depth)
            # 已訂閱則不重複
            if key in self._subscribed:
                return

        def handle_message(message: dict) -> None:
            try:
                if not isinstance(message, dict):
                    return
                topic = message.get("topic", "")
                mtype = message.get("type")  # snapshot | delta
                data = message.get("data") or {}
                if not topic.startswith("orderbook."):
                    return
                # topic: orderbook.{depth}.{symbol}
                parts = topic.split(".")
                if len(parts) < 3:
                    return
                t_depth = int(parts[1])
                t_symbol = parts[2]
                k = (category, t_symbol, t_depth)
                book = self._books.get(k)
                if not book:
                    return
                bids = data.get("b") or []
                asks = data.get("a") or []
                u = data.get("u")
                # 僅處理 snapshot（1 檔 Bybit 只推 snapshot；若偶發 delta，忽略）
                if mtype == "snapshot":
                    book.apply_snapshot(bids, asks, u)
                    # 更新統一接口的數據
                    self._update_bybit_orderbook(t_symbol, category, book)
                else:
                    return
            except Exception as e:
                self.logger.error("bybit_orderbook_handle_error", error=str(e))

        # 根據類別選擇對應 ws
        ws = self.ws_linear if category == "linear" else self.ws_spot
        assert ws is not None
        ws.orderbook_stream(depth=depth, symbol=symbol, callback=handle_message)
        with self._lock:
            self._subscribed.add(key)
            self._subscribed_symbols.add(symbol)
        self.logger.info("bybit_orderbook_subscribed", category=category, symbol=symbol, depth=depth)
    
    async def unsubscribe(self, symbol: str, category: str = "linear") -> None:
        """取消訂閱交易對"""
        symbol = self._normalize_symbol(symbol)
        depth = 1
        key = (category, symbol, depth)
        
        with self._lock:
            if key in self._subscribed:
                self._subscribed.discard(key)
                self._subscribed_symbols.discard(symbol)
                # 清理數據
                self._cleanup_symbol_data(symbol)
        
        self.logger.info("bybit_orderbook_unsubscribed", category=category, symbol=symbol)

    def _storage_key(self, symbol: str, category: str) -> str:
        return f"{category}:{self._normalize_symbol(symbol)}"

    def get_top_of_book(self, symbol: str, category: str = "linear"):
        return super().get_top_of_book(self._storage_key(symbol, category))

    def get_top_of_book_snapshot(self, symbol: str, category: str = "linear"):
        return super().get_top_of_book_snapshot(self._storage_key(symbol, category))

    def _update_bybit_orderbook(self, symbol: str, category: str, book: OrderbookBook):
        """更新 Bybit orderbook 數據到統一接口"""
        symbol = self._normalize_symbol(symbol)
        storage_key = self._storage_key(symbol, category)
        
        # 獲取最優買賣價
        best_bid, best_ask = book.best_bid_ask()
        
        if best_bid and best_ask:
            # 更新最優買賣價快照
            top_book = TopOfBookSnapshot(
                symbol=storage_key,
                best_bid_price=best_bid,
                best_bid_qty=book.bids.get(best_bid, 0),
                best_ask_price=best_ask,
                best_ask_qty=book.asks.get(best_ask, 0),
                timestamp=int(time.time() * 1000),
                update_id=book.u
            )
            self._update_top_of_book(storage_key, top_book)
            
            # 如果支持完整訂單簿，也更新完整數據
            if self.depth.value > 1:
                # 構建完整訂單簿快照
                bids = [(price, qty) for price, qty in book.bids.items()]
                asks = [(price, qty) for price, qty in book.asks.items()]
                
                # 按價格排序
                bids.sort(reverse=True)  # 買價從高到低
                asks.sort()  # 賣價從低到高
                
                orderbook = OrderBookSnapshot(
                    symbol=storage_key,
                    bids=bids[:self.depth.value],
                    asks=asks[:self.depth.value],
                    timestamp=int(time.time() * 1000),
                    update_id=book.u
                )
                self._update_orderbook(storage_key, orderbook)
    
    async def _send_heartbeat(self):
        """發送心跳包（Bybit 不需要主動心跳）"""
        pass


# 全域單例
bybit_orderbook_feed = BybitOrderbookFeed()
