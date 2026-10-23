"""
OrderBook Feeds 模組（V2统一架构）
提供各交易所的 OrderBook 數據流實現

V2改进：
- 所有feed只提供bid1/ask1数据
- 统一接口：get_top_of_book(symbol) -> (bid, ask)
- 通过UnifiedPriceService统一调用，避免直接使用
"""

from .base import BaseOrderBookFeed, OrderBookSnapshot, TopOfBookSnapshot, OrderBookDepth
from .binance import BinanceOrderBookFeed, binance_orderbook_feed
from .bybit import BybitOrderbookFeed, bybit_orderbook_feed
from .bitget import BitgetOrderBookFeed, bitget_orderbook_feed
from .okx import OKXOrderBookFeed, okx_orderbook_feed
from .aster import AsterOrderBookFeed, aster_orderbook_feed

__all__ = [
    'BaseOrderBookFeed',
    'OrderBookSnapshot', 
    'TopOfBookSnapshot',
    'OrderBookDepth',
    'BinanceOrderBookFeed',
    'binance_orderbook_feed',
    'BybitOrderbookFeed',
    'bybit_orderbook_feed',
    'BitgetOrderBookFeed',
    'bitget_orderbook_feed',
    'OKXOrderBookFeed',
    'okx_orderbook_feed',
    'AsterOrderBookFeed',
    'aster_orderbook_feed',
]
