"""
報告 API 路由
提供套利和 TWAP 執行記錄的統計報告
"""

from fastapi import APIRouter, Query
from typing import Optional, Literal
from datetime import datetime
import logging

from ..services.report_service import report_service
from ..services.net_value_service import net_value_service
from ..services.net_value_scheduler import net_value_scheduler
from .response import api_success, api_error

router = APIRouter(prefix="/api/report", tags=["reports"])
logger = logging.getLogger(__name__)


def parse_date(date_str: Optional[str]) -> Optional[datetime]:
    """解析日期字符串為 datetime 對象"""
    if not date_str:
        return None

    try:
        for fmt in ["%Y-%m-%d", "%Y%m%d", "%Y-%m-%d %H:%M:%S"]:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue

        return datetime.fromisoformat(date_str)
    except Exception as e:
        logger.error(f"日期解析失敗: {date_str}, {e}")
        return None


@router.get("/summary")
async def get_report_summary(
    from_date: Optional[str] = Query(None, description="開始日期 (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="結束日期 (YYYY-MM-DD)"),
    type: Literal["all", "arbitrage", "twap"] = Query("all", description="報告類型"),
):
    """獲取績效總覽"""
    try:
        from_dt = parse_date(from_date)
        to_dt = parse_date(to_date)

        logger.info(f"獲取報告總覽: from={from_date}, to={to_date}, type={type}")
        summary = report_service.get_summary(from_dt, to_dt, type)
        return api_success(summary)
    except Exception as e:
        logger.error(f"獲取報告總覽失敗: {e}", exc_info=True)
        return api_error("獲取報告總覽失敗", error=str(e), status_code=500)


@router.get("/arbitrage")
async def get_arbitrage_report(
    from_date: Optional[str] = Query(None, description="開始日期 (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="結束日期 (YYYY-MM-DD)"),
    group_by: Literal["strategy", "symbol", "exchange"] = Query("strategy", description="分組方式"),
):
    """獲取套利報告（按策略ID聚合）"""
    try:
        from_dt = parse_date(from_date)
        to_dt = parse_date(to_date)

        logger.info(f"獲取套利報告: from={from_date}, to={to_date}, group_by={group_by}")
        report = report_service.get_arbitrage_report(from_dt, to_dt, group_by)
        return api_success(report)
    except Exception as e:
        logger.error(f"獲取套利報告失敗: {e}", exc_info=True)
        return api_error("獲取套利報告失敗", error=str(e), status_code=500)


@router.get("/twap")
async def get_twap_report(
    from_date: Optional[str] = Query(None, description="開始日期 (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="結束日期 (YYYY-MM-DD)"),
    group_by: Literal["strategy", "symbol", "exchange"] = Query("strategy", description="分組方式"),
):
    """獲取 TWAP 報告（按策略ID聚合）"""
    try:
        from_dt = parse_date(from_date)
        to_dt = parse_date(to_date)

        logger.info(f"獲取 TWAP 報告: from={from_date}, to={to_date}, group_by={group_by}")
        report = report_service.get_twap_report(from_dt, to_dt, group_by)
        return api_success(report)
    except Exception as e:
        logger.error(f"獲取 TWAP 報告失敗: {e}", exc_info=True)
        return api_error("獲取 TWAP 報告失敗", error=str(e), status_code=500)


@router.get("/net-value/stats")
async def get_net_value_stats(
    from_date: Optional[str] = Query(None, description="開始日期 (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="結束日期 (YYYY-MM-DD)"),
):
    """獲取帳戶淨值統計"""
    try:
        from_dt = parse_date(from_date)
        to_dt = parse_date(to_date)

        logger.info(f"獲取淨值統計: from={from_date}, to={to_date}")
        stats = net_value_service.get_net_value_stats(from_dt, to_dt)
        return api_success(stats)
    except Exception as e:
        logger.error(f"獲取淨值統計失敗: {e}", exc_info=True)
        return api_error("獲取淨值統計失敗", error=str(e), status_code=500)


@router.get("/net-value/history")
async def get_net_value_history(
    from_date: Optional[str] = Query(None, description="開始日期 (YYYY-MM-DD)"),
    to_date: Optional[str] = Query(None, description="結束日期 (YYYY-MM-DD)"),
):
    """獲取帳戶淨值歷史記錄"""
    try:
        from_dt = parse_date(from_date)
        to_dt = parse_date(to_date)

        logger.info(f"獲取淨值歷史: from={from_date}, to={to_date}")
        records = net_value_service.get_net_value_history(from_dt, to_dt)

        # 轉換數據格式以匹配前端期望
        formatted_records = []
        for record in records:
            formatted_records.append({
                "timestamp": record.get("ts", 0) // 1000,  # 轉換為秒級時間戳
                "datetime": record.get("datetime", ""),
                "totalValue": record.get("totalUSDT", 0.0),
                "exchanges": record.get("balances", {}),
                "exchangeTotals": record.get("exchangeTotals", {}),
            })

        return api_success(formatted_records)
    except Exception as e:
        logger.error(f"獲取淨值歷史失敗: {e}", exc_info=True)
        return api_error("獲取淨值歷史失敗", error=str(e), status_code=500)


@router.post("/net-value/record")
async def record_net_value(balances: dict):
    """手動記錄當前帳戶淨值"""
    try:
        logger.info(f"記錄淨值: {balances}")
        record = net_value_service.record_net_value(balances)
        return api_success(record)
    except Exception as e:
        logger.error(f"記錄淨值失敗: {e}", exc_info=True)
        return api_error("記錄淨值失敗", error=str(e), status_code=500)


@router.post("/net-value/generate-sample")
async def generate_sample_net_value(
    days: int = Query(30, description="生成天數"),
    clear_old: bool = Query(True, description="是否清空舊數據"),
):
    """生成示例淨值數據（用於測試和演示）"""
    try:
        import random
        from datetime import timedelta
        import shutil

        if clear_old:
            net_value_dir = net_value_service.net_value_dir
            if net_value_dir.exists():
                shutil.rmtree(net_value_dir)
                net_value_dir.mkdir(parents=True, exist_ok=True)
                logger.info("已清空舊的淨值數據")

        logger.info(f"生成 {days} 天的示例淨值數據")

        start_date = datetime.now() - timedelta(days=days)
        initial_balance = 10000.0
        current_balance = initial_balance
        total_records = 0

        for day_offset in range(days + 1):
            current_date = start_date + timedelta(days=day_offset)

            for hour in range(24):
                timestamp = current_date.replace(hour=hour, minute=0, second=0, microsecond=0)

                change_percent = random.uniform(-0.3, 0.4)
                current_balance = current_balance * (1 + change_percent / 100)

                if random.random() < 0.03:
                    event_change = random.uniform(-1, 1.5)
                    current_balance = current_balance * (1 + event_change / 100)

                current_balance = max(current_balance, initial_balance * 0.92)
                current_balance = min(current_balance, initial_balance * 1.5)

                bybit_ratio = random.uniform(0.35, 0.45)
                binance_ratio = random.uniform(0.25, 0.35)
                okx_ratio = random.uniform(0.15, 0.25)
                bitget_ratio = 1 - bybit_ratio - binance_ratio - okx_ratio

                balances = {
                    "bybit": {"USDT": round(current_balance * bybit_ratio, 2)},
                    "binance": {"USDT": round(current_balance * binance_ratio, 2)},
                    "okx": {"USDT": round(current_balance * okx_ratio, 2)},
                    "bitget": {"USDT": round(current_balance * bitget_ratio, 2)},
                }

                record = {
                    "ts": int(timestamp.timestamp() * 1000),
                    "datetime": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                    "totalUSDT": round(current_balance, 2),
                    "balances": balances,
                }

                import json
                filepath = net_value_service._get_file_path(timestamp)
                with open(filepath, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(record, ensure_ascii=False) + '\n')

                total_records += 1

        return api_success({
            "total_records": total_records,
            "initial_balance": initial_balance,
            "final_balance": current_balance,
            "profit": round(current_balance - initial_balance, 2),
            "profit_percent": round((current_balance / initial_balance - 1) * 100, 2),
        })
    except Exception as e:
        logger.error(f"生成示例數據失敗: {e}", exc_info=True)
        return api_error("生成示例數據失敗", error=str(e), status_code=500)


@router.get("/net-value/scheduler/status")
async def get_scheduler_status():
    """獲取淨值自動記錄狀態"""
    try:
        return api_success({
            "running": net_value_scheduler.is_running(),
            "interval_seconds": net_value_scheduler.interval_seconds,
            "interval_display": (
                f"{net_value_scheduler.interval_seconds // 3600} 小時"
                if net_value_scheduler.interval_seconds >= 3600
                else f"{net_value_scheduler.interval_seconds // 60} 分鐘"
            ),
        })
    except Exception as e:
        logger.error(f"獲取調度器狀態失敗: {e}", exc_info=True)
        return api_error(str(e), status_code=500)


@router.post("/net-value/scheduler/start")
async def start_scheduler(interval_hours: int = Query(1, description="記錄間隔（小時）")):
    """啟動淨值自動記錄"""
    try:
        interval_seconds = interval_hours * 3600
        net_value_scheduler.start(interval_seconds)

        return api_success({
            "running": True,
            "interval_seconds": interval_seconds,
            "message": f"淨值自動記錄已啟動，每 {interval_hours} 小時記錄一次",
        })
    except Exception as e:
        logger.error(f"啟動調度器失敗: {e}", exc_info=True)
        return api_error("啟動淨值自動記錄失敗", error=str(e), status_code=500)


@router.post("/net-value/scheduler/stop")
async def stop_scheduler():
    """停止淨值自動記錄"""
    try:
        net_value_scheduler.stop()
        return api_success({"running": False, "message": "淨值自動記錄已停止"})
    except Exception as e:
        logger.error(f"停止調度器失敗: {e}", exc_info=True)
        return api_error("停止淨值自動記錄失敗", error=str(e), status_code=500)


@router.post("/net-value/record-now")
async def record_net_value_now():
    """立即記錄一次淨值（手動觸發）"""
    try:
        await net_value_scheduler.record_net_value_once()
        return api_success({"message": "淨值記錄成功"})
    except Exception as e:
        logger.error(f"立即記錄淨值失敗: {e}", exc_info=True)
        return api_error("記錄淨值失敗", error=str(e), status_code=500)
