"""
Binance WebSocket 訂單簿數據流管理器
使用 @bookTicker 流獲取最優買賣價信息
支持現貨和合約市場
"""

import asyncio
import json
import time
import websockets
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass

from .base import BaseOrderBookFeed, TopOfBookSnapshot, OrderBookDepth
from ...utils.logger import get_logger

logger = get_logger()

class BinanceOrderBookFeed(BaseOrderBookFeed):
    """Binance WebSocket 最優買賣價數據流管理器（支持現貨和合約）"""
    
    def __init__(self, depth: OrderBookDepth = OrderBookDepth.TOP_1):
        """
        初始化 Binance 最優買賣價數據流
        使用 bookTicker 流獲取實時最優買賣價
        學習 Bybit 的設計：支持現貨和合約雙端點
        
        Args:
            depth: 訂單簿深度（Binance bookTicker 只支持最優買賣價）
        """
        super().__init__("Binance", depth)
        # 學習 Bybit：維護兩個 WebSocket 實例
        self._ws_spot = None       # 現貨 WebSocket
        self._ws_futures = None    # 合約 WebSocket
        self._ws_task_spot = None
        self._ws_task_futures = None
        # 記錄每個交易對的市場類型
        self._symbol_categories: Dict[str, str] = {}  # {symbol: category}
        self._subscribed: Set[Tuple[str, str]] = set()

    def _storage_key(self, symbol: str, category: str) -> str:
        return f"{category}:{self._normalize_symbol(symbol)}"

    def get_top_of_book(self, symbol: str, category: str = "spot"):
        return super().get_top_of_book(self._storage_key(symbol, category))

    def get_top_of_book_snapshot(self, symbol: str, category: str = "spot"):
        return super().get_top_of_book_snapshot(self._storage_key(symbol, category))
        
    async def start(self):
        """啟動 WebSocket 連接"""
        if self._running:
            return
            
        self._running = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        
        logger.info("binance_orderbook_feed_started")
    
    async def stop(self):
        """停止 WebSocket 連接"""
        self._running = False
        
        # 關閉兩個 WebSocket
        if self._ws_spot:
            await self._ws_spot.close()
        if self._ws_futures:
            await self._ws_futures.close()
            
        # 取消任務
        if self._ws_task_spot:
            self._ws_task_spot.cancel()
        if self._ws_task_futures:
            self._ws_task_futures.cancel()
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            
        logger.info("binance_orderbook_feed_stopped")
    
    async def subscribe(self, symbol: str, category: str = "spot"):
        """
        訂閱交易對的最優買賣價數據
        學習 Bybit：通過 category 參數選擇端點
        
        Args:
            symbol: 交易對符號
            category: 市場類型 ("spot" 或 "linear")
        """
        symbol = self._normalize_symbol(symbol)
        key = (category, symbol)
        
        if key in self._subscribed:
            return
            
        self._subscribed.add(key)
        self._subscribed_symbols.add(self._storage_key(symbol, category))
        self._symbol_categories[symbol] = category
        
        # 根據 category 選擇 WebSocket
        if category == "linear":
            # 合約：啟動合約 WebSocket（如果還沒啟動）
            if self._ws_task_futures is None:
                self._ws_task_futures = asyncio.create_task(self._ws_loop_futures())
                # 等待一小段時間讓 WebSocket 連接建立
                await asyncio.sleep(0.5)
            
            # 如果 WebSocket 已連接，發送訂閱
            if self._ws_futures and not self._ws_futures.closed:
                await self._send_subscribe(symbol, self._ws_futures)
        else:
            # 現貨：啟動現貨 WebSocket（如果還沒啟動）
            if self._ws_task_spot is None:
                self._ws_task_spot = asyncio.create_task(self._ws_loop_spot())
                # 等待一小段時間讓 WebSocket 連接建立
                await asyncio.sleep(0.5)
            
            # 如果 WebSocket 已連接，發送訂閱
            if self._ws_spot and not self._ws_spot.closed:
                await self._send_subscribe(symbol, self._ws_spot)
        
        logger.info("binance_orderbook_subscribed", symbol=symbol, category=category)
    
    async def unsubscribe(self, symbol: str, category: str = "spot"):
        """取消訂閱交易對"""
        symbol = self._normalize_symbol(symbol)
        
        key = (category, symbol)
        if key not in self._subscribed:
            return
            
        self._subscribed.discard(key)
        self._subscribed_symbols.discard(self._storage_key(symbol, category))
        if not any(subscribed_symbol == symbol for _, subscribed_symbol in self._subscribed):
            self._symbol_categories.pop(symbol, None)
        
        # 根據 category 選擇 WebSocket
        ws = self._ws_futures if category == "linear" else self._ws_spot
        
        # 如果 WebSocket 已連接，發送取消訂閱消息
        if ws and not ws.closed:
            await self._send_unsubscribe(symbol, ws)
        
        # 清理數據
        self._cleanup_symbol_data(self._storage_key(symbol, category))
        
        logger.info("binance_orderbook_unsubscribed", symbol=symbol, category=category)
    
    async def _ws_loop_spot(self):
        """現貨 WebSocket 主循環"""
        ws_url = "wss://stream.binance.com:9443/ws"
        while self._running:
            try:
                await self._connect_and_run(ws_url, is_futures=False)
            except Exception as e:
                logger.error("binance_spot_ws_error", error=str(e))
                await self._handle_reconnect(e)
    
    async def _ws_loop_futures(self):
        """合約 WebSocket 主循環"""
        ws_url = "wss://fstream.binance.com/ws"
        while self._running:
            try:
                await self._connect_and_run(ws_url, is_futures=True)
            except Exception as e:
                logger.error("binance_futures_ws_error", error=str(e))
                await self._handle_reconnect(e)
    
    async def _connect_and_run(self, ws_url: str, is_futures: bool):
        """連接 WebSocket 並處理消息"""
        try:
            market_type = "futures" if is_futures else "spot"
            logger.info("binance_ws_connecting", url=ws_url, type=market_type)
            
            async with websockets.connect(ws_url) as ws:
                # 保存 WebSocket 實例
                if is_futures:
                    self._ws_futures = ws
                else:
                    self._ws_spot = ws
                    
                self._reconnect_attempts = 0
                
                logger.info("binance_ws_connected", type=market_type)
                
                # 訂閱該市場類型的所有交易對
                symbols_to_subscribe = [
                    symbol for category, symbol in self._subscribed
                    if (category == "linear" and is_futures) or (category != "linear" and not is_futures)
                ]
                
                if symbols_to_subscribe:
                    logger.info("binance_ws_subscribing", 
                              symbols=symbols_to_subscribe, 
                              type=market_type)
                    for symbol in symbols_to_subscribe:
                        await self._send_subscribe(symbol, ws)
                else:
                    logger.info("binance_ws_no_symbols_to_subscribe", type=market_type)
                
                # 處理消息
                async for message in ws:
                    try:
                        await self._handle_message(message, "linear" if is_futures else "spot")
                    except Exception as e:
                        logger.error("binance_ws_message_error", error=str(e))
        except Exception as e:
            logger.error("binance_ws_connect_error", error=str(e), type=market_type)
            raise
    
    async def _send_subscribe(self, symbol: str, ws):
        """發送訂閱消息"""
        if not ws or ws.closed:
            return
            
        # 構建流名稱 - 使用 bookTicker
        stream_name = f"{symbol.lower()}@bookTicker"
        
        subscribe_msg = {
            "method": "SUBSCRIBE",
            "params": [stream_name],
            "id": int(time.time() * 1000000)  # 使用微秒確保唯一性
        }
        
        await ws.send(json.dumps(subscribe_msg))
        logger.debug("binance_ws_subscribe_sent", symbol=symbol, stream=stream_name)
    
    async def _send_unsubscribe(self, symbol: str, ws):
        """發送取消訂閱消息"""
        if not ws or ws.closed:
            return
            
        # 構建流名稱 - 使用 bookTicker
        stream_name = f"{symbol.lower()}@bookTicker"
        
        unsubscribe_msg = {
            "method": "UNSUBSCRIBE", 
            "params": [stream_name],
            "id": int(time.time() * 1000000)
        }
        
        await ws.send(json.dumps(unsubscribe_msg))
        logger.debug("binance_ws_unsubscribe_sent", symbol=symbol, stream=stream_name)
    
    async def _handle_message(self, message: str, category: str):
        """處理 WebSocket 消息"""
        try:
            data = json.loads(message)
            
            # 跳過訂閱確認消息
            if "result" in data or "id" in data:
                return
            
            # 處理 bookTicker 更新
            if data.get("e") == "bookTicker":
                await self._handle_book_ticker_update(data, category)
                
        except json.JSONDecodeError as e:
            logger.error("binance_ws_json_decode_error", error=str(e), message=message[:100])
    
    async def _handle_book_ticker_update(self, data: Dict, category: str):
        """處理 bookTicker 更新消息"""
        try:
            symbol = data.get("s", "").upper()
            if not symbol:
                return
            storage_key = self._storage_key(symbol, category)
            
            # 解析最優買賣價數據
            best_bid_price = float(data.get("b", 0))
            best_bid_qty = float(data.get("B", 0))
            best_ask_price = float(data.get("a", 0))
            best_ask_qty = float(data.get("A", 0))
            update_id = int(data.get("u", 0))
            
            # 更新最優買賣價快照
            top_book = TopOfBookSnapshot(
                symbol=storage_key,
                best_bid_price=best_bid_price,
                best_bid_qty=best_bid_qty,
                best_ask_price=best_ask_price,
                best_ask_qty=best_ask_qty,
                timestamp=int(time.time() * 1000),
                update_id=update_id
            )
            
            self._update_top_of_book(storage_key, top_book)
            
            # 記錄更新（低頻）
            if int(time.time()) % 10 == 0:  # 每 10 秒記錄一次
                logger.debug("binance_orderbook_updated",
                           symbol=symbol,
                           best_bid=best_bid_price,
                           best_ask=best_ask_price,
                           bid_qty=best_bid_qty,
                           ask_qty=best_ask_qty)
                
        except Exception as e:
            logger.error("binance_orderbook_update_error", error=str(e), data=data)
    
    async def _send_heartbeat(self):
        """發送心跳包"""
        try:
            # 向兩個 WebSocket 都發送心跳
            if self._ws_spot is not None and hasattr(self._ws_spot, 'open') and self._ws_spot.open:
                await self._ws_spot.ping()
                logger.debug("binance_spot_heartbeat_sent")
            
            if self._ws_futures is not None and hasattr(self._ws_futures, 'open') and self._ws_futures.open:
                await self._ws_futures.ping()
                logger.debug("binance_futures_heartbeat_sent")
        except Exception as e:
            logger.warning("binance_heartbeat_error", error=str(e))

# 全局實例
binance_orderbook_feed = BinanceOrderBookFeed()
