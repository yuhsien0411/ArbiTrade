from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Literal, List, Optional

from pydantic import BaseModel, Field, model_validator


ExchangeLiteral = Literal["bybit", "binance", "okx", "bitget", "aster", "mexc"]


class TwapState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class OrderTemplate(BaseModel):
    exchange: ExchangeLiteral
    symbol: str
    side: Literal["buy", "sell"]
    type: Literal["market", "limit"] = "market"
    category: Literal["spot", "linear"] = "spot"
    price: Optional[float] = None
    qty: Optional[float] = None
    ratio: Optional[float] = None

    @model_validator(mode="after")
    def validate_exchange_constraints(self):
        if self.exchange in ("aster", "bitget") and self.category == "spot":
            raise ValueError(f"{self.exchange} supports linear contracts only")
        if self.exchange == "mexc" and self.category != "spot":
            raise ValueError("mexc currently supports spot only")
        return self


class TwapPlan(BaseModel):
    planId: str = Field(default_factory=lambda: f"twap_{uuid.uuid4().hex[:8]}")
    name: str
    totalQty: float = Field(gt=0, description="Total quantity")
    sliceQty: float = Field(gt=0, description="Slice quantity")
    intervalMs: int = Field(gt=0, description="Interval in milliseconds")
    legs: List[OrderTemplate] = Field(min_items=1, description="Order legs")
    createdAt: int = Field(default_factory=lambda: int(time.time() * 1000))
    state: TwapState = TwapState.PENDING


class TwapProgress(BaseModel):
    planId: str
    executed: float = Field(ge=0, description="Executed quantity")
    remaining: float = Field(ge=0, description="Remaining quantity")
    slicesDone: int = Field(ge=0, description="Slices done")
    slicesTotal: int = Field(ge=0, description="Total slices")
    state: TwapState
    lastExecutionTs: Optional[int] = None
    nextExecutionTs: Optional[int] = None


class TwapExecution(BaseModel):
    planId: str
    sliceIndex: int
    legIndex: int
    orderId: Optional[str] = None
    success: bool
    price: Optional[float] = None
    qty: float
    ts: int = Field(default_factory=lambda: int(time.time() * 1000))
    error: Optional[str] = None
    is_rollback: Optional[bool] = False
    original_order_id: Optional[str] = None
    orderTransport: Optional[str] = None


class CreateTwapRequest(BaseModel):
    name: str
    totalQty: float = Field(gt=0, description="Total quantity")
    sliceQty: float = Field(gt=0, description="Slice quantity")
    intervalMs: int = Field(gt=0, description="Interval in milliseconds")
    legs: List[OrderTemplate] = Field(min_items=1, description="Order legs")


class TwapControlRequest(BaseModel):
    action: Literal["start", "pause", "resume", "cancel"]


class TwapControlResponse(BaseModel):
    success: bool
    message: str
    newState: TwapState
