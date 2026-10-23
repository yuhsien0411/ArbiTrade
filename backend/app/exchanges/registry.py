"""
交易所能力註冊表（Capabilities Registry）

用途：集中描述各交易所在本系統支援的交易類型與帳戶模式，
供引擎/服務/前端統一查詢，避免散落的 if-交易所判斷。
"""

from dataclasses import dataclass, asdict
from typing import Dict, List, Any

from .base import TradeType, AccountMode


@dataclass(frozen=True)
class ExchangeCapabilities:
    name: str
    # 交易類型支援
    supports_spot: bool
    supports_linear: bool
    supports_inverse: bool

    # 帳戶模式/特性（如適用）
    supports_unified_account: bool = False
    supports_portfolio_margin: bool = False
    supports_classic_account: bool = True
    # 統一標識帳戶側型態："unified" | "classic"
    account_profile: str = "classic"

    # 備註
    notes: str = ""

    def supported_trade_types(self) -> List[str]:
        types: List[str] = []
        if self.supports_spot:
            types.append(TradeType.SPOT.value)
        if self.supports_linear:
            types.append(TradeType.LINEAR.value)
        if self.supports_inverse:
            types.append(TradeType.INVERSE.value)
        return types


EXCHANGE_CAPABILITIES: Dict[str, ExchangeCapabilities] = {
    # Binance：支援現貨與 USDT-M 合約；本專案以 Portfolio Margin（統一交易帳戶）為優先
    "binance": ExchangeCapabilities(
        name="Binance",
        supports_spot=True,
        supports_linear=True,
        supports_inverse=False,
        supports_unified_account=True,
        supports_portfolio_margin=True,
        supports_classic_account=True,
        account_profile="unified",
        notes="統一帳戶；現貨(含槓桿) 與 USDT-M 合約。",
    ),

    # Bybit：支援現貨與 USDT-M 合約；統一帳戶
    "bybit": ExchangeCapabilities(
        name="Bybit",
        supports_spot=True,
        supports_linear=True,
        supports_inverse=False,
        supports_unified_account=True,
        supports_portfolio_margin=False,
        supports_classic_account=True,
        account_profile="unified",
        notes="統一帳戶；現貨(含槓桿) 與 USDT-M 合約。",
    ),

    # OKX：使用全倉跨幣種保證金模式，支援現貨與永續合約
    "okx": ExchangeCapabilities(
        name="OKX",
        supports_spot=True,
        supports_linear=True,
        supports_inverse=False,
        supports_unified_account=False,
        supports_portfolio_margin=False,
        supports_classic_account=True,
        account_profile="classic",
        notes="全倉跨幣種保證金模式；支援現貨與永續合約（SWAP）。",
    ),

    # Bitget：本專案僅支援 USDT-M 永續合約
    "bitget": ExchangeCapabilities(
        name="Bitget",
        supports_spot=False,
        supports_linear=True,
        supports_inverse=False,
        supports_unified_account=False,
        supports_portfolio_margin=False,
        supports_classic_account=True,
        account_profile="classic",
        notes="僅 USDT-M 永續合約（USDT-FUTURES）。",
    ),
    # Aster：目前僅支援 USDT-M 永續合約
    "aster": ExchangeCapabilities(
        name="Aster",
        supports_spot=False,
        supports_linear=True,
        supports_inverse=False,
        supports_unified_account=False,
        supports_portfolio_margin=False,
        supports_classic_account=True,
        account_profile="classic",
        notes="僅 USDT-M 永續合約（futures v3）。",
    ),
    "mexc": ExchangeCapabilities(
        name="MEXC",
        supports_spot=True,
        supports_linear=False,
        supports_inverse=False,
        supports_unified_account=False,
        supports_portfolio_margin=False,
        supports_classic_account=True,
        account_profile="classic",
        notes="Spot only for now; futures is a separate MEXC account/API scope.",
    ),
}


def get_capabilities(exchange: str) -> ExchangeCapabilities:
    key = exchange.lower()
    if key not in EXCHANGE_CAPABILITIES:
        raise ValueError(f"未知的交易所: {exchange}")
    return EXCHANGE_CAPABILITIES[key]


def list_exchanges() -> List[str]:
    return list(EXCHANGE_CAPABILITIES.keys())


def is_trade_type_supported(exchange: str, trade_type: TradeType) -> bool:
    caps = get_capabilities(exchange)
    if trade_type == TradeType.SPOT:
        return caps.supports_spot
    if trade_type == TradeType.LINEAR:
        return caps.supports_linear
    if trade_type == TradeType.INVERSE:
        return caps.supports_inverse
    return False


def get_supported_trade_types(exchange: str) -> List[str]:
    return get_capabilities(exchange).supported_trade_types()


def as_dict(exchange: str) -> Dict[str, Any]:
    caps = get_capabilities(exchange)
    data = asdict(caps)
    data["supportedTradeTypes"] = caps.supported_trade_types()
    return data


def get_account_profile(exchange: str) -> str:
    """返回統一帳戶型態標識：pm | unified | classic"""
    return get_capabilities(exchange).account_profile


def is_unified_like(exchange: str) -> bool:
    """是否為統一帳戶（包含 Binance 與 Bybit）。"""
    profile = get_account_profile(exchange)
    return profile == "unified"


def get_normalized_profile(exchange: str) -> str:
    """回傳 normalized 型態：unified 或 classic。"""
    profile = get_account_profile(exchange)
    return "unified" if profile == "unified" else "classic"
