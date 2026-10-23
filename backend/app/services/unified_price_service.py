"""
统一价格服务 - V2架构核心组件
提供统一的价格获取接口，封装所有交易所的价格获取逻辑
只提供bid1/ask1数据，简化架构
"""

from __future__ import annotations

import asyncio
import time
from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

from app.utils.logger import get_logger

logger = get_logger()


class PriceSource(Enum):
    """价格数据来源"""
    WEBSOCKET = "websocket"  # WebSocket实时推送
    HTTP = "http"  # HTTP轮询
    CACHE = "cache"  # 缓存数据


@dataclass
class TopOfBook:
    """最优买卖价数据结构"""
    symbol: str
    exchange: str
    bid_price: float
    bid_qty: float
    ask_price: float
    ask_qty: float
    timestamp: int
    source: PriceSource
    
    @property
    def spread(self) -> float:
        """价差"""
        return self.ask_price - self.bid_price
    
    @property
    def spread_percent(self) -> float:
        """价差百分比"""
        if self.bid_price > 0:
            return (self.spread / self.bid_price) * 100
        return 0.0
    
    @property
    def mid_price(self) -> float:
        """中间价"""
        return (self.bid_price + self.ask_price) / 2
    
    def is_valid(self) -> bool:
        """检查数据是否有效"""
        return (self.bid_price > 0 and 
                self.ask_price > 0 and 
                self.bid_qty > 0 and 
                self.ask_qty > 0 and
                self.ask_price >= self.bid_price)
    
    def is_fresh(self, max_age_ms: int = 5000) -> bool:
        """检查数据是否新鲜（未过期）"""
        current_time = int(time.time() * 1000)
        return (current_time - self.timestamp) < max_age_ms


class UnifiedPriceService:
    """
    统一价格服务
    
    职责：
    1. 统一管理所有交易所的价格数据源（WebSocket + HTTP）
    2. 提供统一的价格查询接口
    3. 自动选择最优数据源（优先WebSocket，回退HTTP）
    4. 缓存管理和数据验证
    """
    
    def __init__(self):
        self.logger = get_logger()
        
        # 价格缓存：key = (exchange, symbol, category)
        self._price_cache: Dict[Tuple[str, str, str], TopOfBook] = {}
        
        # WebSocket feeds（延迟初始化）
        self._ws_feeds: Dict[str, any] = {}
        
        # HTTP fallback（延迟初始化）
        self._http_fetcher = None
        
        self.logger.info("unified_price_service_initialized")
    
    def _get_cache_key(self, exchange: str, symbol: str, category: str = "spot") -> Tuple[str, str, str]:
        """生成缓存键（包含category以区分现货和合约）"""
        return (exchange.lower(), symbol.upper(), category.lower())
    
    async def get_top_of_book(
        self, 
        exchange: str, 
        symbol: str,
        category: str = "spot",
        max_age_ms: int = 5000
    ) -> Optional[TopOfBook]:
        """
        获取最优买卖价（统一接口）
        
        Args:
            exchange: 交易所名称（bybit/binance/okx/bitget）
            symbol: 交易对符号
            category: 交易类型（spot/linear）
            max_age_ms: 最大数据年龄（毫秒）
        
        Returns:
            TopOfBook对象，如果无法获取则返回None
        """
        cache_key = self._get_cache_key(exchange, symbol, category)
        
        # 1. 尝试从WebSocket获取
        ws_price = await self._get_from_websocket(exchange, symbol, category)
        if ws_price and ws_price.is_valid() and ws_price.is_fresh(max_age_ms):
            self._price_cache[cache_key] = ws_price
            return ws_price
        
        # 2. 检查缓存（如果WebSocket数据不可用）
        cached_price = self._price_cache.get(cache_key)
        if cached_price and cached_price.is_valid() and cached_price.is_fresh(max_age_ms):
            return cached_price
        
        # 3. 回退到HTTP获取
        http_price = await self._get_from_http(exchange, symbol, category)
        if http_price and http_price.is_valid():
            self._price_cache[cache_key] = http_price
            return http_price
        
        # 4. 所有方式都失败
        self.logger.warning("unified_price_service_no_data", 
                          exchange=exchange, 
                          symbol=symbol,
                          category=category)
        return None
    
    async def _get_from_websocket(
        self, 
        exchange: str, 
        symbol: str,
        category: str
    ) -> Optional[TopOfBook]:
        """从WebSocket获取价格"""
        try:
            exchange_lower = exchange.lower()
            
            # 延迟导入，避免循环依赖
            if exchange_lower == "bybit":
                from .orderbook_feeds.bybit import bybit_orderbook_feed
                feed = bybit_orderbook_feed
            elif exchange_lower == "binance":
                from .orderbook_feeds.binance import binance_orderbook_feed
                feed = binance_orderbook_feed
            elif exchange_lower == "bitget":
                from .orderbook_feeds.bitget import bitget_orderbook_feed
                feed = bitget_orderbook_feed()  # Bitget使用工厂函数
            elif exchange_lower == "okx":
                from .orderbook_feeds.okx import okx_orderbook_feed
                feed = okx_orderbook_feed
            elif exchange_lower == "aster":
                from .orderbook_feeds.aster import aster_orderbook_feed
                feed = aster_orderbook_feed
            elif exchange_lower == "mexc":
                return None
            else:
                self.logger.warning("unified_price_service_unsupported_exchange", 
                                  exchange=exchange)
                return None
            
            # 获取最优买卖价
            if exchange_lower == "okx":
                await feed.start()
                await feed.subscribe(symbol, category=category)
                deadline = time.time() + 0.8
                while time.time() < deadline:
                    bid_price, ask_price = feed.get_top_of_book(symbol, category)
                    if bid_price and ask_price and bid_price > 0 and ask_price > 0:
                        return TopOfBook(
                            symbol=symbol.upper(),
                            exchange=exchange_lower,
                            bid_price=bid_price,
                            bid_qty=1.0,
                            ask_price=ask_price,
                            ask_qty=1.0,
                            timestamp=int(time.time() * 1000),
                            source=PriceSource.WEBSOCKET
                        )
                    await asyncio.sleep(0.05)

            if exchange_lower in ("bybit", "binance"):
                bid_price, ask_price = feed.get_top_of_book(symbol, category)
            elif exchange_lower == "okx":
                bid_price, ask_price = feed.get_top_of_book(symbol, category)
            else:
                bid_price, ask_price = feed.get_top_of_book(symbol)
            
            if bid_price and ask_price and bid_price > 0 and ask_price > 0:
                return TopOfBook(
                    symbol=symbol.upper(),
                    exchange=exchange_lower,
                    bid_price=bid_price,
                    bid_qty=1.0,  # WebSocket feeds may only expose top prices; keep the quote valid.
                    ask_price=ask_price,
                    ask_qty=1.0,
                    timestamp=int(time.time() * 1000),
                    source=PriceSource.WEBSOCKET
                )
            
            return None
            
        except Exception as e:
            self.logger.warning("unified_price_service_ws_error", 
                              exchange=exchange,
                              symbol=symbol,
                              error=str(e))
            return None
    
    async def _get_from_http(
        self, 
        exchange: str, 
        symbol: str,
        category: str
    ) -> Optional[TopOfBook]:
        """从HTTP API获取价格"""
        try:
            # 延迟导入，避免循环依赖
            from app.api.routes_prices import _fetch_orderbook
            
            orderbook = await _fetch_orderbook(exchange, symbol, category=category)
            
            if not orderbook:
                return None
            
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            
            if not bids or not asks:
                return None
            
            bid_price = float(bids[0][0])
            bid_qty = float(bids[0][1])
            ask_price = float(asks[0][0])
            ask_qty = float(asks[0][1])
            
            if bid_price > 0 and ask_price > 0:
                return TopOfBook(
                    symbol=symbol.upper(),
                    exchange=exchange.lower(),
                    bid_price=bid_price,
                    bid_qty=bid_qty,
                    ask_price=ask_price,
                    ask_qty=ask_qty,
                    timestamp=int(time.time() * 1000),
                    source=PriceSource.HTTP
                )
            
            return None
            
        except Exception as e:
            self.logger.error("unified_price_service_http_error", 
                            exchange=exchange,
                            symbol=symbol,
                            error=str(e))
            return None
    
    def get_cached_price(
        self, 
        exchange: str, 
        symbol: str,
        category: str = "spot",
        max_age_ms: int = 5000
    ) -> Optional[TopOfBook]:
        """
        获取缓存的价格（同步方法，不触发新的获取）
        
        Args:
            exchange: 交易所名称
            symbol: 交易对符号
            category: 交易类型（spot/linear）
            max_age_ms: 最大数据年龄（毫秒）
        
        Returns:
            TopOfBook对象，如果缓存不存在或已过期则返回None
        """
        cache_key = self._get_cache_key(exchange, symbol, category)
        cached_price = self._price_cache.get(cache_key)
        
        if cached_price and cached_price.is_valid() and cached_price.is_fresh(max_age_ms):
            return cached_price
        
        return None
    
    def clear_cache(self, exchange: Optional[str] = None, symbol: Optional[str] = None, category: Optional[str] = None):
        """
        清除缓存
        
        Args:
            exchange: 如果指定，只清除该交易所的缓存
            symbol: 如果指定，只清除该交易对的缓存
            category: 如果指定，只清除该交易类型的缓存
        """
        if exchange is None and symbol is None and category is None:
            # 清除所有缓存
            self._price_cache.clear()
            self.logger.info("unified_price_service_cache_cleared_all")
        elif exchange and symbol and category:
            # 清除特定交易对和类型的缓存
            cache_key = self._get_cache_key(exchange, symbol, category)
            self._price_cache.pop(cache_key, None)
            self.logger.info("unified_price_service_cache_cleared", 
                           exchange=exchange, 
                           symbol=symbol,
                           category=category)
        elif exchange:
            # 清除特定交易所的所有缓存（可选过滤category）
            keys_to_remove = [k for k in self._price_cache.keys() 
                            if k[0] == exchange.lower() and 
                            (category is None or k[2] == category.lower())]
            for key in keys_to_remove:
                self._price_cache.pop(key, None)
            self.logger.info("unified_price_service_cache_cleared_exchange", 
                           exchange=exchange,
                           category=category,
                           count=len(keys_to_remove))
    
    def get_cache_stats(self) -> Dict[str, any]:
        """获取缓存统计信息"""
        total = len(self._price_cache)
        valid = sum(1 for price in self._price_cache.values() if price.is_valid())
        fresh = sum(1 for price in self._price_cache.values() if price.is_fresh())
        
        return {
            "total_cached": total,
            "valid_count": valid,
            "fresh_count": fresh,
            "exchanges": list(set(k[0] for k in self._price_cache.keys())),
            "categories": list(set(k[2] for k in self._price_cache.keys()))
        }


# 全局单例
unified_price_service = UnifiedPriceService()
