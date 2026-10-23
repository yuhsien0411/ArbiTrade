from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Literal, Optional

from app.utils.logger import get_logger


TradeRecordType = Literal["all", "arbitrage", "twap"]
TradeRecordResult = Literal["all", "success", "failed", "manual_cancel", "rolled_back"]


@dataclass(frozen=True)
class TradeRecordQuery:
    record_type: TradeRecordType = "all"
    symbol: Optional[str] = None
    exchange: Optional[str] = None
    result: TradeRecordResult = "all"
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    limit: int = 100
    offset: int = 0


class TradeRecordService:
    def __init__(self, data_dir: Optional[Path] = None):
        repo_root = Path(__file__).resolve().parents[3]
        self.data_dir = data_dir or repo_root / "data"
        self.arbitrage_dir = self.data_dir / "arbitrage"
        self.twap_dir = self.data_dir / "twap"
        self.logger = get_logger()

    def query_records(self, query: TradeRecordQuery) -> Dict[str, Any]:
        records = self._load_filtered_records(query)
        total = len(records)
        page = records[query.offset : query.offset + query.limit]

        return {
            "records": page,
            "total": total,
            "limit": query.limit,
            "offset": query.offset,
            "hasMore": query.offset + query.limit < total,
        }

    def export_csv(self, query: TradeRecordQuery, export_limit: int = 50000) -> str:
        records = self._load_filtered_records(query)
        if len(records) > export_limit:
            raise ValueError(f"export limit exceeded: {len(records)} records, max {export_limit}")

        output = io.StringIO()
        fieldnames = [
            "datetime",
            "ts",
            "mode",
            "result_type",
            "display_reason",
            "raw_status",
            "raw_reason",
            "error",
            "strategy_id",
            "pair_id",
            "twap_id",
            "qty",
            "total_amount",
            "order_count",
            "spread",
            "spread_percent",
            "threshold",
            "interval_ms",
            "is_rollback",
            "leg1_exchange",
            "leg1_symbol",
            "leg1_type",
            "leg1_side",
            "leg1_price",
            "leg1_order_id",
            "leg1_order_transport",
            "leg2_exchange",
            "leg2_symbol",
            "leg2_type",
            "leg2_side",
            "leg2_price",
            "leg2_order_id",
            "leg2_order_transport",
        ]
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()

        for record in records:
            leg1 = record.get("leg1") or {}
            leg2 = record.get("leg2") or {}
            writer.writerow(
                {
                    "datetime": record.get("datetime"),
                    "ts": record.get("ts"),
                    "mode": record.get("mode"),
                    "result_type": record.get("resultType"),
                    "display_reason": record.get("displayReason"),
                    "raw_status": record.get("status"),
                    "raw_reason": record.get("reason"),
                    "error": record.get("error"),
                    "strategy_id": record.get("strategyId"),
                    "pair_id": record.get("pairId"),
                    "twap_id": record.get("twapId"),
                    "qty": record.get("qty"),
                    "total_amount": record.get("totalAmount"),
                    "order_count": record.get("orderCount"),
                    "spread": record.get("spread"),
                    "spread_percent": record.get("spreadPercent"),
                    "threshold": record.get("threshold"),
                    "interval_ms": record.get("intervalMs"),
                    "is_rollback": record.get("isRollback"),
                    "leg1_exchange": leg1.get("exchange"),
                    "leg1_symbol": leg1.get("symbol"),
                    "leg1_type": leg1.get("type"),
                    "leg1_side": leg1.get("side"),
                    "leg1_price": leg1.get("price"),
                    "leg1_order_id": leg1.get("orderId"),
                    "leg1_order_transport": leg1.get("orderTransport"),
                    "leg2_exchange": leg2.get("exchange"),
                    "leg2_symbol": leg2.get("symbol"),
                    "leg2_type": leg2.get("type"),
                    "leg2_side": leg2.get("side"),
                    "leg2_price": leg2.get("price"),
                    "leg2_order_id": leg2.get("orderId"),
                    "leg2_order_transport": leg2.get("orderTransport"),
                }
            )

        return output.getvalue()

    def _load_filtered_records(self, query: TradeRecordQuery) -> List[Dict[str, Any]]:
        records: List[Dict[str, Any]] = []

        if query.record_type in ("all", "arbitrage"):
            records.extend(self._read_directory(self.arbitrage_dir, "arbitrage", query))
        if query.record_type in ("all", "twap"):
            records.extend(self._read_directory(self.twap_dir, "twap", query))

        records.sort(key=lambda item: int(item.get("ts") or 0), reverse=True)
        return records

    def _read_directory(
        self,
        directory: Path,
        normalized_mode: Literal["arbitrage", "twap"],
        query: TradeRecordQuery,
    ) -> Iterable[Dict[str, Any]]:
        for day in self._iter_dates(query.from_date, query.to_date):
            path = directory / f"executions_{day.strftime('%Y%m%d')}.jsonl"
            if not path.exists():
                continue

            try:
                with open(path, "r", encoding="utf-8") as file:
                    for line_number, line in enumerate(file, start=1):
                        line = line.strip()
                        if not line:
                            continue

                        try:
                            raw = json.loads(line)
                        except json.JSONDecodeError as exc:
                            self.logger.warning(
                                "trade_record_json_decode_failed",
                                file=str(path),
                                line=line_number,
                                error=str(exc),
                            )
                            continue

                        record = self._normalize_record(raw, normalized_mode, path, line_number)
                        if self._matches(record, query):
                            yield record
            except Exception as exc:
                self.logger.error("trade_record_file_read_failed", file=str(path), error=str(exc))

    def _iter_dates(self, from_day: Optional[date], to_day: Optional[date]) -> Iterable[date]:
        today = datetime.now().date()
        start = from_day or (today - timedelta(days=7))
        end = to_day or today
        if start > end:
            start, end = end, start

        current = start
        while current <= end:
            yield current
            current += timedelta(days=1)

    def _normalize_record(
        self,
        raw: Dict[str, Any],
        normalized_mode: Literal["arbitrage", "twap"],
        source_path: Path,
        line_number: int,
    ) -> Dict[str, Any]:
        ts = self._to_int(raw.get("ts") or raw.get("timestamp"), 0)
        result_type = self._get_result_type(raw)
        display_reason = self._get_display_reason(raw, result_type)
        leg1 = self._normalize_leg(raw.get("leg1") or {})
        leg2 = self._normalize_leg(raw.get("leg2") or {})

        return {
            "id": self._build_id(raw, normalized_mode, source_path, line_number, ts),
            "ts": ts,
            "datetime": self._format_datetime(ts),
            "mode": normalized_mode,
            "resultType": result_type,
            "status": raw.get("status"),
            "reason": raw.get("reason"),
            "error": raw.get("error"),
            "displayReason": display_reason,
            "strategyId": raw.get("strategyId") or raw.get("planId") or raw.get("pairId") or raw.get("twapId"),
            "pairId": raw.get("pairId"),
            "twapId": raw.get("twapId") or raw.get("planId"),
            "qty": raw.get("qty"),
            "totalAmount": raw.get("totalAmount"),
            "orderCount": raw.get("orderCount"),
            "spread": raw.get("spread"),
            "spreadPercent": raw.get("spreadPercent"),
            "threshold": raw.get("threshold"),
            "intervalMs": raw.get("intervalMs"),
            "isRollback": bool(raw.get("isRollback", False)),
            "leg1": leg1,
            "leg2": leg2,
        }

    def _normalize_leg(self, raw_leg: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "exchange": raw_leg.get("exchange"),
            "symbol": raw_leg.get("symbol"),
            "type": raw_leg.get("type") or raw_leg.get("category"),
            "side": raw_leg.get("side"),
            "price": raw_leg.get("price"),
            "orderId": raw_leg.get("orderId"),
            "orderTransport": raw_leg.get("orderTransport"),
            "priceUpdated": bool(raw_leg.get("priceUpdated", False)),
        }

    def _get_result_type(self, raw: Dict[str, Any]) -> str:
        status = str(raw.get("status") or "").lower()
        reason = str(raw.get("reason") or "").lower()

        if status == "cancelled" or reason == "manual":
            return "manual_cancel"
        if status == "rolled_back" or raw.get("isRollback") is True or reason == "rollback":
            return "rolled_back"
        if status == "failed" or raw.get("success") is False:
            return "failed"
        if status == "success" or raw.get("success") is True:
            return "success"
        return "failed"

    def _get_display_reason(self, raw: Dict[str, Any], result_type: str) -> str:
        if result_type == "success":
            return ""
        if result_type == "manual_cancel":
            return "手動取消"
        if result_type == "rolled_back":
            return "已回滾"

        error = raw.get("error")
        reason = raw.get("reason")
        if error:
            return str(error)
        if reason:
            return str(reason)
        return "--"

    def _matches(self, record: Dict[str, Any], query: TradeRecordQuery) -> bool:
        if query.result != "all":
            results = {
                item.strip()
                for item in query.result.split(",")
                if item.strip() and item.strip() != "all"
            }
            if results and record.get("resultType") not in results:
                return False

        if query.symbol:
            symbol = query.symbol.strip().upper()
            leg1_symbol = str((record.get("leg1") or {}).get("symbol") or "").upper()
            leg2_symbol = str((record.get("leg2") or {}).get("symbol") or "").upper()
            if symbol not in leg1_symbol and symbol not in leg2_symbol:
                return False

        if query.exchange:
            exchanges = {
                item.strip().lower()
                for item in query.exchange.split(",")
                if item.strip()
            }
            leg1_exchange = str((record.get("leg1") or {}).get("exchange") or "").lower()
            leg2_exchange = str((record.get("leg2") or {}).get("exchange") or "").lower()
            if exchanges and leg1_exchange not in exchanges and leg2_exchange not in exchanges:
                return False

        return True

    def _build_id(
        self,
        raw: Dict[str, Any],
        normalized_mode: str,
        source_path: Path,
        line_number: int,
        ts: int,
    ) -> str:
        strategy_id = raw.get("strategyId") or raw.get("planId") or raw.get("pairId") or raw.get("twapId")
        if strategy_id:
            return f"{normalized_mode}_{strategy_id}_{ts}_{line_number}"
        return f"{normalized_mode}_{source_path.stem}_{line_number}_{ts}"

    def _format_datetime(self, ts: int) -> str:
        if not ts:
            return ""
        try:
            return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return ""

    def _to_int(self, value: Any, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default


trade_record_service = TradeRecordService()
