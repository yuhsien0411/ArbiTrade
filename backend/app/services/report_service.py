"""
報告服務：聚合套利和 TWAP 執行記錄，生成績效報告
"""

import json
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Literal
from collections import defaultdict
import logging

logger = logging.getLogger(__name__)


class ReportService:
    """報告服務：處理套利和 TWAP 執行記錄的聚合與統計"""
    
    def __init__(self, data_dir: str = "../data"):
        self.data_dir = Path(data_dir)
        self.arbitrage_dir = self.data_dir / "arbitrage"
        self.twap_dir = self.data_dir / "twap"
        
        # 確保目錄存在
        self.arbitrage_dir.mkdir(parents=True, exist_ok=True)
        self.twap_dir.mkdir(parents=True, exist_ok=True)
    
    def _read_jsonl_files(
        self, 
        directory: Path, 
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None
    ) -> List[Dict]:
        """讀取指定日期範圍的 JSONL 文件"""
        records = []
        
        # 如果沒有指定日期，讀取所有文件
        if from_date is None and to_date is None:
            pattern = "executions_*.jsonl"
        else:
            # 生成日期範圍內的文件列表
            from_dt = from_date or datetime.now() - timedelta(days=365)
            to_dt = to_date or datetime.now()
            
            current = from_dt
            target_files = []
            while current <= to_dt:
                filename = f"executions_{current.strftime('%Y%m%d')}.jsonl"
                target_files.append(filename)
                current += timedelta(days=1)
            
            # 讀取這些文件
            logger.info(f"準備讀取文件列表: {target_files}")
            for filename in target_files:
                filepath = directory / filename
                logger.info(f"檢查文件: {filepath}, 存在: {filepath.exists()}")
                if filepath.exists():
                    try:
                        with open(filepath, 'r', encoding='utf-8') as f:
                            for line in f:
                                line = line.strip()
                                if line:
                                    record = json.loads(line)
                                    # 過濾時間範圍（to_date 應該包含當天結束時間 23:59:59）
                                    record_ts = record.get('ts', 0)
                                    if from_date and record_ts < from_date.timestamp() * 1000:
                                        continue
                                    # to_date 加一天再比較，這樣可以包含當天的所有記錄
                                    if to_date:
                                        to_date_end = (to_date + timedelta(days=1)).timestamp() * 1000
                                        if record_ts >= to_date_end:
                                            continue
                                    records.append(record)
                            logger.info(f"從 {filepath} 讀取到 {len([r for r in records if r])} 條記錄")
                    except Exception as e:
                        logger.error(f"讀取文件失敗 {filepath}: {e}")
            
            logger.info(f"總共讀取到 {len(records)} 條記錄")
            return records
        
        # 讀取所有匹配的文件
        for filepath in directory.glob(pattern):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            record = json.loads(line)
                            # 過濾時間範圍（to_date 應該包含當天結束時間 23:59:59）
                            if from_date or to_date:
                                record_ts = record.get('ts', 0)
                                if from_date and record_ts < from_date.timestamp() * 1000:
                                    continue
                                # to_date 加一天再比較，這樣可以包含當天的所有記錄
                                if to_date:
                                    to_date_end = (to_date + timedelta(days=1)).timestamp() * 1000
                                    if record_ts >= to_date_end:
                                        continue
                            records.append(record)
            except Exception as e:
                logger.error(f"讀取文件失敗 {filepath}: {e}")
        
        return records
    
    def get_summary(
        self,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None,
        report_type: Literal["all", "arbitrage", "twap"] = "all"
    ) -> Dict:
        """
        獲取總覽統計
        
        Returns:
            {
                "totalPnl": float,  # 總盈虧 (USDT)
                "winRate": float,   # 勝率 (%)
                "totalVolume": float,  # 總成交量
                "completedStrategies": int,  # 完成策略數
                "successCount": int,  # 成功次數
                "failedCount": int   # 失敗次數
            }
        """
        total_pnl = 0.0
        total_volume = 0.0
        success_count = 0
        failed_count = 0
        completed_strategies = set()
        
        # 處理套利記錄
        if report_type in ["all", "arbitrage"]:
            arb_records = self._read_jsonl_files(self.arbitrage_dir, from_date, to_date)
            logger.info(f"讀取到 {len(arb_records)} 條套利記錄")
            for record in arb_records:
                if record.get('status') == 'success':
                    success_count += 1
                    qty = record.get('qty', 0)
                    total_volume += qty
                    
                    # 計算盈虧：(賣價 - 買價) × 數量
                    leg1 = record.get('leg1', {})
                    leg2 = record.get('leg2', {})
                    leg1_price = leg1.get('price', 0)
                    leg2_price = leg2.get('price', 0)
                    leg1_side = leg1.get('side', 'buy')
                    leg2_side = leg2.get('side', 'sell')
                    
                    if leg1_price and leg2_price:
                        # 確定買價和賣價
                        buy_price = leg1_price if leg1_side == 'buy' else leg2_price
                        sell_price = leg1_price if leg1_side == 'sell' else leg2_price
                        pnl = (sell_price - buy_price) * qty
                        total_pnl += pnl
                    
                    # 記錄完成的策略
                    pair_id = record.get('pairId')
                    if pair_id:
                        completed_strategies.add(pair_id)
                elif record.get('status') in ['failed', 'cancelled']:
                    failed_count += 1
        
        # 處理 TWAP 記錄
        if report_type in ["all", "twap"]:
            twap_records = self._read_jsonl_files(self.twap_dir, from_date, to_date)
            logger.info(f"讀取到 {len(twap_records)} 條 TWAP 記錄")
            
            # 按策略聚合
            strategy_legs = defaultdict(list)
            for record in twap_records:
                plan_id = record.get('planId')
                if plan_id:
                    strategy_legs[plan_id].append(record)
            
            # 計算每個策略的統計
            for plan_id, legs in strategy_legs.items():
                successful_legs = [leg for leg in legs if leg.get('success')]
                failed_legs = [leg for leg in legs if not leg.get('success')]
                
                # TWAP 以PAIRS為一次成功
                strategy_success = len(successful_legs) // 2
                strategy_failed = len(failed_legs)
                
                success_count += strategy_success
                failed_count += strategy_failed
                
                # 計算成交量和盈虧
                for leg in successful_legs:
                    qty = leg.get('qty', 0)
                    total_volume += qty
                    
                    # TWAP 盈虧計算：暫時簡化為 0（需要更複雜的配對邏輯）
                    # TODO: 配對 leg1 和 leg2 計算價差盈虧
                
                # 如果策略完成，記錄
                if strategy_success > 0:
                    completed_strategies.add(plan_id)
        
        # 計算勝率
        total_count = success_count + failed_count
        win_rate = (success_count / total_count * 100) if total_count > 0 else 0
        
        return {
            "totalPnl": round(total_pnl, 2),
            "winRate": round(win_rate, 2),
            "totalVolume": round(total_volume, 4),
            "completedStrategies": len(completed_strategies),
            "successCount": success_count,
            "failedCount": failed_count
        }
    
    def get_arbitrage_report(
        self,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None,
        group_by: Literal["strategy", "symbol", "exchange"] = "strategy"
    ) -> List[Dict]:
        """
        獲取套利報告（按策略ID聚合）
        
        Returns:
            List[{
                "strategyId": str,
                "lastTime": int,  # 時間戳
                "leg1Symbol": str,
                "leg1Exchange": str,
                "leg1Type": str,
                "leg1Side": str,
                "leg2Symbol": str,
                "leg2Exchange": str,
                "leg2Type": str,
                "leg2Side": str,
                "avgSpreadPercent": float,  # 平均價差%
                "successCount": int,  # 成功次數
                "maxExecs": int,  # 目標次數
                "totalVolume": float,  # 總成交量
                "estimatedPnl": float,  # 估算盈虧 (USDT)
                "status": str  # 完成/進行中/失敗
            }]
        """
        records = self._read_jsonl_files(self.arbitrage_dir, from_date, to_date)
        
        # 按策略ID聚合
        strategies = defaultdict(lambda: {
            "records": [],
            "successCount": 0,
            "totalVolume": 0,
            "totalSpread": 0,
            "totalPnl": 0,
            "maxExecs": 0,
            "lastTime": 0
        })
        
        for record in records:
            pair_id = record.get('pairId')
            if not pair_id:
                continue
            
            strategy = strategies[pair_id]
            strategy["records"].append(record)
            strategy["lastTime"] = max(strategy["lastTime"], record.get('ts', 0))
            # 使用最大值，因為失敗記錄可能有錯誤的 maxExecs
            current_max = record.get('maxExecs', 0)
            if current_max > 0:
                strategy["maxExecs"] = max(strategy["maxExecs"], current_max)
            
            if record.get('status') == 'success':
                strategy["successCount"] += 1
                qty = record.get('qty', 0)
                strategy["totalVolume"] += qty
                
                # 計算價差和盈虧
                leg1 = record.get('leg1', {})
                leg2 = record.get('leg2', {})
                leg1_price = leg1.get('price')
                leg2_price = leg2.get('price')
                leg1_side = leg1.get('side', 'buy')
                leg2_side = leg2.get('side', 'sell')
                
                # 優先使用記錄中已計算的 spreadPercent
                spread_percent = record.get('spreadPercent')
                if spread_percent is not None:
                    strategy["totalSpread"] += spread_percent
                elif leg1_price and leg2_price:
                    # 如果沒有 spreadPercent，則從價格計算
                    buy_price = leg1_price if leg1_side == 'buy' else leg2_price
                    sell_price = leg1_price if leg1_side == 'sell' else leg2_price
                    spread_percent = ((sell_price - buy_price) / buy_price * 100) if buy_price > 0 else 0
                    strategy["totalSpread"] += spread_percent
                
                # 計算盈虧（只有當兩個價格都存在時才計算）
                if leg1_price and leg2_price:
                    buy_price = leg1_price if leg1_side == 'buy' else leg2_price
                    sell_price = leg1_price if leg1_side == 'sell' else leg2_price
                    pnl = (sell_price - buy_price) * qty
                    strategy["totalPnl"] += pnl
        
        # 轉換為列表格式
        result = []
        for pair_id, data in strategies.items():
            if not data["records"]:
                continue
            
            # 使用第一條記錄的配置信息
            first_record = data["records"][0]
            leg1 = first_record.get('leg1', {})
            leg2 = first_record.get('leg2', {})
            
            # 計算平均價差
            avg_spread = (data["totalSpread"] / data["successCount"]) if data["successCount"] > 0 else 0
            
            # 判斷狀態
            status = "進行中"
            if data["maxExecs"] > 0 and data["successCount"] >= data["maxExecs"]:
                status = "完成"
            elif any(r.get('status') == 'failed' for r in data["records"]):
                status = "失敗"
            
            result.append({
                "strategyId": pair_id,
                "lastTime": data["lastTime"],
                "leg1Symbol": leg1.get('symbol', 'N/A'),
                "leg1Exchange": leg1.get('exchange', 'N/A'),
                "leg1Type": leg1.get('type', 'spot'),
                "leg1Side": leg1.get('side', 'buy'),
                "leg2Symbol": leg2.get('symbol', 'N/A'),
                "leg2Exchange": leg2.get('exchange', 'N/A'),
                "leg2Type": leg2.get('type', 'spot'),
                "leg2Side": leg2.get('side', 'sell'),
                "avgSpreadPercent": round(avg_spread, 4),
                "successCount": data["successCount"],
                "maxExecs": data["maxExecs"],
                "totalVolume": round(data["totalVolume"], 4),
                "estimatedPnl": round(data["totalPnl"], 2),
                "status": status
            })
        
        # 按最後時間排序
        result.sort(key=lambda x: x["lastTime"], reverse=True)
        return result
    
    def get_twap_report(
        self,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None,
        group_by: Literal["strategy", "symbol", "exchange"] = "strategy"
    ) -> List[Dict]:
        """
        獲取 TWAP 報告（按策略ID聚合）
        
        Returns:
            List[{
                "strategyId": str,
                "lastTime": int,
                "leg1Symbol": str,
                "leg1Exchange": str,
                "leg1Type": str,
                "leg1Side": str,
                "leg2Symbol": str,
                "leg2Exchange": str,
                "leg2Type": str,
                "leg2Side": str,
                "executedCount": int,  # 已執行次數
                "targetCount": int,  # 目標次數
                "sliceQty": float,  # 單次數量
                "totalVolume": float,  # 總數量
                "avgInterval": float,  # 平均間隔(秒)
                "status": str,  # 完成/暫停/取消/失敗
                "estimatedPnl": float  # 估算盈虧
            }]
        """
        records = self._read_jsonl_files(self.twap_dir, from_date, to_date)
        
        # 按策略ID聚合
        strategies = defaultdict(lambda: {
            "legs": [],
            "timestamps": [],
            "totalVolume": 0,
            "lastTime": 0
        })
        
        for record in records:
            plan_id = record.get('planId')
            if not plan_id:
                continue
            
            strategy = strategies[plan_id]
            strategy["legs"].append(record)
            strategy["timestamps"].append(record.get('ts', 0))
            strategy["lastTime"] = max(strategy["lastTime"], record.get('ts', 0))
            
            if record.get('success'):
                qty = record.get('qty', 0)
                strategy["totalVolume"] += qty
        
        # 轉換為列表格式
        result = []
        for plan_id, data in strategies.items():
            if not data["legs"]:
                continue
            
            # 使用第一條記錄的配置信息
            legs_by_index = defaultdict(list)
            for leg in data["legs"]:
                leg_idx = leg.get('legIndex', 0)
                legs_by_index[leg_idx].append(leg)
            
            # 獲取 leg1 和 leg2 信息
            leg1_records = legs_by_index.get(0, [])
            leg2_records = legs_by_index.get(1, [])
            
            leg1_info = leg1_records[0] if leg1_records else {}
            leg2_info = leg2_records[0] if leg2_records else {}
            
            # 計算執行次數（PAIRS為一次）
            successful_legs = [leg for leg in data["legs"] if leg.get('success')]
            executed_count = len(successful_legs) // 2
            
            # 計算平均間隔（TWAP 特性：按 legIndex 分組計算，因為第一次是立即執行）
            # 只計算同一個 leg 的連續執行之間的間隔
            timestamps = sorted(data["timestamps"])
            avg_interval = 0
            
            # 按 legIndex 分組計算間隔
            leg0_times = sorted([leg.get('ts', 0) for leg in data["legs"] if leg.get('legIndex') == 0 and leg.get('success')])
            leg1_times = sorted([leg.get('ts', 0) for leg in data["legs"] if leg.get('legIndex') == 1 and leg.get('success')])
            
            all_intervals = []
            # 計算 leg0 的間隔（跳過第一次，因為第一次是立即執行）
            if len(leg0_times) > 1:
                all_intervals.extend([leg0_times[i+1] - leg0_times[i] for i in range(len(leg0_times)-1)])
            # 計算 leg1 的間隔（跳過第一次）
            if len(leg1_times) > 1:
                all_intervals.extend([leg1_times[i+1] - leg1_times[i] for i in range(len(leg1_times)-1)])
            
            if all_intervals:
                avg_interval = sum(all_intervals) / len(all_intervals) / 1000  # 轉換為秒
            
            # 計算單次數量（使用第一次成功執行的數量）
            slice_qty = 0
            if successful_legs:
                slice_qty = successful_legs[0].get('qty', 0)
            
            # 判斷狀態
            status = "完成"  # 執行記錄中的都是歷史記錄，預設為完成
            if any(not leg.get('success') for leg in data["legs"]):
                status = "失敗"
            
            # 估算目標次數（基於總量和單次數量）
            target_count = executed_count  # 預設與執行次數相同
            if slice_qty > 0 and data["totalVolume"] > 0:
                target_count = int(data["totalVolume"] / slice_qty / 2)  # 除以2因為是PAIRS
            
            result.append({
                "strategyId": plan_id,
                "lastTime": data["lastTime"],
                "leg1Symbol": leg1_info.get('symbol', 'N/A'),
                "leg1Exchange": leg1_info.get('exchange', 'N/A'),
                "leg1Type": leg1_info.get('type', 'spot'),
                "leg1Side": leg1_info.get('side', 'buy'),
                "leg2Symbol": leg2_info.get('symbol', 'N/A'),
                "leg2Exchange": leg2_info.get('exchange', 'N/A'),
                "leg2Type": leg2_info.get('type', 'linear'),
                "leg2Side": leg2_info.get('side', 'sell'),
                "executedCount": executed_count,
                "targetCount": max(target_count, executed_count),  # 確保目標不小於已執行
                "sliceQty": round(slice_qty, 4),
                "totalVolume": round(data["totalVolume"], 4),
                "avgInterval": round(avg_interval, 2),
                "status": status,
                "estimatedPnl": 0  # TODO: 配對計算盈虧
            })
        
        # 按最後時間排序
        result.sort(key=lambda x: x["lastTime"], reverse=True)
        return result


# 創建全局實例
report_service = ReportService()

