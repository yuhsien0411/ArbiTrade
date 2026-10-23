from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.api.response import api_error, api_success
from app.services.trade_record_service import TradeRecordQuery, trade_record_service
from app.utils.logger import get_logger


router = APIRouter()
logger = get_logger()


def parse_date(value: Optional[str]):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return datetime.fromisoformat(value).date()


@router.get("/trade-records")
async def get_trade_records(
    type: Literal["all", "arbitrage", "twap"] = Query("all"),
    symbol: Optional[str] = Query(None),
    exchange: Optional[str] = Query(None),
    result: Literal["all", "success", "failed", "manual_cancel", "rolled_back"] = Query("all"),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    try:
        query = TradeRecordQuery(
            record_type=type,
            symbol=symbol,
            exchange=exchange,
            result=result,
            from_date=parse_date(from_date),
            to_date=parse_date(to_date),
            limit=limit,
            offset=offset,
        )
        return api_success(trade_record_service.query_records(query))
    except Exception as exc:
        logger.error("trade_records_query_failed", error=str(exc))
        return api_error("Failed to fetch trade records", error=str(exc), status_code=500)


@router.get("/trade-records/export")
async def export_trade_records(
    type: Literal["all", "arbitrage", "twap"] = Query("all"),
    symbol: Optional[str] = Query(None),
    exchange: Optional[str] = Query(None),
    result: Literal["all", "success", "failed", "manual_cancel", "rolled_back"] = Query("all"),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
):
    try:
        query = TradeRecordQuery(
            record_type=type,
            symbol=symbol,
            exchange=exchange,
            result=result,
            from_date=parse_date(from_date),
            to_date=parse_date(to_date),
            limit=50000,
            offset=0,
        )
        csv_text = trade_record_service.export_csv(query, export_limit=50000)
        filename = f"trade_records_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return Response(
            content="\ufeff" + csv_text,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ValueError as exc:
        return api_error("Export limit exceeded", error=str(exc), status_code=400)
    except Exception as exc:
        logger.error("trade_records_export_failed", error=str(exc))
        return api_error("Failed to export trade records", error=str(exc), status_code=500)
