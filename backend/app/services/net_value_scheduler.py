"""
淨值自動記錄調度器
定時從交易所獲取餘額並記錄淨值
"""
import asyncio
import logging
from datetime import datetime
from typing import Any, Dict

from .net_value_service import net_value_service
from ..exchanges.factory import ExchangeFactory

logger = logging.getLogger(__name__)


class NetValueScheduler:
    """淨值記錄調度器"""
    
    def __init__(self):
        self.running = False
        self.task = None
        self.interval_seconds = 3600  # 默認每小時記錄一次
        
    async def fetch_all_balances(self) -> Dict[str, Dict[str, Any]]:
        """
        從所有交易所獲取餘額（使用 total_equity_usdt 作為總淨值）
        
        Returns:
            {
                "bybit": {
                    "exchangeTotalUSDT": 9592.33,
                    "assets": {"USDT": -65686.04, "BYUSDT": 74791.56}
                },
                ...
            }
        """
        balances = {}
        
        try:
            # 獲取所有已配置的交易所
            logger.info("正在獲取已配置的交易所列表...")
            exchanges = ExchangeFactory.get_all_configured_exchanges()
            logger.info(f"找到 {len(exchanges)} 個交易所: {list(exchanges.keys())}")
            
            if not exchanges:
                logger.warning("⚠️ 沒有找到已配置的交易所，無法記錄淨值")
                return {}
            
            for exchange_name, exchange in exchanges.items():
                try:
                    exchange_total_usdt = None
                    exchange_assets = {}
                    
                    # 優先使用 get_account_summary 獲取 total_equity_usdt（USD 淨值）
                    try:
                        # Bitget 需要 TradeType 參數
                        if exchange_name.lower() == 'bitget':
                            from ..exchanges.base import TradeType
                            account_summary = await exchange.get_account_summary(TradeType.LINEAR)
                        else:
                            account_summary = await exchange.get_account_summary()
                        
                        if account_summary and hasattr(account_summary, 'total_equity_usdt'):
                            total_equity = account_summary.total_equity_usdt
                            if total_equity is not None:
                                exchange_total_usdt = round(float(total_equity), 2)
                                logger.info(f"從 {exchange_name} 獲取到總淨值: {total_equity:.2f} USD")
                            else:
                                logger.warning(f"{exchange_name} 的 total_equity_usdt 為空")
                        
                        # 同時記錄詳細的餘額信息（用於調試和顯示）
                        if account_summary and hasattr(account_summary, 'balances'):
                            for balance_obj in account_summary.balances:
                                coin = balance_obj.asset
                                # 使用 usdt_value 如果可用（已經是 USD 價值）
                                if hasattr(balance_obj, 'usdt_value') and abs(balance_obj.usdt_value) > 0.01:
                                    exchange_assets[coin] = round(balance_obj.usdt_value, 2)
                                # 否則使用 total（數量），但這不是 USD 價值，僅用於參考
                                elif balance_obj.total > 0.001:
                                    exchange_assets[coin] = round(balance_obj.total, 8)
                    
                    except Exception as summary_error:
                        logger.warning(f"獲取 {exchange_name} account_summary 失敗: {summary_error}，嘗試使用 get_balances()")
                        
                        # 回退到使用 get_balances() 方法
                        try:
                            balance_list = await exchange.get_balances()
                            
                            if isinstance(balance_list, list):
                                for balance_obj in balance_list:
                                    coin = balance_obj.asset
                                    # 優先使用 usdt_value（已經是 USD 價值）
                                    if hasattr(balance_obj, 'usdt_value') and abs(balance_obj.usdt_value) > 0.01:
                                        exchange_assets[coin] = round(balance_obj.usdt_value, 2)
                                    else:
                                        total = balance_obj.free + balance_obj.locked
                                        if total > 0.001:
                                            exchange_assets[coin] = round(total, 8)
                            
                            logger.info(f"從 {exchange_name} 獲取到餘額: {exchange_assets}")
                        except Exception as balance_error:
                            logger.warning(f"獲取 {exchange_name} 餘額失敗: {balance_error}")
                    
                    if exchange_total_usdt is not None or exchange_assets:
                        balances[exchange_name] = {
                            "exchangeTotalUSDT": exchange_total_usdt,
                            "assets": exchange_assets
                        }
                
                except Exception as e:
                    logger.warning(f"獲取 {exchange_name} 餘額失敗: {e}")
                    continue
            
            return balances
            
        except Exception as e:
            logger.error(f"獲取餘額失敗: {e}", exc_info=True)
            return {}
    
    async def record_net_value_once(self):
        """執行一次淨值記錄"""
        try:
            logger.info("🔄 開始記錄淨值...")
            
            # 獲取所有交易所餘額（已轉換為 USD 價值）
            logger.info("正在從交易所獲取餘額...")
            balances = await self.fetch_all_balances()
            
            logger.info(f"獲取餘額結果: {balances}")
            
            if not balances:
                logger.warning("⚠️ 未獲取到任何交易所餘額，跳過本次記錄")
                return
            
            # 記錄淨值
            logger.info("正在保存淨值記錄...")
            record = net_value_service.record_net_value(balances)
            
            logger.info(f"✅ 淨值記錄成功: {record['totalUSDT']:.2f} USDT，已保存到文件")
            
        except Exception as e:
            logger.error(f"❌ 記錄淨值失敗: {e}", exc_info=True)
    
    async def _run_loop(self):
        """後台循環任務"""
        from datetime import datetime, timedelta
        
        logger.info(f"淨值自動記錄任務已啟動，間隔: {self.interval_seconds}秒")
        
        # 注意：啟動快照已經在 main.py 中執行，這裡不重複記錄
        # 計算距離下一個整點的時間
        now = datetime.now()
        next_hour = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        seconds_until_next_hour = (next_hour - now).total_seconds()
        
        logger.info(f"⏰ 下一次快照將在 {next_hour.strftime('%H:%M:%S')}（{int(seconds_until_next_hour)}秒後）")
        
        # 等待到下一個整點
        if self.running:
            try:
                await asyncio.sleep(seconds_until_next_hour)
                if self.running:
                    await self.record_net_value_once()
            except asyncio.CancelledError:
                logger.info("淨值記錄任務被取消")
                return
            except Exception as e:
                logger.error(f"首次整點記錄失敗: {e}", exc_info=True)
        
        # 之後每小時整點記錄
        while self.running:
            try:
                # 等待到下一個整點（3600秒 = 1小時）
                await asyncio.sleep(self.interval_seconds)
                
                # 執行記錄
                if self.running:
                    await self.record_net_value_once()
                    
            except asyncio.CancelledError:
                logger.info("淨值記錄任務被取消")
                break
            except Exception as e:
                logger.error(f"淨值記錄任務錯誤: {e}", exc_info=True)
                await asyncio.sleep(60)  # 出錯後等待1分鐘再試
    
    def start(self, interval_seconds: int = 3600):
        """
        啟動淨值自動記錄
        
        Args:
            interval_seconds: 記錄間隔（秒），默認3600（1小時）
        """
        if self.running:
            logger.warning("⚠️ 淨值記錄任務已在運行")
            return
        
        self.interval_seconds = interval_seconds
        self.running = True
        
        try:
            self.task = asyncio.create_task(self._run_loop())
            logger.info(f"✅ 淨值自動記錄已啟動，間隔 {interval_seconds} 秒（{interval_seconds//3600} 小時）")
        except Exception as e:
            logger.error(f"❌ 啟動淨值記錄任務失敗: {e}", exc_info=True)
            self.running = False
    
    def stop(self):
        """停止淨值自動記錄"""
        if not self.running:
            return
        
        self.running = False
        if self.task:
            self.task.cancel()
        
        logger.info("淨值自動記錄已停止")
    
    def is_running(self) -> bool:
        """檢查是否正在運行"""
        return self.running


# 全局實例
net_value_scheduler = NetValueScheduler()

