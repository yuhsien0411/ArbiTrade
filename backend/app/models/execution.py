"""
統一的執行記錄資料模型

此模組定義了 TWAP 和 Pairs 策略的統一執行記錄格式，
確保前端和數據分析只需處理一種格式。
"""

from typing import Optional, Literal
from pydantic import BaseModel, Field
import time


class ExecutionLeg(BaseModel):
    """執行腿的統一結構"""
    exchange: str = Field(description="交易所名稱")
    symbol: str = Field(description="交易對符號")
    type: Literal["spot", "linear", "inverse"] = Field(description="交易類型")
    side: Literal["buy", "sell"] = Field(description="買賣方向")
    orderId: Optional[str] = Field(default=None, description="訂單ID")
    price: Optional[float] = Field(default=None, description="成交價格")
    priceUpdated: bool = Field(default=False, description="價格是否已更新")
    originalOrderId: Optional[str] = Field(default=None, description="原始訂單ID（回滾時使用）")

    class Config:
        json_schema_extra = {
            "example": {
                "exchange": "bybit",
                "symbol": "ETHUSDT",
                "type": "linear",
                "side": "buy",
                "orderId": "abc123",
                "price": 3000.0,
                "priceUpdated": True,
                "originalOrderId": None
            }
        }


class UnifiedExecutionRecord(BaseModel):
    """統一的執行記錄格式（TWAP 和 Pairs 共用）"""
    
    # 基本資訊
    ts: int = Field(description="時間戳（毫秒）")
    mode: Literal["pair", "twap"] = Field(description="策略類型")
    strategyId: str = Field(description="策略ID（統一識別用）")
    pairId: Optional[str] = Field(default=None, description="Pairs策略ID（mode=pair時使用）")
    twapId: Optional[str] = Field(default=None, description="TWAP策略ID（mode=twap時使用）")
    
    # 執行資訊
    totalTriggers: int = Field(ge=1, description="第幾次執行（從1開始，pair和twap共用）")
    
    # 狀態資訊
    status: Literal["success", "failed", "cancelled", "rolled_back"] = Field(description="執行狀態")
    reason: Optional[str] = Field(default=None, description="失敗或取消原因")
    error: Optional[str] = Field(default=None, description="錯誤訊息")
    
    # 數量和價格資訊
    qty: float = Field(gt=0, description="本次執行數量")
    spread: Optional[float] = Field(default=None, description="價差")
    spreadPercent: Optional[float] = Field(default=None, description="價差百分比")
    
    # 策略配置資訊
    totalAmount: float = Field(gt=0, description="預期總數量")
    orderCount: int = Field(ge=1, description="總執行次數/最大執行次數")
    threshold: Optional[float] = Field(default=None, description="觸發閾值（pair用，twap為null）")
    intervalMs: Optional[int] = Field(default=None, description="執行間隔毫秒（twap用，pair為null）")
    
    # 回滾資訊
    isRollback: bool = Field(default=False, description="是否為回滾記錄")
    
    # 執行腿資訊
    leg1: Optional[ExecutionLeg] = Field(default=None, description="第一腿執行結果")
    leg2: Optional[ExecutionLeg] = Field(default=None, description="第二腿執行結果")

    class Config:
        json_schema_extra = {
            "examples": [
                {
                    "description": "Pairs 執行記錄範例",
                    "value": {
                        "ts": 1766508230641,
                        "mode": "pair",
                        "strategyId": "pair_1766508229326_nd8p9x",
                        "pairId": "pair_1766508229326_nd8p9x",
                        "twapId": None,
                        "totalTriggers": 1,
                        "status": "success",
                        "reason": None,
                        "error": None,
                        "qty": 0.01,
                        "spread": -0.03,
                        "spreadPercent": -0.001016,
                        "totalAmount": 0.01,
                        "orderCount": 1,
                        "threshold": -1.0,
                        "intervalMs": None,
                        "isRollback": False,
                        "leg1": {
                            "exchange": "bybit",
                            "symbol": "ETHUSDT",
                            "type": "linear",
                            "side": "sell",
                            "orderId": "abc123",
                            "price": 2952.96,
                            "priceUpdated": True,
                            "originalOrderId": None
                        },
                        "leg2": {
                            "exchange": "binance",
                            "symbol": "ETHUSDT",
                            "type": "linear",
                            "side": "buy",
                            "orderId": "def456",
                            "price": 2953.26,
                            "priceUpdated": True,
                            "originalOrderId": None
                        }
                    }
                },
                {
                    "description": "TWAP 執行記錄範例",
                    "value": {
                        "ts": 1766508307833,
                        "mode": "twap",
                        "strategyId": "twap_6168e245",
                        "pairId": None,
                        "twapId": "twap_6168e245",
                        "totalTriggers": 1,
                        "status": "success",
                        "reason": None,
                        "error": None,
                        "qty": 0.01,
                        "spread": -0.4,
                        "spreadPercent": -0.013548,
                        "totalAmount": 0.01,
                        "orderCount": 1,
                        "threshold": None,
                        "intervalMs": 10000,
                        "isRollback": False,
                        "leg1": {
                            "exchange": "bybit",
                            "symbol": "ETHUSDT",
                            "type": "spot",
                            "side": "buy",
                            "orderId": "xyz789",
                            "price": 2952.67,
                            "priceUpdated": True,
                            "originalOrderId": None
                        },
                        "leg2": {
                            "exchange": "binance",
                            "symbol": "ETHUSDT",
                            "type": "spot",
                            "side": "sell",
                            "orderId": "uvw012",
                            "price": 2952.27,
                            "priceUpdated": True,
                            "originalOrderId": None
                        }
                    }
                }
            ]
        }

    @classmethod
    def from_pair_dict(cls, record: dict) -> "UnifiedExecutionRecord":
        """從 Pairs 舊格式字典轉換為統一格式
        
        Args:
            record: 舊格式的 Pairs 執行記錄
            
        Returns:
            統一格式的執行記錄
        """
        pair_id = record.get("pairId")
        
        return cls(
            ts=record.get("ts", int(time.time() * 1000)),
            mode="pair",
            strategyId=pair_id,
            pairId=pair_id,
            twapId=None,
            
            totalTriggers=record.get("totalTriggers", 1),
            
            status=record.get("status", "success"),
            reason=record.get("reason"),
            error=record.get("error"),
            
            qty=record.get("qty", 0),
            spread=record.get("spread"),
            spreadPercent=record.get("spreadPercent"),
            
            totalAmount=record.get("maxExecs", 1) * record.get("qty", 0),
            orderCount=record.get("maxExecs", 1),
            threshold=record.get("threshold"),
            intervalMs=None,
            
            isRollback=record.get("isRollback", False),
            
            leg1=ExecutionLeg(**record["leg1"]) if record.get("leg1") else None,
            leg2=ExecutionLeg(**record["leg2"]) if record.get("leg2") else None
        )

    @classmethod
    def from_twap_dict(cls, record: dict) -> "UnifiedExecutionRecord":
        """從 TWAP 舊格式字典轉換為統一格式
        
        Args:
            record: 舊格式的 TWAP 執行記錄
            
        Returns:
            統一格式的執行記錄
        """
        plan_id = record.get("planId")
        slice_index = record.get("sliceIndex", 0)
        
        return cls(
            ts=record.get("ts", int(time.time() * 1000)),
            mode="twap",
            strategyId=plan_id,
            pairId=None,
            twapId=plan_id,
            
            # TWAP 的 totalTriggers = sliceIndex + 1（從1開始）
            totalTriggers=slice_index + 1,
            
            status=record.get("status", "success"),
            reason=record.get("reason"),
            error=record.get("error"),
            
            qty=record.get("qty", 0),
            spread=record.get("spread"),
            spreadPercent=record.get("spreadPercent"),
            
            totalAmount=record.get("totalAmount", 0),
            orderCount=record.get("orderCount", 1),
            threshold=None,
            intervalMs=record.get("intervalMs"),
            
            isRollback=record.get("isRollback", False),
            
            leg1=ExecutionLeg(**record["leg1"]) if record.get("leg1") else None,
            leg2=ExecutionLeg(**record["leg2"]) if record.get("leg2") else None
        )

    def to_dict(self) -> dict:
        """轉換為字典格式（用於寫入 JSONL）
        
        Returns:
            字典格式的執行記錄
        """
        result = {
            "ts": self.ts,
            "mode": self.mode,
            "strategyId": self.strategyId,
            "pairId": self.pairId,
            "twapId": self.twapId,
            
            "totalTriggers": self.totalTriggers,
            
            "status": self.status,
            "reason": self.reason,
            "error": self.error,
            
            "qty": self.qty,
            "spread": self.spread,
            "spreadPercent": self.spreadPercent,
            
            "totalAmount": self.totalAmount,
            "orderCount": self.orderCount,
            "threshold": self.threshold,
            "intervalMs": self.intervalMs,
            
            "isRollback": self.isRollback,
            
            "leg1": self.leg1.model_dump() if self.leg1 else None,
            "leg2": self.leg2.model_dump() if self.leg2 else None
        }
        
        return result
