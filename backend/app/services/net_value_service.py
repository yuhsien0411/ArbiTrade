"""
帳戶淨值記錄服務
定時記錄所有交易所的帳戶餘額，用於追蹤資產變化趨勢
"""
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from collections import defaultdict

logger = logging.getLogger(__name__)


class NetValueService:
    """帳戶淨值記錄服務"""
    
    def __init__(self, data_dir: str = "../data"):
        self.data_dir = Path(data_dir)
        self.net_value_dir = self.data_dir / "net_value"
        self.net_value_dir.mkdir(parents=True, exist_ok=True)
        
        # 記錄文件格式：net_value_YYYYMMDD.jsonl
        
    def _get_file_path(self, date: datetime) -> Path:
        """獲取指定日期的淨值記錄文件路徑"""
        filename = f"net_value_{date.strftime('%Y%m%d')}.jsonl"
        return self.net_value_dir / filename
    
    def record_net_value(self, balances: Dict[str, Dict[str, float]]) -> Dict:
        """
        記錄當前時刻的帳戶淨值
        
        Args:
            balances: {
                "bybit": {"USDT": 4441.03, "LA": 0.01769585, ...},  # USDT 值為 total_equity_usdt，其他為 usdt_value
                "binance": {"USDT": 2000.0, ...}
            }
            注意：如果使用 account_summary，USDT 字段存儲的是 total_equity_usdt（總 USD 淨值）
            其他幣種字段存儲的是該幣種的 usdt_value（USD 價值）
        
        Returns:
            記錄的淨值數據
        """
        now = datetime.now()
        timestamp = int(now.timestamp() * 1000)  # 毫秒時間戳
        
        total_usdt = 0.0
        normalized_balances: Dict[str, Dict[str, float]] = {}
        exchange_totals: Dict[str, float] = {}

        for exchange, raw_data in balances.items():
            if not isinstance(raw_data, dict):
                continue

            # 新格式：{"exchangeTotalUSDT": x, "assets": {...}}
            if "exchangeTotalUSDT" in raw_data or "assets" in raw_data:
                raw_total = raw_data.get("exchangeTotalUSDT")
                if isinstance(raw_total, (int, float)):
                    exchange_totals[exchange] = float(raw_total)

                assets = raw_data.get("assets", {})
                cleaned_assets: Dict[str, float] = {}
                if isinstance(assets, dict):
                    for asset, value in assets.items():
                        if isinstance(value, (int, float)):
                            cleaned_assets[asset] = float(value)
                normalized_balances[exchange] = cleaned_assets
                continue

            # 舊格式：{"USDT": ..., "BTC": ...}
            legacy_assets: Dict[str, float] = {}
            for asset, value in raw_data.items():
                if isinstance(value, (int, float)):
                    legacy_assets[asset] = float(value)

            normalized_balances[exchange] = legacy_assets
            if legacy_assets:
                # 舊資料沒有獨立 equity 欄位時，以資產估值總和作為交易所淨值
                exchange_totals[exchange] = sum(legacy_assets.values())

        total_usdt = sum(exchange_totals.values())
        
        record = {
            "ts": timestamp,
            "datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
            "totalUSDT": round(total_usdt, 2),
            "balances": normalized_balances,
            "exchangeTotals": {k: round(v, 2) for k, v in exchange_totals.items()}
        }
        
        # 寫入文件
        try:
            filepath = self._get_file_path(now)
            with open(filepath, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
            
            logger.info(f"記錄帳戶淨值: {total_usdt:.2f} USD（已包含所有資產的 USD 估值）")
            return record
        except Exception as e:
            logger.error(f"記錄淨值失敗: {e}")
            raise
    
    def get_net_value_history(
        self,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None
    ) -> List[Dict]:
        """
        獲取淨值歷史記錄
        
        Returns:
            [{
                "ts": 1234567890000,
                "datetime": "2025-10-17 10:00:00",
                "totalUSDT": 1000.0,
                "balances": {...}
            }]
        """
        records = []
        
        # 確定日期範圍
        if from_date is None:
            from_date = datetime.now() - timedelta(days=30)  # 默認最近30天
        if to_date is None:
            to_date = datetime.now()
        
        # 生成需要讀取的文件列表
        current = from_date
        while current <= to_date:
            filepath = self._get_file_path(current)
            if filepath.exists():
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                record = json.loads(line)
                                # 過濾時間範圍
                                record_ts = record.get('ts', 0)
                                if from_date.timestamp() * 1000 <= record_ts <= (to_date + timedelta(days=1)).timestamp() * 1000:
                                    records.append(record)
                except Exception as e:
                    logger.error(f"讀取淨值記錄失敗 {filepath}: {e}")
            
            current += timedelta(days=1)
        
        # 按時間戳排序
        records.sort(key=lambda x: x.get('ts', 0))
        
        logger.info(f"讀取到 {len(records)} 條淨值記錄")
        return records
    
    def get_net_value_stats(
        self,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None
    ) -> Dict:
        """
        獲取淨值統計信息
        
        Returns:
            {
                "current": 1000.0,  # 當前淨值
                "change24h": 50.0,  # 24小時變化
                "change24hPercent": 5.0,  # 24小時變化百分比
                "change7d": 100.0,  # 7天變化
                "change7dPercent": 10.0,  # 7天變化百分比
                "highest": 1100.0,  # 期間最高
                "lowest": 900.0,  # 期間最低
                "records": [...]  # 歷史記錄
            }
        """
        records = self.get_net_value_history(from_date, to_date)
        
        if not records:
            return {
                "current": 0.0,
                "change24h": 0.0,
                "change24hPercent": 0.0,
                "change7d": 0.0,
                "change7dPercent": 0.0,
                "highest": 0.0,
                "lowest": 0.0,
                "records": []
            }
        
        # 當前淨值（最新記錄）
        current = records[-1].get('totalUSDT', 0.0)
        
        # 24小時前的淨值
        now = datetime.now()
        ts_24h_ago = (now - timedelta(hours=24)).timestamp() * 1000
        records_24h = [r for r in records if r.get('ts', 0) >= ts_24h_ago]
        value_24h_ago = records_24h[0].get('totalUSDT', current) if records_24h else current
        change_24h = current - value_24h_ago
        change_24h_percent = (change_24h / value_24h_ago * 100) if value_24h_ago > 0 else 0
        
        # 7天前的淨值
        ts_7d_ago = (now - timedelta(days=7)).timestamp() * 1000
        records_7d = [r for r in records if r.get('ts', 0) >= ts_7d_ago]
        value_7d_ago = records_7d[0].get('totalUSDT', current) if records_7d else current
        change_7d = current - value_7d_ago
        change_7d_percent = (change_7d / value_7d_ago * 100) if value_7d_ago > 0 else 0
        
        # 最高和最低
        all_values = [r.get('totalUSDT', 0.0) for r in records]
        highest = max(all_values) if all_values else 0.0
        lowest = min(all_values) if all_values else 0.0
        
        return {
            "current": round(current, 2),
            "change24h": round(change_24h, 2),
            "change24hPercent": round(change_24h_percent, 2),
            "change7d": round(change_7d, 2),
            "change7dPercent": round(change_7d_percent, 2),
            "highest": round(highest, 2),
            "lowest": round(lowest, 2),
            "records": records
        }


# 全局實例
net_value_service = NetValueService()

