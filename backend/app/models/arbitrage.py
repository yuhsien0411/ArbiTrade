from __future__ import annotations

import time
import uuid
from typing import Literal, Optional, List

from pydantic import BaseModel, Field, model_validator


ExchangeLiteral = Literal["bybit", "binance", "okx", "bitget", "aster", "mexc"]
TradeTypeLiteral = Literal["spot", "linear", "inverse"]
SideLiteral = Literal["buy", "sell"]


class Leg(BaseModel):
    exchange: ExchangeLiteral = Field(description="Exchange")
    symbol: str = Field(pattern=r"^[A-Z0-9]+USDT?$", description="Symbol, e.g. BTCUSDT")
    type: TradeTypeLiteral = Field(description="Trade type")
    side: SideLiteral = Field(description="Order side")

    @property
    def is_bitget(self) -> bool:
        return self.exchange == "bitget"

    @property
    def is_okx(self) -> bool:
        return self.exchange == "okx"

    @property
    def is_aster(self) -> bool:
        return self.exchange == "aster"

    @property
    def is_mexc(self) -> bool:
        return self.exchange == "mexc"

    def validate_bitget_constraints(self) -> None:
        if self.is_bitget and self.type == "spot":
            raise ValueError("bitget supports contract trading only in this project")

    def validate_okx_constraints(self) -> None:
        # OKX spot is supported. The OKX adapter will try cross-margin spot first
        # and fall back to cash spot when the symbol/account does not support it.
        return None

    def validate_aster_constraints(self) -> None:
        if self.is_aster and self.type != "linear":
            raise ValueError("Aster supports linear contracts only")

    def validate_mexc_constraints(self) -> None:
        if self.is_mexc and self.type != "spot":
            raise ValueError("MEXC currently supports spot only")

    @model_validator(mode="after")
    def validate_exchange_constraints(self):
        self.validate_bitget_constraints()
        self.validate_okx_constraints()
        self.validate_aster_constraints()
        self.validate_mexc_constraints()
        return self

    class Config:
        json_schema_extra = {
            "example": {
                "exchange": "bybit",
                "symbol": "BTCUSDT",
                "type": "linear",
                "side": "buy",
            }
        }


class PairConfig(BaseModel):
    id: str = Field(
        default_factory=lambda: f"pair_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}",
        description="Pair ID",
    )
    leg1: Leg = Field(description="First leg")
    leg2: Leg = Field(description="Second leg")
    threshold: float = Field(description="Trigger threshold percent")
    qty: float = Field(gt=0, description="Order quantity")
    maxExecs: int = Field(ge=1, description="Maximum executions")
    enabled: bool = Field(default=True, description="Enabled")
    createdAt: int = Field(
        default_factory=lambda: int(time.time() * 1000),
        description="Created timestamp in milliseconds",
    )
    totalTriggers: Optional[int] = Field(default=0, description="Total triggers")
    lastTriggered: Optional[int] = Field(default=None, description="Last trigger timestamp")

    class Config:
        populate_by_name = True
        json_schema_extra = {
            "example": {
                "id": "pair_1234567890_abc123",
                "leg1": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "linear",
                    "side": "buy",
                },
                "leg2": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "spot",
                    "side": "sell",
                },
                "threshold": 0.1,
                "qty": 0.001,
                "maxExecs": 5,
                "enabled": True,
                "createdAt": 1758832273693,
                "totalTriggers": 0,
                "lastTriggered": None,
            }
        }


class ExecutionLeg(BaseModel):
    exchange: str = Field(description="Exchange")
    symbol: str = Field(description="Symbol")
    type: str = Field(description="Trade type")
    side: str = Field(description="Order side")
    orderId: Optional[str] = Field(default=None, description="Order ID")

    class Config:
        populate_by_name = True


class ExecutionRecord(BaseModel):
    ts: int = Field(description="Timestamp")
    pairId: str = Field(description="Pair ID")
    qty: float = Field(gt=0, description="Executed quantity")
    status: Literal["success", "failed", "cancelled", "rolling_back", "rolled_back"] = Field(description="Status")
    maxExecs: int = Field(ge=1, description="Maximum executions")
    totalTriggers: int = Field(ge=0, description="Total triggers")
    leg1: ExecutionLeg = Field(description="First leg")
    leg2: ExecutionLeg = Field(description="Second leg")
    success: Optional[bool] = Field(default=None, description="Success")
    reason: Optional[str] = Field(default=None, description="Reason")
    error: Optional[str] = Field(default=None, description="Error")

    class Config:
        populate_by_name = True
        json_schema_extra = {
            "example": {
                "ts": 1758832273693,
                "pairId": "pair_1234567890_abc123",
                "qty": 0.001,
                "status": "success",
                "maxExecs": 5,
                "totalTriggers": 1,
                "leg1": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "linear",
                    "side": "buy",
                    "orderId": "order_123",
                },
                "leg2": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "spot",
                    "side": "sell",
                    "orderId": "order_456",
                },
            }
        }


class CreatePairRequest(BaseModel):
    pairId: Optional[str] = Field(default=None, description="Optional pair ID")
    leg1: Leg = Field(description="First leg")
    leg2: Leg = Field(description="Second leg")
    threshold: float = Field(description="Trigger threshold percent")
    qty: float = Field(gt=0, description="Order quantity")
    maxExecs: int = Field(ge=1, default=1, description="Maximum executions")
    enabled: bool = Field(default=True, description="Enabled")

    class Config:
        populate_by_name = True


class UpdatePairRequest(BaseModel):
    enabled: Optional[bool] = Field(default=None, description="Enabled")
    threshold: Optional[float] = Field(default=None, description="Trigger threshold percent")
    qty: Optional[float] = Field(default=None, gt=0, description="Order quantity")
    maxExecs: Optional[int] = Field(default=None, ge=1, description="Maximum executions")

    class Config:
        populate_by_name = True


class EngineControlRequest(BaseModel):
    action: Literal["start", "stop"] = Field(description="Engine action")


class PriceUpdate(BaseModel):
    id: str = Field(description="Pair ID")
    pairConfig: PairConfig = Field(description="Pair config")
    leg1Price: dict = Field(description="First leg price")
    leg2Price: dict = Field(description="Second leg price")
    spread: float = Field(description="Spread")
    spreadPercent: float = Field(description="Spread percent")
    threshold: float = Field(description="Threshold")
    timestamp: int = Field(description="Timestamp")
    refreshed: Optional[bool] = Field(default=False, description="Refreshed")

    class Config:
        populate_by_name = True


class ApiResponse(BaseModel):
    success: bool = Field(description="Success")
    data: Optional[dict] = Field(default=None, description="Data")
    error: Optional[str] = Field(default=None, description="Error")
    message: Optional[str] = Field(default=None, description="Message")


class WebSocketMessage(BaseModel):
    type: str = Field(description="Message type")
    data: dict = Field(description="Payload")
    timestamp: Optional[int] = Field(default_factory=lambda: int(time.time() * 1000), description="Timestamp")


class ExecutionHistoryResponse(BaseModel):
    data: dict = Field(description="Records grouped by pair ID", default_factory=dict)
    recent: List[ExecutionRecord] = Field(description="Recent records", default_factory=list)

    class Config:
        json_schema_extra = {
            "example": {
                "data": {},
                "recent": [],
            }
        }
