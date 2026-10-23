"""
倉位監控 API 路由
"""

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
import asyncio
import time

from ..config.env import config
from ..exchanges.factory import ExchangeFactory
from ..services.hedge_analyzer import HedgeAnalyzer, ExposureSummary
from ..exchanges.base import AccountSummary, FundingRate, BorrowingRate
from ..services.cache_manager import TTLCache
from ..utils.logger import get_logger
from .response import api_success

router = APIRouter()
logger = get_logger()
_positions_summary_cache = TTLCache(default_ttl_seconds=15.0)
_positions_summary_lock = asyncio.Lock()
_positions_summary_inflight: asyncio.Task | None = None


def _serialize_balance(balance) -> dict:
    return {
        "asset": balance.asset,
        "total": balance.total,
        "free": balance.free,
        "locked": balance.locked,
        "borrowed": balance.borrowed,
        "interest": balance.interest,
        "interestRateDaily": balance.interest_rate_daily,
        "usdtValue": balance.usdt_value,
        "netBalance": balance.net_balance
    }


def _serialize_position(position) -> dict:
    return {
        "symbol": position.symbol,
        "baseAsset": position.base_asset,
        "quoteAsset": position.quote_asset,
        "type": position.position_type,
        "side": position.side,
        "sizeBase": position.size,
        "entryPrice": position.entry_price,
        "markPrice": position.mark_price,
        "liquidationPrice": position.liquidation_price,
        "leverage": position.leverage,
        "marginMode": position.margin_mode,
        "marginUSDT": position.margin_usdt,
        "notionalUSDT": position.notional_value,
        "unrealizedPnlUSDT": position.unrealized_pnl,
        "realizedPnlUSDT": position.realized_pnl,
        "realizedPnlDetails": position.realized_pnl_details or {},
        "fundingRate8h": position.funding_rate_8h,
        "nextFundingTime": position.next_funding_time,
        "estimatedCarry8h": position.estimated_carry_8h
    }


def _serialize_account_summary(account: AccountSummary) -> dict:
    return {
        "exchange": account.exchange,
        "accountMode": account.account_mode,
        "timestamp": account.timestamp,
        "totalEquityUSDT": account.total_equity_usdt,
        "totalMarginUSDT": account.total_margin_usdt,
        "availableBalanceUSDT": account.available_balance_usdt,
        "marginRatio": account.margin_ratio,
        "maintenanceMarginRate": account.maintenance_margin_rate,
        "totalInitialMargin": account.total_initial_margin,
        "totalMaintenanceMargin": account.total_maintenance_margin,
        "balances": [_serialize_balance(b) for b in account.balances],
        "positions": [_serialize_position(p) for p in account.positions],
        "unsupportedReason": account.unsupported_reason
    }


def _serialize_position_exposure(exposure) -> dict:
    return {
        "exchange": exposure.exchange,
        "type": exposure.position_type,
        "side": exposure.side,
        "sizeBase": exposure.size_base,
        "notionalUSDT": exposure.notional_usdt,
        "carry8h": exposure.carry_8h,
        "fundingRate8h": exposure.funding_rate_8h,
        "interestRateDaily": exposure.interest_rate_daily
    }


def _serialize_exposure_summary(summary: ExposureSummary) -> dict:
    return {
        "baseAsset": summary.base_asset,
        "positions": [_serialize_position_exposure(p) for p in summary.positions],
        "longBase": summary.long_base,
        "shortBase": summary.short_base,
        "netBase": summary.net_base,
        "longNotionalUSDT": summary.long_notional_usdt,
        "shortNotionalUSDT": summary.short_notional_usdt,
        "netNotionalUSDT": summary.net_notional_usdt,
        "hedgeRatio": summary.hedge_ratio,
        "hedgeStatus": summary.hedge_status,
        "netCarry8h": summary.net_carry_8h,
        "netCarryDaily": summary.net_carry_daily,
        "riskLevel": summary.risk_level,
        "suggestions": summary.suggestions
    }


async def _collect_positions_summary() -> dict:
    """收集持倉摘要資料（不含回應包裝），供其他端點復用。"""
    exchanges_config = config.get_all_exchanges_config()
    accounts: List[AccountSummary] = []
    unsupported_exchanges: List[dict] = []

    logger.info(
        "positions_summary_start",
        exchanges=list(exchanges_config.keys()),
        configs={
            k: {"connected": v.get("connected"), "has_key": bool(v.get("apiKey"))}
            for k, v in exchanges_config.items()
        },
    )

    for exchange_name, exchange_config in exchanges_config.items():
        try:
            if not exchange_config.get("connected", False):
                logger.info(
                    f"positions_summary_skip_{exchange_name}_no_valid_keys",
                    connected=exchange_config.get("connected"),
                    has_apikey=bool(exchange_config.get("apiKey")),
                    has_secret=bool(exchange_config.get("secret")),
                    has_password=bool(exchange_config.get("password")),
                )
                continue

            exchange = ExchangeFactory.create_from_config(exchange_name)
            account_summary = await exchange.get_account_summary()
            accounts.append(account_summary)

            if account_summary.account_mode == "unsupported":
                unsupported_exchanges.append({
                    "exchange": exchange_name,
                    "reason": account_summary.unsupported_reason,
                })

            logger.debug(
                f"positions_summary_{exchange_name}_success",
                account_mode=account_summary.account_mode,
            )

        except Exception as e:
            logger.error(f"positions_summary_{exchange_name}_failed", error=str(e))
            continue

    analyzer = HedgeAnalyzer()
    exposures = analyzer.analyze_exposures(accounts)

    return {
        "timestamp": int(time.time() * 1000),
        "accounts": [_serialize_account_summary(acc) for acc in accounts],
        "exposures": [_serialize_exposure_summary(exp) for exp in exposures],
        "unsupportedExchanges": unsupported_exchanges,
    }


async def _get_cached_positions_summary() -> dict:
    """Share the expensive account summary call across frequent UI refreshes."""
    global _positions_summary_inflight

    cache_key = "positions:summary"
    cached = await _positions_summary_cache.get(cache_key)
    if cached is not None:
        return cached

    async with _positions_summary_lock:
        cached = await _positions_summary_cache.get(cache_key)
        if cached is not None:
            return cached

        if _positions_summary_inflight is None or _positions_summary_inflight.done():
            _positions_summary_inflight = asyncio.create_task(_collect_positions_summary())
        task = _positions_summary_inflight

    result = await task
    await _positions_summary_cache.set(cache_key, result)
    return result


@router.get("/positions/summary")
async def get_positions_summary():
    """獲取所有交易所的持倉與餘額匯總"""
    try:
        return api_success(await _get_cached_positions_summary())
    except Exception as e:
        logger.error("positions_summary_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": str(e)},
        )


@router.get("/funding-rates")
async def get_funding_rates(
    exchange: Optional[str] = Query(None, description="交易所名稱"),
    symbols: Optional[str] = Query(None, description="交易對列表，逗號分隔"),
):
    """獲取資金費率"""
    try:
        exchanges_config = config.get_all_exchanges_config()
        all_funding_rates: List[dict] = []

        exchange_list = [exchange] if exchange else list(exchanges_config.keys())
        symbol_list = symbols.split(",") if symbols else None

        for exchange_name in exchange_list:
            try:
                exchange_config = exchanges_config.get(exchange_name)
                if not exchange_config:
                    continue

                exchange_instance = ExchangeFactory.create_from_config(exchange_name)
                funding_rates = await exchange_instance.get_funding_rates(symbol_list)

                for fr in funding_rates:
                    all_funding_rates.append({
                        "exchange": fr.exchange,
                        "symbol": fr.symbol,
                        "category": fr.category,
                        "fundingRate": fr.funding_rate,
                        "fundingRate8h": fr.funding_rate_8h,
                        "fundingRateDaily": fr.funding_rate_daily,
                        "nextFundingTime": fr.next_funding_time,
                        "predictedFundingRate": fr.predicted_funding_rate,
                        "settlementIntervalHours": fr.settlement_interval_hours,
                        "timestamp": fr.timestamp,
                    })

                logger.info(f"funding_rates_{exchange_name}_success", count=len(funding_rates))

            except Exception as e:
                logger.error(f"funding_rates_{exchange_name}_failed", error=str(e))
                continue

        return api_success(all_funding_rates)

    except Exception as e:
        logger.error("funding_rates_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": str(e)},
        )


@router.get("/borrowing-rates")
async def get_borrowing_rates(
    exchange: Optional[str] = Query(None, description="交易所名稱（bybit/binance/okx；mexc 純現貨回空陣列）"),
    assets: Optional[str] = Query(
        None,
        description="資產列表，逗號分隔（如：USDT,BTC,ETH）。注意：Binance 必須提供此參數",
    ),
):
    """獲取槓桿現貨借幣利率（僅支援 Bybit 和 Binance）

    注意：Binance 必須提供 assets 參數，不支持查詢所有幣種
    Bybit 可以不提供 assets 參數，將返回所有幣種的利率
    MEXC 目前接入純現貨帳戶，沒有借幣/槓桿利率，回傳空陣列。
    """
    try:
        exchanges_config = config.get_all_exchanges_config()
        all_borrowing_rates: List[dict] = []

        supported_exchanges = ["bybit", "binance", "okx"]
        no_borrowing_rate_exchanges = {"mexc"}

        if exchange:
            exchange_lower = exchange.lower()
            if exchange_lower in no_borrowing_rate_exchanges:
                logger.info(f"borrowing_rates_{exchange_lower}_spot_only_empty")
                return api_success([])
            if exchange_lower not in supported_exchanges:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "UNSUPPORTED_EXCHANGE",
                        "message": f"不支援的交易所: {exchange}，目前只支援: {', '.join(supported_exchanges)}",
                    },
                )
            exchange_list = [exchange_lower]
        else:
            exchange_list = [ex for ex in supported_exchanges if ex in exchanges_config]

        asset_list = assets.split(",") if assets else None
        if asset_list:
            asset_list = [asset.strip().upper() for asset in asset_list]

        if "binance" in exchange_list and not asset_list:
            raise HTTPException(
                status_code=400,
                detail={"code": "MISSING_ASSETS", "message": "Binance 必須提供 assets 參數，不支持查詢所有幣種"},
            )

        for exchange_name in exchange_list:
            try:
                exchange_config = exchanges_config.get(exchange_name)
                if not exchange_config:
                    continue

                if exchange_name == "binance":
                    if not exchange_config.get("connected", False):
                        logger.info(f"borrowing_rates_skip_{exchange_name}_no_valid_keys")
                        continue

                exchange_instance = ExchangeFactory.create_from_config(exchange_name)
                borrowing_rates = await exchange_instance.get_borrowing_rates(asset_list)

                for br in borrowing_rates:
                    all_borrowing_rates.append({
                        "exchange": br.exchange,
                        "asset": br.asset,
                        "interestRateHourly": br.interest_rate_hourly,
                        "interestRateDaily": br.interest_rate_daily,
                        "timestamp": br.timestamp,
                    })

                logger.info(f"borrowing_rates_{exchange_name}_success", count=len(borrowing_rates))

            except Exception as e:
                logger.error(f"borrowing_rates_{exchange_name}_failed", error=str(e))
                continue

        return api_success(all_borrowing_rates)

    except HTTPException:
        raise
    except Exception as e:
        logger.error("borrowing_rates_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": str(e)},
        )


@router.get("/hedge/analysis")
async def get_hedge_analysis(
    base_asset: Optional[str] = Query(None, description="指定基礎資產"),
):
    """分析當前持倉的對沖情況並提供建議"""
    try:
        summary_data = await _get_cached_positions_summary()
        exposures = summary_data["exposures"]

        if base_asset:
            exposures = [exp for exp in exposures if exp["baseAsset"] == base_asset]

        total_exposures_usdt = sum(exp["longNotionalUSDT"] + exp["shortNotionalUSDT"] for exp in exposures)
        total_net_exposure_usdt = sum(exp["netNotionalUSDT"] for exp in exposures)
        total_net_carry_8h = sum(exp["netCarry8h"] for exp in exposures)

        fully_hedged = sum(1 for exp in exposures if exp["hedgeStatus"] == "fully_hedged")
        partially_hedged = sum(1 for exp in exposures if exp["hedgeStatus"] == "partially_hedged")
        unhedged = sum(1 for exp in exposures if exp["hedgeStatus"] == "unhedged")

        if unhedged > 0 or total_net_exposure_usdt / max(total_exposures_usdt, 1) > 0.2:
            overall_risk_level = "high"
        elif partially_hedged > fully_hedged:
            overall_risk_level = "medium"
        else:
            overall_risk_level = "low"

        return api_success({
            "timestamp": summary_data["timestamp"],
            "analyses": exposures,
            "summary": {
                "totalExposuresUSDT": total_exposures_usdt,
                "totalNetExposureUSDT": total_net_exposure_usdt,
                "totalNetCarry8h": total_net_carry_8h,
                "overallRiskLevel": overall_risk_level,
                "fullyHedgedAssets": fully_hedged,
                "partiallyHedgedAssets": partially_hedged,
                "unhedgedAssets": unhedged,
            },
        })

    except Exception as e:
        logger.error("hedge_analysis_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": str(e)},
        )
