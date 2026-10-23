"""
OKX OrderBook WebSocket Feed
使用 bbo-tbt 頻道獲取最快的 1檔深度數據（10ms推送）
"""

import asyncio
import json
import time
from typing import Optional, Dict, Callable
import websockets

from .base import BaseOrderBookFeed, OrderBookSnapshot, TopOfBookSnapshot, OrderBookDepth
from ...utils.logger import get_logger


class OKXOrderBookFeed(BaseOrderBookFeed):
    """OKX OrderBook WebSocket Feed
    
    使用 bbo-tbt 頻道：
    - 首次推 1檔快照
    - 以後定量推送，每10ms當1檔快照數據有變化推送一次
    - 延遲極低，適合高頻套利
    """
    
    WS_URL = "wss://ws.okx.com:8443/ws/v5/public"
    MAX_TOP_OF_BOOK_AGE_SECONDS = 5.0
    
    def __init__(self):
        super().__init__(exchange_name="okx", depth=OrderBookDepth.TOP_1)
        self._ws = None
        self._subscriptions: Dict[str, Callable] = {}  # category:symbol -> callback
        self._task = None
        self._ping_task = None
    
    def _normalize_symbol(self, symbol: str, category: str = "linear") -> str:
        """標準化交易對符號
        
        統一格式 -> OKX 格式：
        - BTCUSDT -> BTC-USDT-SWAP
        - ETHUSDT -> ETH-USDT-SWAP
        """
        symbol = symbol.upper().strip()

        if category == "spot":
            if '-SWAP' in symbol:
                symbol = symbol.replace('-SWAP', '')
            if '-' in symbol:
                return symbol
            if symbol.endswith('USDT'):
                base = symbol[:-4]
                return f"{base}-USDT"
            if symbol.endswith('USDC'):
                base = symbol[:-4]
                return f"{base}-USDC"
            if symbol.endswith('USD'):
                base = symbol[:-3]
                return f"{base}-USD"
            return symbol
        
        # 如果已經是 OKX 格式，直接返回
        if '-SWAP' in symbol:
            return symbol
        
        # 轉換為 OKX 格式
        if symbol.endswith('USDT'):
            base = symbol[:-4]
            return f"{base}-USDT-SWAP"
        elif symbol.endswith('USD'):
            base = symbol[:-3]
            return f"{base}-USD-SWAP"
        else:
            # 其他情況
            if len(symbol) > 6:
                return f"{symbol[:-4]}-{symbol[-4:]}-SWAP"
            return f"{symbol}-SWAP"
    
    def _denormalize_symbol(self, okx_symbol: str) -> str:
        """OKX 格式 -> 統一格式
        
        - BTC-USDT-SWAP -> BTCUSDT
        - ETH-USDT-SWAP -> ETHUSDT
        """
        return okx_symbol.replace('-SWAP', '').replace('-', '')

    def _category_from_inst_id(self, inst_id: str) -> str:
        return "linear" if "-SWAP" in inst_id else "spot"

    def _subscription_key(self, symbol: str, category: str = "linear") -> str:
        return f"{category}:{symbol.upper()}"
    
    async def start(self):
        """啟動 WebSocket 連接"""
        if self._running:
            self.logger.debug("okx_orderbook_feed_already_running")
            return
        
        self._running = True
        self._task = asyncio.create_task(self._run())
        self.logger.info("okx_orderbook_feed_started", ws_url=self.WS_URL)
    
    async def stop(self):
        """停止 WebSocket 連接"""
        self._running = False
        
        if self._ping_task:
            self._ping_task.cancel()
            try:
                await self._ping_task
            except asyncio.CancelledError:
                pass
        
        if self._ws:
            await self._ws.close()
        
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        
        self.logger.info("okx_orderbook_feed_stopped")
    
    async def subscribe(self, symbol: str, callback: Optional[Callable] = None, category: str = "linear"):
        """訂閱交易對的 OrderBook
        
        Args:
            symbol: 統一格式交易對，如 BTCUSDT
            callback: 可選的回調函數
        """
        okx_symbol = self._normalize_symbol(symbol, category)
        unified_symbol = symbol.upper()
        key = self._subscription_key(unified_symbol, category)
        
        self._subscriptions[key] = callback
        
        # 如果 WebSocket 已連接，發送訂閱消息
        if self._ws:
            subscribe_msg = {
                "op": "subscribe",
                "args": [{
                    "channel": "bbo-tbt",
                    "instId": okx_symbol
                }]
            }
            await self._ws.send(json.dumps(subscribe_msg))
            self.logger.info("okx_orderbook_subscribed", 
                           symbol=unified_symbol,
                           category=category,
                           okx_symbol=okx_symbol)
    
    async def unsubscribe(self, symbol: str, category: str = "linear"):
        """取消訂閱交易對"""
        okx_symbol = self._normalize_symbol(symbol, category)
        unified_symbol = symbol.upper()
        key = self._subscription_key(unified_symbol, category)
        
        if key in self._subscriptions:
            del self._subscriptions[key]
        
        # 發送取消訂閱消息
        if self._ws:
            unsubscribe_msg = {
                "op": "unsubscribe",
                "args": [{
                    "channel": "bbo-tbt",
                    "instId": okx_symbol
                }]
            }
            await self._ws.send(json.dumps(unsubscribe_msg))
            self.logger.info("okx_orderbook_unsubscribed",
                           symbol=unified_symbol,
                           category=category,
                           okx_symbol=okx_symbol)
    
    def get_top_of_book(self, symbol: str, category: str = "linear"):
        """獲取最新的 Top of Book 數據
        
        Returns:
            Tuple[Optional[float], Optional[float]]: (bid_price, ask_price) 或 (None, None)
        """
        unified_symbol = symbol.upper()
        key = self._subscription_key(unified_symbol, category)
        snapshot = self._orderbooks.get(key)
        
        if not snapshot:
            return None, None
        
        # 檢查數據是否過期
        age = time.time() - snapshot.timestamp
        if age > self.MAX_TOP_OF_BOOK_AGE_SECONDS:
            self.logger.warning("okx_orderbook_data_stale",
                              symbol=unified_symbol,
                              age=age)
            return None, None
        
        if not snapshot.bids or not snapshot.asks:
            return None, None
        
        return snapshot.bids[0][0], snapshot.asks[0][0]
    
    async def _run(self):
        """主運行循環"""
        while self._running:
            try:
                async with websockets.connect(
                    self.WS_URL,
                    ping_interval=20,
                    ping_timeout=10
                ) as ws:
                    self._ws = ws
                    self.logger.info("okx_websocket_connected")
                    
                    # 重新訂閱所有交易對
                    for key in list(self._subscriptions.keys()):
                        category, symbol = key.split(":", 1)
                        callback = self._subscriptions.get(key)
                        await self.subscribe(symbol, callback=callback, category=category)
                    
                    # 啟動 ping 任務
                    self._ping_task = asyncio.create_task(self._ping_loop())
                    
                    # 接收消息
                    async for message in ws:
                        await self._handle_message(message)
                        
            except websockets.exceptions.ConnectionClosed:
                self.logger.warning("okx_websocket_connection_closed")
            except Exception as e:
                self.logger.error("okx_websocket_error", error=str(e))
            
            # 重連延遲
            if self._running:
                self.logger.info("okx_websocket_reconnecting")
                await asyncio.sleep(5)
    
    async def _send_heartbeat(self):
        """發送心跳（OKX 使用 ping/pong）
        
        實現 BaseOrderBookFeed 的抽象方法
        """
        try:
            # 檢查 WebSocket 連接是否存在且打開
            if self._ws is not None and hasattr(self._ws, 'open') and self._ws.open:
                await self._ws.send("ping")
                self.logger.debug("okx_heartbeat_sent")
        except Exception as e:
            self.logger.error("okx_heartbeat_error", error=str(e))
    
    async def _ping_loop(self):
        """定期發送 ping"""
        try:
            while self._running and self._ws:
                await self._send_heartbeat()
                await asyncio.sleep(20)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.logger.error("okx_ping_error", error=str(e))
    
    async def _handle_message(self, message: str):
        """處理 WebSocket 消息"""
        try:
            # OKX 的 pong 是純字符串
            if message == "pong":
                return
            
            data = json.loads(message)
            
            # 處理訂閱確認
            if data.get('event') == 'subscribe':
                self.logger.info("okx_subscription_confirmed",
                               channel=data.get('arg', {}).get('channel'),
                               instId=data.get('arg', {}).get('instId'))
                return
            
            # 處理錯誤
            if data.get('event') == 'error':
                self.logger.error("okx_subscription_error",
                                code=data.get('code'),
                                msg=data.get('msg'))
                return
            
            # 處理 orderbook 數據
            if 'data' in data and 'arg' in data:
                arg = data['arg']
                channel = arg.get('channel')
                inst_id = arg.get('instId')
                
                if channel == 'bbo-tbt':
                    await self._handle_bbo_update(inst_id, data['data'])
                    
        except json.JSONDecodeError:
            self.logger.error("okx_invalid_json", message=message[:100])
        except Exception as e:
            self.logger.error("okx_message_handler_error",
                            error=str(e),
                            message=message[:200])
    
    async def _handle_bbo_update(self, inst_id: str, data_list: list):
        """處理 bbo-tbt 更新
        
        OKX bbo-tbt 格式:
        {
            "arg": {"channel": "bbo-tbt", "instId": "BTC-USDT-SWAP"},
            "data": [{
                "asks": [["67432.8", "3.046", "0", "1"]],
                "bids": [["67432.7", "4.428", "0", "2"]],
                "ts": "1597026383085",
                "seqId": "123456"
            }]
        }
        """
        try:
            unified_symbol = self._denormalize_symbol(inst_id)
            category = self._category_from_inst_id(inst_id)
            key = self._subscription_key(unified_symbol, category)
            
            for item in data_list:
                bids_raw = item.get('bids', [])
                asks_raw = item.get('asks', [])
                timestamp_ms = int(item.get('ts', 0))
                
                if not bids_raw or not asks_raw:
                    continue
                
                # OKX 格式: [price, qty, liquidated_orders, num_orders]
                # 我們只需要前2個
                bids = [(float(b[0]), float(b[1])) for b in bids_raw]
                asks = [(float(a[0]), float(a[1])) for a in asks_raw]
                
                # 更新 orderbook
                snapshot = OrderBookSnapshot(
                    symbol=unified_symbol,
                    bids=bids,
                    asks=asks,
                    timestamp=timestamp_ms / 1000.0
                )
                
                self._orderbooks[key] = snapshot
                
                # 調用回調
                callback = self._subscriptions.get(key)
                if callback:
                    try:
                        if asyncio.iscoroutinefunction(callback):
                            await callback(snapshot)
                        else:
                            callback(snapshot)
                    except Exception as e:
                        self.logger.error("okx_callback_error",
                                        symbol=unified_symbol,
                                        error=str(e))
                        
        except Exception as e:
            self.logger.error("okx_bbo_update_error",
                            inst_id=inst_id,
                            error=str(e))


# 全局单例
okx_orderbook_feed = OKXOrderBookFeed()
