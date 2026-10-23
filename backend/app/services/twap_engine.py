"""
TWAP 交易引擎
整合現有的 TWAP 交易器到 Python 後端
使用統一交易所抽象接口
"""

import time
import logging
import os
import json
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from decimal import Decimal
import asyncio
from datetime import datetime, timedelta
import uuid

from ..utils.logger import get_logger
from ..config.env import config
from ..models.twap import TwapPlan, TwapProgress, TwapExecution, TwapState
from ..exchanges import ExchangeFactory, OrderSide, OrderType, TradeType

try:
    # 即時推播到前端（與 arbitrage_engine 相同手法）
    from ..utils.websocket_manager import manager as ws_manager
except Exception:
    ws_manager = None  # 測試環境避免循環依賴

logger = get_logger()


@dataclass
class ExchangeConfig:
    """交易所配置類"""
    api_key: str
    api_secret: str
    symbol: str
    testnet: bool = False
    demo: bool = True


@dataclass
class OrderResult:
    """訂單執行結果類"""
    success: bool
    price: Optional[Decimal]
    order_id: Optional[str]
    error_message: Optional[str] = None
    order_transport: Optional[str] = None


class TWAPEngine:
    """TWAP 交易引擎主類"""
    
    def __init__(self):
        self.logger = logger
        self.plans: Dict[str, TwapPlan] = {}
        self.progress: Dict[str, TwapProgress] = {}
        self.executions: Dict[str, List[TwapExecution]] = {}
        self._running_tasks: Dict[str, asyncio.Task] = {}
        
        # 準備 JSONL 持久化目錄 data/twap
        try:
            base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
            self._data_dir = os.path.join(base_dir, 'data', 'twap')
            os.makedirs(self._data_dir, exist_ok=True)
        except Exception as e:
            self._data_dir = os.path.join(os.getcwd(), 'data', 'twap')
            try:
                os.makedirs(self._data_dir, exist_ok=True)
            except Exception:
                pass
        
        # 不再需要初始化特定交易所客戶端，使用統一接口
        self.logger.info("twap_engine_initialized_unified", 
                        success=True,
                        message="使用統一交易所抽象接口")
    
    def _jsonl_path(self) -> str:
        """獲取當日 TWAP 執行記錄 JSONL 文件路徑"""
        day_str = time.strftime('%Y%m%d')
        return os.path.join(self._data_dir, f'executions_{day_str}.jsonl')
    
    def _append_jsonl(self, record: Dict[str, Any]) -> None:
        """追加記錄到當日 JSONL 日檔"""
        try:
            path = self._jsonl_path()
            with open(path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception as e:
            self.logger.error("twap_jsonl_append_failed", error=str(e))

    def _broadcast_ws(self, event_type: str, data: Dict[str, Any]) -> None:
        """將 TWAP 事件推送到前端 WS。

        對齊前端 `services/websocket.ts` 內 handler：
        - twapExecuted
        - twapPlanCompleted
        - twapPlanFailed
        """
        if ws_manager is None:
            return
        try:
            payload = json.dumps({"type": event_type, "data": data})
            asyncio.create_task(ws_manager.broadcast(payload))
        except RuntimeError:
            # 沒有事件迴圈時忽略（例如 CLI/測試環境）
            pass
        except Exception as e:
            self.logger.error("twap_ws_broadcast_failed", event=event_type, error=str(e))

    def _safe_price_float(self, value: Any) -> Optional[float]:
        """Return a positive price float, or None for empty/invalid exchange values."""
        if value in (None, "", []):
            return None
        try:
            price = float(value)
        except (TypeError, ValueError):
            return None
        return price if price > 0 else None
    
    def _append_unified_execution_record(
        self,
        plan_id: str,
        slice_index: int,
        plan: TwapPlan,
        legs_results: List[dict],
        all_success: bool,
        error_message: Optional[str] = None
    ) -> None:
        """追加統一格式的執行記錄（Pairs風格）
        
        V3 改進：將單次 slice 的兩條腿合併為一條完整記錄
        
        Args:
            plan_id: 計劃ID
            slice_index: slice索引
            plan: TWAP計劃
            legs_results: 所有腿的執行結果列表
            all_success: 是否全部成功
            error_message: 錯誤信息（如果失敗）
        """
        try:
            # 提取兩條腿的結果
            legs_by_index = {
                int(item.get("leg_index", index)): item
                for index, item in enumerate(legs_results)
            }
            leg0_result = legs_by_index.get(0)
            leg1_result = legs_by_index.get(1)

            if not leg0_result:
                self.logger.warning("twap_unified_record_no_leg0", planId=plan_id, sliceIndex=slice_index)
            
            # 計算價差
            spread = None
            spread_percent = None
            
            if leg0_result and leg1_result:
                order_result_0 = leg0_result['order_result']
                order_result_1 = leg1_result['order_result']
                
                price0 = self._safe_price_float(order_result_0.price)
                price1 = self._safe_price_float(order_result_1.price)
                if price0 and price1:
                    leg0 = leg0_result['leg']
                    leg1 = leg1_result['leg']
                    
                    # 根據交易方向計算價差
                    if leg0.side == "buy" and leg1.side == "sell":
                        # leg0買入，leg1賣出：價差 = 賣出價 - 買入價
                        spread = price1 - price0
                    elif leg0.side == "sell" and leg1.side == "buy":
                        # leg0賣出，leg1買入：價差 = 賣出價 - 買入價
                        spread = price0 - price1
                    else:
                        # 其他情況
                        spread = price0 - price1
                    
                    # 計算價差百分比
                    avg_price = (price0 + price1) / 2
                    spread_percent = (spread / avg_price) * 100 if avg_price > 0 else 0
            
            # 構建統一格式記錄
            # 統一欄位說明：
            # - mode:          策略類型（twap / pair）
            # - strategyId:    前端/報表用的統一 ID（這裡等於 twapId）
            # - totalTriggers: 第幾次執行（從 1 開始，與 pairs 統一）
            record = {
                "ts": int(time.time() * 1000),
                "mode": "twap",
                "strategyId": plan_id,
                "planId": plan_id,   # 與 pairs 的 pairId 對應，供前端統一識別
                "pairId": None,
                "twapId": plan_id,
                # 統一：第幾次執行（從 1 開始）
                "totalTriggers": slice_index + 1,
                "status": "success" if all_success else "failed",
                "reason": None,
                "error": error_message if not all_success and error_message else None,
                "qty": plan.sliceQty,
                "spread": spread,
                "spreadPercent": spread_percent,
                # 配置信息
                "totalAmount": plan.totalQty,
                "orderCount": int(plan.totalQty / plan.sliceQty) if plan.sliceQty > 0 else 0,
                "threshold": None,  # TWAP 不使用 threshold
                "intervalMs": plan.intervalMs,
                # 回滾相關欄位：正常執行時為 False
                "isRollback": False,
            }
            
            # 添加 leg1 信息（若缺少實際下單結果，使用 plan 配置補齊）
            if leg0_result:
                order_result = leg0_result['order_result']
                leg = leg0_result['leg']
                record["leg1"] = {
                    "exchange": getattr(leg, "exchange", "bybit"),
                    "symbol": leg.symbol,
                    "type": getattr(leg, "category", "spot"),
                    "side": leg.side,
                    "orderId": order_result.order_id,
                    "orderTransport": getattr(order_result, "order_transport", None),
                    "price": self._safe_price_float(order_result.price),
                    "priceUpdated": self._safe_price_float(order_result.price) is not None,
                    "originalOrderId": None
                }
            elif len(plan.legs) > 0:
                planned_leg = plan.legs[0]
                record["leg1"] = {
                    "exchange": getattr(planned_leg, "exchange", "bybit"),
                    "symbol": planned_leg.symbol,
                    "type": getattr(planned_leg, "category", "spot"),
                    "side": planned_leg.side,
                    "orderId": None,
                    "price": None,
                    "priceUpdated": False,
                    "originalOrderId": None
                }
            else:
                record["leg1"] = None
            
            # 添加 leg2 信息（若缺少實際下單結果，使用 plan 配置補齊）
            if leg1_result:
                order_result = leg1_result['order_result']
                leg = leg1_result['leg']
                record["leg2"] = {
                    "exchange": getattr(leg, "exchange", "bybit"),
                    "symbol": leg.symbol,
                    "type": getattr(leg, "category", "spot"),
                    "side": leg.side,
                    "orderId": order_result.order_id,
                    "orderTransport": getattr(order_result, "order_transport", None),
                    "price": self._safe_price_float(order_result.price),
                    "priceUpdated": self._safe_price_float(order_result.price) is not None,
                    "originalOrderId": None
                }
            elif len(plan.legs) > 1:
                planned_leg = plan.legs[1]
                record["leg2"] = {
                    "exchange": getattr(planned_leg, "exchange", "bybit"),
                    "symbol": planned_leg.symbol,
                    "type": getattr(planned_leg, "category", "spot"),
                    "side": planned_leg.side,
                    "orderId": None,
                    "price": None,
                    "priceUpdated": False,
                    "originalOrderId": None
                }
            else:
                record["leg2"] = None
            
            # 寫入 JSONL 文件
            self._append_jsonl(record)
            
            self.logger.info("twap_unified_record_written",
                           planId=plan_id,
                           sliceIndex=slice_index,
                           status=record["status"],
                           spread=spread,
                           spreadPercent=spread_percent)
            
        except Exception as e:
            self.logger.error("twap_unified_record_write_failed",
                            planId=plan_id,
                            sliceIndex=slice_index,
                            error=str(e))
    
    def _append_unified_rollback_record(
        self,
        plan_id: str,
        slice_index: int,
        plan: TwapPlan,
        rollback_results: List[dict]
    ) -> None:
        """追加統一格式的回滾記錄
        
        V3 改進：回滾記錄採用 Pairs 風格，明確標記為 rolled_back
        
        Args:
            plan_id: 計劃ID
            slice_index: slice索引（-1表示緊急回滾）
            plan: TWAP計劃
            rollback_results: 回滾結果列表
        """
        try:
            # 構建統一格式回滾記錄
            record = {
                "ts": int(time.time() * 1000),
                "mode": "twap",
                "strategyId": plan_id,
                "planId": plan_id,   # 與 pairs 的 pairId 對應，供前端統一識別
                "pairId": None,
                "twapId": plan_id,
                # 統一：第幾次執行（從 1 開始）
                "totalTriggers": slice_index + 1 if slice_index >= 0 else 1,
                "status": "rolled_back",  # ✅ 明確標記為回滾
                "reason": "rollback",
                "error": None,
                "qty": plan.sliceQty,
                "spread": None,
                "spreadPercent": None,
                # 配置信息
                "totalAmount": plan.totalQty,
                "orderCount": int(plan.totalQty / plan.sliceQty) if plan.sliceQty > 0 else 0,
                "threshold": None,
                "intervalMs": plan.intervalMs,
                # 回滾標記
                "isRollback": True,
            }
            
            # 添加回滾的腿信息
            for i, rollback_info in enumerate(rollback_results):
                leg_key = f"leg{i+1}"
                order_result = rollback_info['order_result']
                leg = rollback_info['leg']
                original_order_id = rollback_info.get('original_order_id')
                
                record[leg_key] = {
                    "exchange": getattr(leg, "exchange", "bybit"),
                    "symbol": leg.symbol,
                    "type": getattr(leg, "category", "spot"),
                    "side": leg.side,
                    "orderId": order_result.order_id,
                    "originalOrderId": original_order_id,  # ✅ 記錄原始訂單ID
                    "price": self._safe_price_float(order_result.price),
                    "priceUpdated": self._safe_price_float(order_result.price) is not None
                }
            
            # 如果只回滾了一條腿，leg2 設為 None
            if len(rollback_results) < 2:
                record["leg2"] = None
            if not rollback_results:
                record["leg1"] = None
                record["leg2"] = None
            
            # 寫入 JSONL 文件
            self._append_jsonl(record)
            
            self.logger.info("twap_unified_rollback_record_written",
                           planId=plan_id,
                           sliceIndex=slice_index,
                           rollbackLegsCount=len(rollback_results))
            
        except Exception as e:
            self.logger.error("twap_unified_rollback_record_write_failed",
                            planId=plan_id,
                            sliceIndex=slice_index,
                            error=str(e))
    
    def _append_cancelled_record(self, plan_id: str) -> None:
        """追加取消狀態記錄
        
        V3 改進：當 TWAP 策略被手動取消時，寫入 cancelled 狀態記錄
        用於歷史記錄中標記該策略已被手動取消
        
        Args:
            plan_id: 計劃ID
        """
        try:
            if plan_id not in self.plans:
                self.logger.warning("twap_cancelled_record_plan_not_found", planId=plan_id)
                return
            
            plan = self.plans[plan_id]
            progress = self.progress.get(plan_id)
            
            # 構建 cancelled 記錄
            record = {
                "ts": int(time.time() * 1000),
                "mode": "twap",
                "strategyId": plan_id,
                "planId": plan_id,   # 與 pairs 的 pairId 對應，供前端統一識別
                "pairId": None,
                "twapId": plan_id,
                # 統一：第幾次執行（從 1 開始）
                "totalTriggers": (progress.slicesDone if progress else 0) + 1,
                "status": "cancelled",  # ✅ 明確標記為手動取消
                "reason": "manual",
                "error": None,
                "qty": plan.sliceQty,
                "spread": None,
                "spreadPercent": None,
                # 配置信息
                "totalAmount": plan.totalQty,
                "orderCount": int(plan.totalQty / plan.sliceQty) if plan.sliceQty > 0 else 0,
                "threshold": None,
                "intervalMs": plan.intervalMs,
                "isRollback": False,
                # leg1 和 leg2 為 null（因為沒有實際執行）
                "leg1": None,
                "leg2": None,
            }
            
            # 寫入 JSONL
            self._append_jsonl(record)
            
            self.logger.info("twap_cancelled_record_written",
                           planId=plan_id,
                           slicesDone=progress.slicesDone if progress else 0,
                           slicesTotal=progress.slicesTotal if progress else 0)
            
        except Exception as e:
            self.logger.error("twap_cancelled_record_write_failed",
                            planId=plan_id,
                            error=str(e))
    
    def _convert_legacy_format_to_unified(self, legacy_records: List[dict]) -> List[dict]:
        """將舊格式記錄（單腿）轉換為新格式（完整記錄）
        
        V3 向後兼容：將舊的單腿記錄配對成完整記錄
        
        Args:
            legacy_records: 舊格式記錄列表（包含 legIndex 欄位）
        
        Returns:
            轉換後的統一格式記錄列表
        """
        try:
            # 按 planId + sliceIndex 分組
            from collections import defaultdict
            grouped = defaultdict(list)
            
            for record in legacy_records:
                if 'legIndex' in record:  # 舊格式記錄
                    key = (record.get('planId'), record.get('sliceIndex', 0))
                    grouped[key].append(record)
            
            # 轉換為新格式
            unified_records = []
            for (plan_id, slice_index), legs in grouped.items():
                # 找出 leg0 和 leg1
                leg0 = next((l for l in legs if l.get('legIndex') == 0), None)
                leg1 = next((l for l in legs if l.get('legIndex') == 1), None)
                
                if not leg0:
                    continue  # 沒有 leg0，跳過
                
                # 計算價差
                spread = None
                spread_percent = None
                price0 = self._safe_price_float(leg0.get('price')) if leg0 else None
                price1 = self._safe_price_float(leg1.get('price')) if leg1 else None
                if leg0 and leg1 and price0 and price1:
                    side0 = leg0.get('side', '')
                    side1 = leg1.get('side', '')
                    
                    if side0 == "buy" and side1 == "sell":
                        spread = price1 - price0
                    elif side0 == "sell" and side1 == "buy":
                        spread = price0 - price1
                    else:
                        spread = price0 - price1
                    
                    avg_price = (price0 + price1) / 2
                    spread_percent = (spread / avg_price) * 100 if avg_price > 0 else 0
                
                # 構建統一格式記錄
                unified_record = {
                    "ts": leg0.get('ts', int(time.time() * 1000)),
                    "mode": "twap",
                    "strategyId": plan_id,
                    "planId": plan_id,   # 與 pairs 的 pairId 對應，供前端統一識別
                    "pairId": None,
                    "twapId": plan_id,
                    # 統一：第幾次執行（從 1 開始）
                    "totalTriggers": slice_index + 1,
                    "status": "success" if (leg0.get('success') and (not leg1 or leg1.get('success'))) else "failed",
                    "reason": None,
                    "error": leg0.get('error') or (leg1.get('error') if leg1 else None),
                    "qty": leg0.get('qty', 0),
                    "spread": spread,
                    "spreadPercent": spread_percent,
                    # 舊格式沒有這些欄位，使用預設值
                    "totalAmount": 0,  # 無法從舊記錄推斷
                    "orderCount": 0,   # 無法從舊記錄推斷
                    "threshold": None,
                    "intervalMs": None,  # 無法從舊記錄推斷
                    "isRollback": False,
                    "leg1": {
                        "exchange": leg0.get('exchange'),
                        "symbol": leg0.get('symbol'),
                        "type": leg0.get('type'),
                        "side": leg0.get('side'),
                        "orderId": leg0.get('orderId'),
                        "price": leg0.get('price'),
                        "priceUpdated": self._safe_price_float(leg0.get('price')) is not None,
                        "originalOrderId": None
                    },
                    "leg2": {
                        "exchange": leg1.get('exchange'),
                        "symbol": leg1.get('symbol'),
                        "type": leg1.get('type'),
                        "side": leg1.get('side'),
                        "orderId": leg1.get('orderId'),
                        "price": leg1.get('price'),
                        "priceUpdated": self._safe_price_float(leg1.get('price')) is not None,
                        "originalOrderId": None
                    } if leg1 else None,
                    
                    # 標記為從舊格式轉換
                    "_convertedFromLegacy": True
                }
                
                unified_records.append(unified_record)
            
            return unified_records
            
        except Exception as e:
            self.logger.error("twap_legacy_format_conversion_failed", error=str(e))
            return []
    
    def get_persisted_recent(self, limit: int = 200) -> list[dict]:
        """讀取所有歷史 JSONL 檔案最近 limit 筆（倒序）
        
        V3 向後兼容：自動識別並轉換舊格式記錄
        """
        try:
            # 找出 data/twap 目錄下所有 executions_*.jsonl 文件
            import glob
            pattern = os.path.join(self._data_dir, 'executions_*.jsonl')
            jsonl_files = glob.glob(pattern)
            
            if not jsonl_files:
                return []
            
            # 按文件名排序（日期降序，最新的在前）
            jsonl_files.sort(reverse=True)
            
            # 從所有文件中收集記錄
            all_items = []
            legacy_items = []  # 舊格式記錄
            
            for file_path in jsonl_files:
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        lines = f.readlines()
                    for line in lines:
                        try:
                            item = json.loads(line.strip())
                            if not item:
                                continue
                            
                            # ✅ V3 向後兼容：檢測格式
                            if 'legIndex' in item:
                                # 舊格式（單腿記錄）
                                legacy_items.append(item)
                            else:
                                # 新格式（完整記錄）
                                all_items.append(item)
                        except Exception:
                            continue
                except Exception as e:
                    self.logger.error("twap_jsonl_file_read_failed", file=file_path, error=str(e))
                    continue
            
            # ✅ V3 向後兼容：轉換舊格式記錄
            if legacy_items:
                self.logger.info("twap_legacy_format_detected", count=len(legacy_items))
                converted_items = self._convert_legacy_format_to_unified(legacy_items)
                all_items.extend(converted_items)
            
            # 依時間倒序排序
            all_items.sort(key=lambda x: x.get('ts', 0), reverse=True)
            
            # 返回最近 limit 筆
            return all_items[:limit]
            
        except Exception as e:
            self.logger.error("twap_jsonl_read_failed", error=str(e))
            return []
    
    def clear_all_data(self) -> None:
        """清空所有 TWAP 引擎資料"""
        # 停止所有運行中的任務
        for task in self._running_tasks.values():
            if not task.done():
                task.cancel()
        
        self.plans.clear()
        self.progress.clear()
        self.executions.clear()
        self._running_tasks.clear()
        self.logger.info("twap_engine_data_cleared", success=True)

    async def _validate_order_preconditions(self, leg, qty: float) -> Optional[str]:
        """Validate spot-only exchanges before any leg in a slice is placed."""
        try:
            exchange = ExchangeFactory.create_from_config(leg.exchange)

            if not exchange.is_authenticated:
                return f"{leg.exchange} API 密鑰未配置"

            side = OrderSide.BUY if leg.side == "buy" else OrderSide.SELL
            category = getattr(leg, "category", "spot")
            if category == "spot":
                trade_type = TradeType.SPOT
            elif category == "linear":
                trade_type = TradeType.LINEAR
            elif category == "inverse":
                trade_type = TradeType.INVERSE
            else:
                trade_type = TradeType.SPOT

            if leg.exchange in ["bitget"] and trade_type == TradeType.SPOT:
                trade_type = TradeType.LINEAR

            validator = getattr(exchange, "validate_order_preconditions", None)
            if validator:
                return await validator(
                    symbol=leg.symbol,
                    side=side,
                    quantity=qty,
                    order_type=OrderType.MARKET,
                    trade_type=trade_type,
                )

            return None
        except Exception as e:
            return f"{leg.exchange} order precheck failed: {e}"

    async def _place_order_unified(self, leg, qty: float) -> OrderResult:
        """使用統一交易所接口下單"""
        try:
            # 獲取交易所實例
            exchange = ExchangeFactory.create_from_config(leg.exchange)
            
            if not exchange.is_authenticated:
                self.logger.warning("twap_exchange_not_authenticated", 
                                 exchange=leg.exchange,
                                 message=f"{leg.exchange} API 密鑰未配置，無法執行實際交易")
                return OrderResult(
                    success=False,
                    price=None,
                    order_id=None,
                    error_message=f"{leg.exchange} API 密鑰未配置"
                )

            # 轉換參數
            side = OrderSide.BUY if leg.side == "buy" else OrderSide.SELL
            
            # 轉換交易類型
            category = getattr(leg, "category", "spot")
            if category == "spot":
                trade_type = TradeType.SPOT
            elif category == "linear":
                trade_type = TradeType.LINEAR
            elif category == "inverse":
                trade_type = TradeType.INVERSE
            else:
                trade_type = TradeType.SPOT
            
            # Bitget spot is not supported in this flow, so keep using linear.
            if leg.exchange in ["bitget"] and trade_type == TradeType.SPOT:
                self.logger.warning("twap_exchange_spot_not_supported", 
                                 exchange=leg.exchange,
                                 message=f"{leg.exchange} 不支援現貨交易，自動轉換為合約")
                trade_type = TradeType.LINEAR

            self.logger.info("twap_placing_order_unified", 
                           exchange=leg.exchange,
                           symbol=leg.symbol,
                           side=leg.side,
                           category=category,
                           qty=qty)

            # 使用統一接口下單
            kwargs = {}
            if trade_type == TradeType.SPOT:
                if leg.exchange == "bybit":
                    # Bybit 現貨：默認啟用槓桿現貨（統一帳戶）
                    # 如果帳戶未開啟Cross Margin Trading，會自動回退到普通現貨
                    kwargs["use_leverage"] = True
                elif leg.exchange == "binance":
                    # Binance 現貨：啟用自動借幣/自動還幣（統一帳戶）
                    kwargs["side_effect_type"] = "AUTO_BORROW_REPAY"

            if trade_type == TradeType.SPOT and leg.exchange == "okx":
                kwargs["td_mode"] = "cross"
                kwargs["tgt_ccy"] = "base_ccy"
                kwargs["quick_mgn_type"] = getattr(leg, "quick_mgn_type", "auto_borrow")

            result = await exchange.place_order(
                symbol=leg.symbol,
                side=side,
                quantity=qty,
                order_type=OrderType.MARKET,
                trade_type=trade_type,
                **kwargs
            )

            # 若市價單無回傳價格，嘗試即時回查成交均價
            fetched_price: Optional[float] = None
            try:
                # 安全地檢查價格
                has_valid_price = False
                if result.success and result.price is not None:
                    try:
                        price_float = float(result.price)
                        has_valid_price = price_float > 0
                    except (ValueError, TypeError):
                        has_valid_price = False
                
                if result.success and not has_valid_price:
                    self.logger.info(
                        "twap_attempting_fill_price_query",
                        exchange=leg.exchange,
                        symbol=leg.symbol,
                        order_id=result.order_id,
                        has_get_fill_price=hasattr(exchange, "get_fill_price")
                    )
                    # 交易所擴展：若實作 get_fill_price，則回查
                    if hasattr(exchange, "get_fill_price") and result.order_id:
                        fetched_price = await exchange.get_fill_price(
                            order_id=result.order_id,
                            symbol=leg.symbol,
                            trade_type=trade_type
                        )
                        self.logger.info(
                            "twap_fill_price_query_result",
                            exchange=leg.exchange,
                            symbol=leg.symbol,
                            order_id=result.order_id,
                            fetched_price=fetched_price
                        )
                        if fetched_price and fetched_price > 0:
                            self.logger.info(
                                "twap_fill_price_retrieved",
                                exchange=leg.exchange,
                                symbol=leg.symbol,
                                price=fetched_price
                            )
            except Exception as e:
                self.logger.warning(
                    "twap_fill_price_query_failed",
                    exchange=leg.exchange,
                    symbol=leg.symbol,
                    error=str(e)
                )

            final_price = None
            # 安全地處理價格
            if result.price is not None:
                try:
                    price_float = float(result.price)
                    if price_float > 0:
                        final_price = Decimal(str(price_float))
                except (ValueError, TypeError):
                    pass
            
            if final_price is None and fetched_price and fetched_price > 0:
                final_price = Decimal(str(fetched_price))

            # 轉換為 TWAP 引擎的 OrderResult 格式
            return OrderResult(
                success=result.success,
                price=final_price,
                order_id=result.order_id,
                error_message=result.error_message,
                order_transport=getattr(result, "order_transport", None),
            )

        except Exception as e:
            self.logger.error("twap_place_order_unified_failed", 
                            exchange=leg.exchange,
                            symbol=leg.symbol,
                            error=str(e))
            return OrderResult(
                success=False,
                price=None,
                order_id=None,
                error_message=str(e),
                order_transport=None,
            )
    
    # 舊的硬編碼下單方法已移除，現在使用統一交易所接口

    # 舊的硬編碼下單方法已移除，現在使用統一交易所接口

    async def create_plan(self, plan: TwapPlan) -> str:
        """創建 TWAP 策略計畫"""
        plan_id = plan.planId
        self.plans[plan_id] = plan
        
        # 初始化進度追蹤
        self.progress[plan_id] = TwapProgress(
            planId=plan_id,
            executed=0.0,
            remaining=plan.totalQty,
            slicesDone=0,
            slicesTotal=int(plan.totalQty / plan.sliceQty),
            state=TwapState.PENDING
        )
        
        # 初始化執行記錄
        self.executions[plan_id] = []
        
        self.logger.info("twap_plan_created", 
                        planId=plan_id, 
                        name=plan.name,
                        totalQty=plan.totalQty,
                        success=True)
        
        return plan_id

    async def start_plan(self, plan_id: str) -> bool:
        """啟動 TWAP 策略計畫"""
        if plan_id not in self.plans:
            return False
        
        plan = self.plans[plan_id]
        progress = self.progress[plan_id]
        
        if progress.state != TwapState.PENDING:
            return False
        
        # 創建異步任務
        task = asyncio.create_task(self._execute_twap(plan_id))
        self._running_tasks[plan_id] = task
        
        progress.state = TwapState.RUNNING
        
        self.logger.info("twap_plan_started", planId=plan_id, success=True)
        return True

    async def pause_plan(self, plan_id: str) -> bool:
        """暫停 TWAP 策略計畫"""
        self.logger.info("twap_pause_plan_called", planId=plan_id, hasProgress=plan_id in self.progress)
        
        if plan_id not in self.progress:
            self.logger.warning("twap_pause_plan_not_found", planId=plan_id)
            return False
        
        progress = self.progress[plan_id]
        self.logger.info("twap_pause_plan_state_check", planId=plan_id, currentState=progress.state.value)
        
        # 只允許暫停運行中的策略
        if progress.state != TwapState.RUNNING:
            self.logger.warning("twap_pause_plan_invalid_state", planId=plan_id, currentState=progress.state.value)
            return False
        
        progress.state = TwapState.PAUSED
        
        # 取消任務
        if plan_id in self._running_tasks:
            self._running_tasks[plan_id].cancel()
            del self._running_tasks[plan_id]
        
        self.logger.info("twap_plan_paused", planId=plan_id, success=True)
        return True

    async def resume_plan(self, plan_id: str) -> bool:
        """恢復 TWAP 策略計畫"""
        if plan_id not in self.progress:
            return False
        
        progress = self.progress[plan_id]
        if progress.state != TwapState.PAUSED:
            return False
        
        # 創建異步任務
        task = asyncio.create_task(self._execute_twap(plan_id))
        self._running_tasks[plan_id] = task
        
        progress.state = TwapState.RUNNING
        
        self.logger.info("twap_plan_resumed", planId=plan_id, success=True)
        return True

    async def cancel_plan(self, plan_id: str) -> bool:
        """取消 TWAP 策略計畫（手動中止 → state=CANCELLED；下單錯誤見 _execute_twap → FAILED）"""
        if plan_id not in self.progress:
            return False
        
        progress = self.progress[plan_id]
        progress.state = TwapState.CANCELLED
        
        # 取消任務
        if plan_id in self._running_tasks:
            self._running_tasks[plan_id].cancel()
            del self._running_tasks[plan_id]
        
        # ✅ V3 改進：寫入 cancelled 狀態記錄（用於歷史記錄顯示）
        if plan_id in self.plans:
            self._append_cancelled_record(plan_id)
        
        self.logger.info("twap_plan_cancelled", planId=plan_id, success=True)
        return True
    
    async def emergency_rollback(self, plan_id: str) -> bool:
        """緊急回滾所有成功的腿"""
        if plan_id not in self.plans:
            return False
        
        plan = self.plans[plan_id]
        executions = self.executions.get(plan_id, [])
        
        # 找出所有成功的腿（非回滾）
        successful_legs = []
        for execution in executions:
            if execution.success and not execution.is_rollback:
                successful_legs.append({
                    'leg_index': execution.legIndex,
                    'leg': plan.legs[execution.legIndex],
                    'order_id': execution.orderId,
                    'side': plan.legs[execution.legIndex].side
                })
        
        if not successful_legs:
            self.logger.info("twap_emergency_rollback_no_legs", planId=plan_id)
            return True
        
        # 執行回滾
        await self._rollback_successful_legs(plan_id, -1, successful_legs)  # -1 表示緊急回滾
        
        self.logger.warning("twap_emergency_rollback_completed", 
                           planId=plan_id, 
                           rolledBackLegsCount=len(successful_legs))
        return True

    async def get_progress(self, plan_id: str) -> Optional[TwapProgress]:
        """取得 TWAP 策略計畫進度"""
        return self.progress.get(plan_id)

    async def get_executions(self, plan_id: str) -> Optional[List[TwapExecution]]:
        """取得 TWAP 策略執行記錄"""
        return self.executions.get(plan_id)
    
    async def _rollback_successful_legs(self, plan_id: str, slice_index: int, successful_legs: List[dict]):
        """回滾成功的腿，執行反向平倉（V3改進：寫入統一格式記錄）"""
        plan = self.plans[plan_id]
        
        self.logger.warning("twap_rollback_started", 
                           planId=plan_id, 
                           sliceIndex=slice_index,
                           successfulLegsCount=len(successful_legs))
        
        # ✅ V3 改進：收集所有回滾結果，最後寫入統一格式記錄
        rollback_results = []
        
        for leg_info in successful_legs:
            leg_index = leg_info['leg_index']
            leg = leg_info['leg']
            original_order_id = leg_info['order_id']
            original_side = leg_info['side']
            
            # 計算反向操作（統一使用小寫）
            reverse_side = "sell" if original_side == "buy" else "buy"
            
            try:
                # 執行反向平倉 - 使用統一交易所接口
                # 創建臨時的 leg 對象用於回滾
                rollback_leg = type('Leg', (), {
                    'exchange': leg.exchange,
                    'symbol': leg.symbol,
                    'side': reverse_side,
                    'category': getattr(leg, "category", "spot"),
                    'quick_mgn_type': "auto_repay"
                })()
                
                rollback_result = await self._place_order_unified(rollback_leg, plan.sliceQty)
                
                # 記錄回滾結果（內存）
                rollback_execution = TwapExecution(
                    planId=plan_id,
                    sliceIndex=slice_index,
                    legIndex=leg_index,
                    orderId=rollback_result.order_id,
                    success=rollback_result.success,
                    price=self._safe_price_float(rollback_result.price),
                    qty=plan.sliceQty,
                    error=rollback_result.error_message,
                    orderTransport=getattr(rollback_result, "order_transport", None),
                )
                
                # 標記為回滾操作
                rollback_execution.is_rollback = True
                rollback_execution.original_order_id = original_order_id
                
                self.executions[plan_id].append(rollback_execution)
                
                # ✅ 收集回滾結果
                rollback_results.append({
                    'leg_index': leg_index,
                    'leg': rollback_leg,
                    'order_result': rollback_result,
                    'original_order_id': original_order_id
                })
                
                if rollback_result.success:
                    self.logger.info("twap_rollback_success", 
                                   planId=plan_id, 
                                   sliceIndex=slice_index,
                                   legIndex=leg_index,
                                   originalOrderId=original_order_id,
                                   rollbackOrderId=rollback_result.order_id,
                                   success=True)
                else:
                    self.logger.error("twap_rollback_failed", 
                                    planId=plan_id, 
                                    sliceIndex=slice_index,
                                    legIndex=leg_index,
                                    originalOrderId=original_order_id,
                                    error=rollback_result.error_message)
                    
            except Exception as e:
                self.logger.error("twap_rollback_exception", 
                                planId=plan_id, 
                                sliceIndex=slice_index,
                                legIndex=leg_index,
                                originalOrderId=original_order_id,
                                error=str(e))
        
        # ✅ V3 改進：寫入統一格式的回滾記錄
        if rollback_results:
            self._append_unified_rollback_record(
                plan_id=plan_id,
                slice_index=slice_index,
                plan=plan,
                rollback_results=rollback_results
            )
        
        self.logger.warning("twap_rollback_completed", 
                           planId=plan_id, 
                           sliceIndex=slice_index,
                           successfulLegsCount=len(successful_legs))

    async def _execute_twap(self, plan_id: str):
        """執行 TWAP 策略"""
        plan = self.plans[plan_id]
        progress = self.progress[plan_id]
        
        try:
            total_slices = int(plan.totalQty / plan.sliceQty)
            
            for slice_index in range(total_slices):
                if progress.state != TwapState.RUNNING:
                    break
                
                # 執行每個交易腿
                slice_failed = False
                successful_legs = []  # 記錄成功的腿

                preflight_failure = None
                for leg_index, leg in enumerate(plan.legs):
                    preflight_error = await self._validate_order_preconditions(leg, plan.sliceQty)
                    if preflight_error:
                        preflight_failure = (leg_index, leg, preflight_error)
                        break

                if preflight_failure:
                    leg_index, leg, preflight_error = preflight_failure
                    failed_result = OrderResult(
                        success=False,
                        price=None,
                        order_id=None,
                        error_message=preflight_error,
                    )
                    execution = TwapExecution(
                        planId=plan_id,
                        sliceIndex=slice_index,
                        legIndex=leg_index,
                        orderId=None,
                        success=False,
                        price=None,
                        qty=plan.sliceQty,
                        error=preflight_error,
                    )
                    self.executions[plan_id].append(execution)
                    self._append_unified_execution_record(
                        plan_id=plan_id,
                        slice_index=slice_index,
                        plan=plan,
                        legs_results=[{
                            "leg_index": leg_index,
                            "leg": leg,
                            "order_result": failed_result,
                            "execution": execution,
                        }],
                        all_success=False,
                        error_message=preflight_error,
                    )
                    progress.state = TwapState.FAILED
                    progress.nextExecutionTs = None
                    slice_failed = True
                    self.logger.error(
                        "twap_slice_preflight_failed",
                        planId=plan_id,
                        sliceIndex=slice_index,
                        legIndex=leg_index,
                        exchange=leg.exchange,
                        symbol=leg.symbol,
                        error=preflight_error,
                    )
                    self._broadcast_ws("twapExecuted", {
                        "planId": plan_id,
                        "sliceIndex": slice_index,
                        "qty": float(plan.sliceQty),
                        "price": None,
                        "success": False,
                        "error": preflight_error,
                        "timestamp": int(time.time() * 1000),
                    })
                    break

                # ✅ V3 改進：收集所有腿的執行結果，在循環結束後寫入完整記錄
                all_legs_results = []
                
                for leg_index, leg in enumerate(plan.legs):
                    if progress.state != TwapState.RUNNING:
                        break
                    
                    # 使用統一交易所接口下單
                    order_result = await self._place_order_unified(leg, plan.sliceQty)
                    
                    # 記錄執行結果（內存中）
                    execution = TwapExecution(
                        planId=plan_id,
                        sliceIndex=slice_index,
                        legIndex=leg_index,
                        orderId=order_result.order_id,
                        success=order_result.success,
                        price=self._safe_price_float(order_result.price),
                        qty=plan.sliceQty,
                        error=order_result.error_message,
                        orderTransport=getattr(order_result, "order_transport", None),
                    )
                    
                    self.executions[plan_id].append(execution)
                    
                    # ✅ 收集腿執行結果（不立即寫入JSONL）
                    all_legs_results.append({
                        'leg_index': leg_index,
                        'leg': leg,
                        'order_result': order_result,
                        'execution': execution
                    })
                    
                    if order_result.success:
                        # 記錄成功的腿
                        successful_legs.append({
                            'leg_index': leg_index,
                            'leg': leg,
                            'order_id': order_result.order_id,
                            'side': leg.side
                        })
                        
                        progress.executed += plan.sliceQty
                        progress.remaining -= plan.sliceQty
                        progress.lastExecutionTs = int(time.time() * 1000)
                        
                        self.logger.info("twap_execution_success", 
                                       planId=plan_id, 
                                       sliceIndex=slice_index,
                                       legIndex=leg_index,
                                       orderId=order_result.order_id,
                                       success=True)
                    else:
                        self.logger.error("twap_execution_failed", 
                                        planId=plan_id, 
                                        sliceIndex=slice_index,
                                        legIndex=leg_index,
                                        error=order_result.error_message)
                        
                        # 如果有成功的腿，需要執行反向平倉
                        if successful_legs:
                            await self._rollback_successful_legs(plan_id, slice_index, successful_legs)
                        
                        # 下單失敗，立即終止策略：任何下單錯誤一律 FAILED。
                        # CANCELLED 僅由 cancel_plan（手動中止）寫入，見 cancel_plan。
                        progress.state = TwapState.FAILED
                        
                        progress.nextExecutionTs = None
                        slice_failed = True
                        self.logger.error("twap_plan_terminated_due_to_failure", 
                                        planId=plan_id, 
                                        sliceIndex=slice_index,
                                        legIndex=leg_index,
                                        error=order_result.error_message,
                                        finalState=progress.state.value)
                        
                        # 失敗後自動清理策略（從執行中移除）
                        self.logger.warning("twap_plan_auto_cleanup", 
                                          planId=plan_id,
                                          reason="execution_failed")
                        break  # 跳出腿的循環
                
                # ✅ V3 改進：循環結束後，寫入統一格式的完整記錄
                # ✅ 修復：即使只有1條腿（leg1失敗）也要寫入記錄，便於追蹤和調試
                if len(all_legs_results) > 0:
                    # 至少有1條腿執行完畢（無論成功或失敗），寫入完整記錄
                    all_success = all(leg_result['order_result'].success for leg_result in all_legs_results)
                    
                    # 收集錯誤信息
                    error_msg = None
                    if not all_success:
                        for leg_result in all_legs_results:
                            if not leg_result['order_result'].success and leg_result['order_result'].error_message:
                                error_msg = leg_result['order_result'].error_message
                                break
                    
                    self._append_unified_execution_record(
                        plan_id=plan_id,
                        slice_index=slice_index,
                        plan=plan,
                        legs_results=all_legs_results,
                        all_success=all_success,
                        error_message=error_msg
                    )

                    # 推播執行事件（前端 twapExecuted handler 接收）
                    leg0 = all_legs_results[0] if len(all_legs_results) > 0 else None
                    leg1_r = all_legs_results[1] if len(all_legs_results) > 1 else None
                    fill_price = None
                    if leg0:
                        fill_price = self._safe_price_float(leg0['order_result'].price)
                    if fill_price is None and leg1_r:
                        fill_price = self._safe_price_float(leg1_r['order_result'].price)

                    self._broadcast_ws("twapExecuted", {
                        "planId": plan_id,
                        "sliceIndex": slice_index,
                        "qty": float(plan.sliceQty),
                        "price": fill_price,
                        "success": all_success,
                        "error": error_msg,
                        "timestamp": int(time.time() * 1000)
                    })

                progress.slicesDone = slice_index + 1
                
                # 如果切片失敗，立即終止策略
                if slice_failed:
                    break
                
                # 計算下次執行時間
                if slice_index < total_slices - 1:
                    progress.nextExecutionTs = int((time.time() + plan.intervalMs / 1000) * 1000)
                    await asyncio.sleep(plan.intervalMs / 1000)
            
            # 完成策略（只有在正常運行狀態下才標記為完成）
            if progress.state == TwapState.RUNNING:
                progress.state = TwapState.COMPLETED
                progress.nextExecutionTs = None

                self.logger.info("twap_plan_completed",
                               planId=plan_id,
                               totalExecuted=progress.executed,
                               success=True)
                self._broadcast_ws("twapPlanCompleted", {
                    "planId": plan_id,
                    "totalExecuted": float(progress.executed),
                    "timestamp": int(time.time() * 1000)
                })
            elif progress.state == TwapState.CANCELLED:
                self.logger.error("twap_plan_terminated",
                               planId=plan_id,
                               totalExecuted=progress.executed,
                               success=False)
                self._broadcast_ws("twapPlanFailed", {
                    "planId": plan_id,
                    "reason": "cancelled",
                    "totalExecuted": float(progress.executed),
                    "timestamp": int(time.time() * 1000)
                })
            elif progress.state == TwapState.FAILED:
                self._broadcast_ws("twapPlanFailed", {
                    "planId": plan_id,
                    "reason": "execution_failed",
                    "totalExecuted": float(progress.executed),
                    "timestamp": int(time.time() * 1000)
                })

        except asyncio.CancelledError:
            self.logger.info("twap_plan_cancelled", planId=plan_id, success=True)
        except Exception as e:
            self.logger.error("twap_execution_error",
                            planId=plan_id,
                            error=str(e))
            progress.state = TwapState.FAILED
            self._broadcast_ws("twapPlanFailed", {
                "planId": plan_id,
                "reason": "exception",
                "error": str(e),
                "timestamp": int(time.time() * 1000)
            })
        finally:
            # 清理任務
            if plan_id in self._running_tasks:
                del self._running_tasks[plan_id]


# 全域 TWAP 引擎實例
twap_engine = TWAPEngine()
