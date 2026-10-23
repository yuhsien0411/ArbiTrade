"""
Bitget WebSocket 訂單簿數據流管理器
使用 books1 流獲取最優買賣價信息（20-100ms 推送頻率）
"""

import asyncio
import json
import time
import zlib
import websockets
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass

from .base import BaseOrderBookFeed, TopOfBookSnapshot, OrderBookSnapshot, OrderBookDepth
from ...utils.logger import get_logger

logger = get_logger()


class BitgetOrderBookFeed(BaseOrderBookFeed):
    """Bitget WebSocket 訂單簿數據流管理器"""
    
    def __init__(self, depth: OrderBookDepth = OrderBookDepth.TOP_1, product_type: str = "USDT-FUTURES"):
        """
        初始化 Bitget 訂單簿數據流
        
        Args:
            depth: 訂單簿深度（TOP_1, TOP_5, TOP_10 等）
            product_type: 產品類型
                - USDT-FUTURES: U本位合約
                - COIN-FUTURES: 幣本位合約
                - USDC-FUTURES: USDC合約
        """
        super().__init__("Bitget", depth)
        self.product_type = product_type
        self.ws_url = "wss://ws.bitget.com/v2/ws/public"
        self._ws = None
        self._ping_interval = 30  # 30秒發送一次 ping
        
        # 根據深度選擇頻道
        self._channel = self._get_channel_name()
        
        # 高頻交易對列表（20ms 推送）
        self._high_freq_symbols = {
            'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'SUIUSDT',
            'DOGEUSDT', 'ADAUSDT', 'PEPEUSDT', 'LINKUSDT', 'HBARUSDT'
        }
        
    def _get_channel_name(self) -> str:
        """根據深度選擇頻道名稱"""
        if self.depth == OrderBookDepth.TOP_1:
            return "books1"
        elif self.depth == OrderBookDepth.TOP_5:
            return "books5"
        elif self.depth == OrderBookDepth.TOP_10 or self.depth == OrderBookDepth.TOP_20:
            return "books15"
        else:
            return "books15"
    
    async def start(self):
        """啟動 WebSocket 連接"""
        if self._running:
            return
            
        self._running = True
        self._reconnect_attempts = 0
        self._ws_task = asyncio.create_task(self._ws_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        
        logger.info("bitget_orderbook_feed_started", 
                   channel=self._channel,
                   product_type=self.product_type)
    
    async def stop(self):
        """停止 WebSocket 連接"""
        self._running = False
        
        if self._ws:
            try:
                await self._ws.close()
            except:
                pass
            
        if self._ws_task:
            self._ws_task.cancel()
            
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            
        logger.info("bitget_orderbook_feed_stopped")
    
    async def subscribe(self, symbol: str):
        """訂閱交易對的訂單簿數據"""
        symbol = self._normalize_symbol(symbol)
        
        if symbol in self._subscribed_symbols:
            return
            
        self._subscribed_symbols.add(symbol)
        
        # 如果 WebSocket 已連接，發送訂閱消息
        if self._ws and not self._ws.closed:
            await self._send_subscribe(symbol)
        
        push_freq = "20ms" if symbol in self._high_freq_symbols else "100ms"
        logger.info("bitget_orderbook_subscribed", 
                   symbol=symbol, 
                   channel=self._channel,
                   push_frequency=push_freq)
    
    async def unsubscribe(self, symbol: str):
        """取消訂閱交易對"""
        symbol = self._normalize_symbol(symbol)
        
        if symbol not in self._subscribed_symbols:
            return
            
        self._subscribed_symbols.discard(symbol)
        
        # 如果 WebSocket 已連接，發送取消訂閱消息
        if self._ws and not self._ws.closed:
            await self._send_unsubscribe(symbol)
        
        # 清理數據
        self._cleanup_symbol_data(symbol)
        
        logger.info("bitget_orderbook_unsubscribed", symbol=symbol)
    
    async def _ws_loop(self):
        """WebSocket 主循環"""
        while self._running:
            try:
                async with websockets.connect(self.ws_url) as ws:
                    self._ws = ws
                    self._reconnect_attempts = 0
                    
                    logger.info("bitget_orderbook_ws_connected")
                    
                    # 重新訂閱所有交易對
                    for symbol in self._subscribed_symbols.copy():
                        await self._send_subscribe(symbol)
                    
                    # 接收消息循環
                    async for message in ws:
                        if not self._running:
                            break
                        await self._handle_message(message)
                        
            except websockets.exceptions.ConnectionClosed:
                logger.warning("bitget_orderbook_ws_connection_closed")
                if self._running:
                    await self._handle_reconnect(Exception("Connection closed"))
            except Exception as e:
                logger.error("bitget_orderbook_ws_error", error=str(e))
                if self._running:
                    await self._handle_reconnect(e)
    
    async def _send_subscribe(self, symbol: str):
        """發送訂閱消息"""
        if not self._ws or self._ws.closed:
            return
        
        subscribe_msg = {
            "op": "subscribe",
            "args": [
                {
                    "instType": self.product_type,
                    "channel": self._channel,
                    "instId": symbol
                }
            ]
        }
        
        try:
            await self._ws.send(json.dumps(subscribe_msg))
            logger.debug("bitget_orderbook_subscribe_sent", 
                        symbol=symbol, 
                        channel=self._channel)
        except Exception as e:
            logger.error("bitget_orderbook_subscribe_failed", 
                        symbol=symbol, 
                        error=str(e))
    
    async def _send_unsubscribe(self, symbol: str):
        """發送取消訂閱消息"""
        if not self._ws or self._ws.closed:
            return
        
        unsubscribe_msg = {
            "op": "unsubscribe",
            "args": [
                {
                    "instType": self.product_type,
                    "channel": self._channel,
                    "instId": symbol
                }
            ]
        }
        
        try:
            await self._ws.send(json.dumps(unsubscribe_msg))
            logger.debug("bitget_orderbook_unsubscribe_sent", symbol=symbol)
        except Exception as e:
            logger.error("bitget_orderbook_unsubscribe_failed", 
                        symbol=symbol, 
                        error=str(e))
    
    async def _send_heartbeat(self):
        """發送心跳包"""
        try:
            # 檢查 WebSocket 連接是否存在且打開
            if self._ws is not None and hasattr(self._ws, 'open') and self._ws.open:
                ping_msg = "ping"
                await self._ws.send(ping_msg)
                logger.debug("bitget_orderbook_ping_sent")
        except Exception as e:
            logger.warning("bitget_orderbook_ping_failed", error=str(e))
    
    async def _handle_message(self, message: str):
        """處理接收到的消息"""
        try:
            # 處理 pong 消息
            if message == "pong":
                logger.debug("bitget_orderbook_pong_received")
                return
            
            # 解析 JSON 消息
            data = json.loads(message)
            
            # 處理訂閱確認
            if data.get("event") == "subscribe":
                logger.info("bitget_orderbook_subscription_confirmed", 
                           channel=data.get("arg", {}).get("channel"),
                           symbol=data.get("arg", {}).get("instId"))
                return
            
            # 處理錯誤消息
            if data.get("event") == "error":
                logger.error("bitget_orderbook_error_received", 
                           code=data.get("code"),
                           msg=data.get("msg"))
                return
            
            # 處理訂單簿數據推送
            if "data" in data and "arg" in data:
                await self._process_orderbook_data(data)
                
        except json.JSONDecodeError as e:
            logger.error("bitget_orderbook_json_decode_error", 
                        error=str(e), 
                        message=message[:100])
        except Exception as e:
            logger.error("bitget_orderbook_message_handling_error", 
                        error=str(e))
    
    async def _process_orderbook_data(self, data: dict):
        """處理訂單簿數據"""
        try:
            arg = data.get("arg", {})
            symbol = arg.get("instId", "").upper()
            action = data.get("action", "snapshot")
            
            if not symbol:
                return
            
            orderbook_list = data.get("data", [])
            if not orderbook_list:
                return
            
            orderbook_data = orderbook_list[0]
            
            # 解析時間戳
            timestamp = int(orderbook_data.get("ts", int(time.time() * 1000)))
            
            # 解析 bids 和 asks
            bids_raw = orderbook_data.get("bids", [])
            asks_raw = orderbook_data.get("asks", [])
            
            # 轉換為 (price, quantity) 元組列表
            bids = [(float(price), float(qty)) for price, qty in bids_raw]
            asks = [(float(price), float(qty)) for price, qty in asks_raw]
            
            # 確保排序（bids 降序，asks 升序）
            bids.sort(reverse=True, key=lambda x: x[0])
            asks.sort(key=lambda x: x[0])
            
            # 獲取序列號（用於檢測亂序）
            seq = orderbook_data.get("seq")
            
            # 根據 channel 類型處理
            if self._channel == "books1" and bids and asks:
                # books1 只有最優買賣價，直接更新
                top_book = TopOfBookSnapshot(
                    symbol=symbol,
                    best_bid_price=bids[0][0],
                    best_bid_qty=bids[0][1],
                    best_ask_price=asks[0][0],
                    best_ask_qty=asks[0][1],
                    timestamp=timestamp,
                    update_id=seq
                )
                self._update_top_of_book(symbol, top_book)
                
                logger.debug("bitget_orderbook_top_updated",
                           symbol=symbol,
                           bid=bids[0][0],
                           ask=asks[0][0],
                           spread=asks[0][0] - bids[0][0])
            else:
                # books5/books15 有多檔深度
                orderbook = OrderBookSnapshot(
                    symbol=symbol,
                    bids=bids,
                    asks=asks,
                    timestamp=timestamp,
                    update_id=seq
                )
                self._update_orderbook(symbol, orderbook)
                
                logger.debug("bitget_orderbook_updated",
                           symbol=symbol,
                           bids_count=len(bids),
                           asks_count=len(asks),
                           action=action)
            
        except Exception as e:
            logger.error("bitget_orderbook_process_data_error", 
                        error=str(e),
                        data=str(data)[:200])
    
    def _normalize_symbol(self, symbol: str) -> str:
        """標準化交易對符號
        
        Bitget 格式：BTCUSDT
        """
        # 移除可能的分隔符
        symbol = symbol.upper().replace("/", "").replace("-", "").replace("_", "")
        
        # 移除合約後綴（如果有）
        if ":USDT" in symbol:
            symbol = symbol.replace(":USDT", "")
        
        return symbol


# 全局單例實例
_bitget_orderbook_feed: Optional[BitgetOrderBookFeed] = None


def bitget_orderbook_feed(
    depth: OrderBookDepth = OrderBookDepth.TOP_1,
    product_type: str = "USDT-FUTURES"
) -> BitgetOrderBookFeed:
    """
    獲取 Bitget OrderBook Feed 單例
    
    Args:
        depth: 訂單簿深度
        product_type: 產品類型（USDT-FUTURES, COIN-FUTURES, USDC-FUTURES）
    
    Returns:
        BitgetOrderBookFeed 實例
    """
    global _bitget_orderbook_feed
    
    if _bitget_orderbook_feed is None:
        _bitget_orderbook_feed = BitgetOrderBookFeed(depth, product_type)
    
    return _bitget_orderbook_feed

