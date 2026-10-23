"""
統一 OrderBook Feed 抽象基類
定義所有交易所的 orderbook 數據流統一接口
"""

import asyncio
from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass
from enum import Enum

from ...utils.logger import get_logger

logger = get_logger()


class OrderBookDepth(Enum):
    """訂單簿深度選項"""
    TOP_1 = 1      # 僅最優買賣價
    TOP_5 = 5      # 前5檔
    TOP_10 = 10    # 前10檔
    TOP_20 = 20    # 前20檔
    TOP_50 = 50    # 前50檔


@dataclass
class OrderBookSnapshot:
    """訂單簿快照數據"""
    symbol: str
    bids: List[Tuple[float, float]]  # [(price, quantity), ...]
    asks: List[Tuple[float, float]]  # [(price, quantity), ...]
    timestamp: int
    update_id: Optional[int] = None
    
    @property
    def best_bid(self) -> Optional[Tuple[float, float]]:
        """最佳買價"""
        return self.bids[0] if self.bids else None
    
    @property
    def best_ask(self) -> Optional[Tuple[float, float]]:
        """最佳賣價"""
        return self.asks[0] if self.asks else None
    
    @property
    def spread(self) -> Optional[float]:
        """價差"""
        if self.best_bid and self.best_ask:
            return self.best_ask[0] - self.best_bid[0]
        return None
    
    @property
    def spread_percent(self) -> Optional[float]:
        """價差百分比"""
        if self.best_bid and self.best_ask and self.best_bid[0] > 0:
            return (self.spread / self.best_bid[0]) * 100
        return None


@dataclass
class TopOfBookSnapshot:
    """最優買賣價快照（輕量級）"""
    symbol: str
    best_bid_price: float
    best_bid_qty: float
    best_ask_price: float
    best_ask_qty: float
    timestamp: int
    update_id: Optional[int] = None
    
    @property
    def spread(self) -> float:
        """價差"""
        return self.best_ask_price - self.best_bid_price
    
    @property
    def spread_percent(self) -> float:
        """價差百分比"""
        if self.best_bid_price > 0:
            return (self.spread / self.best_bid_price) * 100
        return 0.0


class BaseOrderBookFeed(ABC):
    """統一 OrderBook Feed 抽象基類"""
    
    def __init__(self, exchange_name: str, depth: OrderBookDepth = OrderBookDepth.TOP_1):
        self.exchange_name = exchange_name
        self.depth = depth
        self.logger = get_logger()
        
        # 數據存儲
        self._orderbooks: Dict[str, OrderBookSnapshot] = {}
        self._top_of_book: Dict[str, TopOfBookSnapshot] = {}
        self._subscribed_symbols: Set[str] = set()
        
        # 連接狀態
        self._running = False
        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 5
        
        # 任務管理
        self._ws_task = None
        self._heartbeat_task = None
    
    @abstractmethod
    async def start(self):
        """啟動 WebSocket 連接"""
        pass
    
    @abstractmethod
    async def stop(self):
        """停止 WebSocket 連接"""
        pass
    
    @abstractmethod
    async def subscribe(self, symbol: str):
        """訂閱交易對的 orderbook 數據"""
        pass
    
    @abstractmethod
    async def unsubscribe(self, symbol: str):
        """取消訂閱交易對"""
        pass
    
    def get_orderbook(self, symbol: str) -> Optional[OrderBookSnapshot]:
        """獲取完整訂單簿快照"""
        symbol = symbol.upper()
        return self._orderbooks.get(symbol)
    
    def get_top_of_book(self, symbol: str) -> Tuple[Optional[float], Optional[float]]:
        """
        獲取最優買賣價
        
        Returns:
            (best_bid, best_ask) 或 (None, None) 如果沒有數據
        """
        symbol = symbol.upper()
        top_book = self._top_of_book.get(symbol)
        
        if not top_book:
            return None, None
            
        return top_book.best_bid_price, top_book.best_ask_price
    
    def get_top_of_book_snapshot(self, symbol: str) -> Optional[TopOfBookSnapshot]:
        """獲取最優買賣價快照"""
        symbol = symbol.upper()
        return self._top_of_book.get(symbol)
    
    def is_data_available(self, symbol: str, max_age_ms: int = 5000) -> bool:
        """檢查是否有該交易對的數據且未過期"""
        symbol = symbol.upper()
        
        # 檢查完整訂單簿
        orderbook = self._orderbooks.get(symbol)
        if orderbook:
            current_time = int(asyncio.get_event_loop().time() * 1000)
            return (current_time - orderbook.timestamp) < max_age_ms
        
        # 檢查最優買賣價
        top_book = self._top_of_book.get(symbol)
        if top_book:
            current_time = int(asyncio.get_event_loop().time() * 1000)
            return (current_time - top_book.timestamp) < max_age_ms
        
        return False
    
    def get_subscribed_symbols(self) -> Set[str]:
        """獲取已訂閱的交易對"""
        return self._subscribed_symbols.copy()
    
    def is_running(self) -> bool:
        """檢查是否正在運行"""
        return self._running
    
    # 內部方法（子類可覆蓋）
    
    def _normalize_symbol(self, symbol: str) -> str:
        """標準化交易對符號"""
        return symbol.upper().strip()
    
    def _update_orderbook(self, symbol: str, orderbook: OrderBookSnapshot):
        """更新訂單簿數據"""
        symbol = self._normalize_symbol(symbol)
        self._orderbooks[symbol] = orderbook
        
        # 同時更新最優買賣價
        if orderbook.best_bid and orderbook.best_ask:
            self._top_of_book[symbol] = TopOfBookSnapshot(
                symbol=symbol,
                best_bid_price=orderbook.best_bid[0],
                best_bid_qty=orderbook.best_bid[1],
                best_ask_price=orderbook.best_ask[0],
                best_ask_qty=orderbook.best_ask[1],
                timestamp=orderbook.timestamp,
                update_id=orderbook.update_id
            )
    
    def _update_top_of_book(self, symbol: str, top_book: TopOfBookSnapshot):
        """更新最優買賣價數據"""
        symbol = self._normalize_symbol(symbol)
        self._top_of_book[symbol] = top_book
    
    def _cleanup_symbol_data(self, symbol: str):
        """清理指定交易對的數據"""
        symbol = self._normalize_symbol(symbol)
        self._orderbooks.pop(symbol, None)
        self._top_of_book.pop(symbol, None)
    
    async def _handle_reconnect(self, error: Exception):
        """處理重連邏輯"""
        if self._reconnect_attempts < self._max_reconnect_attempts:
            self._reconnect_attempts += 1
            wait_time = min(2 ** self._reconnect_attempts, 30)
            self.logger.info(f"{self.exchange_name}_orderbook_reconnecting", 
                           attempt=self._reconnect_attempts,
                           wait_time=wait_time,
                           error=str(error))
            await asyncio.sleep(wait_time)
        else:
            self.logger.error(f"{self.exchange_name}_orderbook_max_reconnect_reached")
            self._running = False
    
    async def _heartbeat_loop(self):
        """心跳循環，檢查連接狀態"""
        while self._running:
            try:
                await asyncio.sleep(30)  # 每 30 秒檢查一次
                await self._send_heartbeat()
            except Exception as e:
                self.logger.warning(f"{self.exchange_name}_orderbook_heartbeat_error", error=str(e))
    
    @abstractmethod
    async def _send_heartbeat(self):
        """發送心跳包（子類實現）"""
        pass
    
    def __str__(self) -> str:
        status = "運行中" if self._running else "已停止"
        symbols_count = len(self._subscribed_symbols)
        return f"{self.exchange_name}OrderBookFeed({status}, 訂閱{symbols_count}個交易對)"
    
    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(exchange={self.exchange_name}, depth={self.depth.value}, running={self._running})"
