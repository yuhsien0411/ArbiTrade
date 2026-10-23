"""
環境變數檔案管理模組
處理 .env 檔案的讀取、更新和寫入
"""

import os
import re
from pathlib import Path
from typing import Dict, Optional
from ..utils.logger import get_logger

logger = get_logger()

class EnvManager:
    """環境變數檔案管理器"""
    
    def __init__(self):
        self.env_path = Path(__file__).parent.parent.parent.parent / ".env"
        self.backup_path = Path(__file__).parent.parent.parent.parent / ".env.backup"
    
    def read_env_file(self) -> Dict[str, str]:
        """讀取 .env 檔案內容"""
        env_vars = {}
        
        if not self.env_path.exists():
            logger.warning("env_file_not_found", path=str(self.env_path))
            return env_vars
        
        try:
            with open(self.env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        key, value = line.split('=', 1)
                        env_vars[key.strip()] = value.strip()
            
            logger.info("env_file_read", count=len(env_vars))
            return env_vars
            
        except Exception as e:
            logger.error("env_file_read_error", error=str(e))
            return {}
    
    def write_env_file(self, env_vars: Dict[str, str]) -> bool:
        """寫入 .env 檔案"""
        try:
            # 備份原檔案
            if self.env_path.exists():
                self._backup_env_file()
            
            # 寫入新內容
            with open(self.env_path, 'w', encoding='utf-8') as f:
                f.write("# 交易所 API 設定\n")
                f.write("# 請勿將此檔案提交到版本控制\n\n")
                
                # 寫入 Bybit 設定
                f.write("# Bybit API 設定\n")
                f.write(f"BYBIT_API_KEY={env_vars.get('BYBIT_API_KEY', '')}\n")
                f.write(f"BYBIT_SECRET={env_vars.get('BYBIT_SECRET', '')}\n\n")
                
                # 寫入 Binance 設定（支援 Portfolio Margin 統一帳戶）
                f.write("# Binance API 設定（支援 Portfolio Margin 統一帳戶）\n")
                f.write(f"BINANCE_API_KEY={env_vars.get('BINANCE_API_KEY', '')}\n")
                f.write(f"BINANCE_SECRET={env_vars.get('BINANCE_SECRET', '')}\n")
                f.write(f"BINANCE_USE_PORTFOLIO_MARGIN={env_vars.get('BINANCE_USE_PORTFOLIO_MARGIN', 'true')}\n\n")
                
                # 寫入 OKX 設定（全倉合約 + 槓桿現貨）
                f.write("# OKX API 設定（全倉合約 + 槓桿現貨）\n")
                f.write(f"OKX_API_KEY={env_vars.get('OKX_API_KEY', '')}\n")
                f.write(f"OKX_SECRET={env_vars.get('OKX_SECRET', '')}\n")
                f.write(f"OKX_PASSWORD={env_vars.get('OKX_PASSWORD', '')}\n\n")
                
                # 寫入 Bitget 設定（僅支援 USDT-M 永續合約）
                f.write("# Bitget API 設定（僅支援 USDT-M 永續合約）\n")
                f.write(f"BITGET_API_KEY={env_vars.get('BITGET_API_KEY', '')}\n")
                f.write(f"BITGET_SECRET={env_vars.get('BITGET_SECRET', '')}\n")
                f.write(f"BITGET_PASSWORD={env_vars.get('BITGET_PASSWORD', '')}\n\n")

                f.write("# MEXC Spot API\n")
                f.write(f"MEXC_SPOT_API_KEY={env_vars.get('MEXC_SPOT_API_KEY', env_vars.get('MEXC_API_KEY', ''))}\n")
                f.write(f"MEXC_SPOT_SECRET={env_vars.get('MEXC_SPOT_SECRET', env_vars.get('MEXC_SECRET', ''))}\n\n")

                # 寫入 Aster 設定（合約 v3, EIP-712 簽名）
                f.write("# Aster API 設定（合約 v3）\n")
                f.write(f"ASTER_USER={env_vars.get('ASTER_USER', '')}\n")
                f.write(f"ASTER_SIGNER={env_vars.get('ASTER_SIGNER', '')}\n")
                f.write(f"ASTER_PRIVATE_KEY={env_vars.get('ASTER_PRIVATE_KEY', '')}\n\n")
                
                # 寫入系統設定
                f.write("# 系統設定\n")
                f.write(f"DEBUG={env_vars.get('DEBUG', 'false')}\n")
                f.write(f"LOG_LEVEL={env_vars.get('LOG_LEVEL', 'INFO')}\n")

                # 保留 CORS 等其他設定，避免在網頁更新金鑰時將它們刪除。
                managed_keys = {
                    "BYBIT_API_KEY", "BYBIT_SECRET", "BINANCE_API_KEY", "BINANCE_SECRET",
                    "BINANCE_USE_PORTFOLIO_MARGIN", "OKX_API_KEY", "OKX_SECRET", "OKX_PASSWORD",
                    "BITGET_API_KEY", "BITGET_SECRET", "BITGET_PASSWORD",
                    "MEXC_SPOT_API_KEY", "MEXC_SPOT_SECRET", "MEXC_API_KEY", "MEXC_SECRET",
                    "ASTER_USER", "ASTER_SIGNER", "ASTER_PRIVATE_KEY", "DEBUG", "LOG_LEVEL",
                }
                for key, value in env_vars.items():
                    if key not in managed_keys:
                        f.write(f"{key}={value}\n")
            
            logger.info("env_file_written", path=str(self.env_path))
            return True
            
        except Exception as e:
            logger.error("env_file_write_error", error=str(e))
            return False
    
    def update_api_keys(
        self,
        exchange: str,
        api_key: Optional[str] = None,
        secret: Optional[str] = None,
        password: Optional[str] = None,
        signer: Optional[str] = None,
    ) -> bool:
        """更新指定交易所的 API 金鑰
        
        Args:
            exchange: 交易所名稱（bybit, binance, okx, bitget）
            api_key: API Key
            secret: Secret Key
            password: API Password（OKX 和 Bitget 需要）
        """
        try:
            # 讀取現有設定
            env_vars = self.read_env_file()
            
            # 更新指定交易所的設定
            exchange_lower = exchange.lower()
            
            if exchange_lower == 'bybit':
                if api_key is not None:
                    env_vars['BYBIT_API_KEY'] = api_key
                if secret is not None:
                    env_vars['BYBIT_SECRET'] = secret
            elif exchange_lower == 'binance':
                if api_key is not None:
                    env_vars['BINANCE_API_KEY'] = api_key
                if secret is not None:
                    env_vars['BINANCE_SECRET'] = secret
            elif exchange_lower == 'okx':
                if api_key is not None:
                    env_vars['OKX_API_KEY'] = api_key
                if secret is not None:
                    env_vars['OKX_SECRET'] = secret
                if password is not None:
                    env_vars['OKX_PASSWORD'] = password
            elif exchange_lower == 'bitget':
                if api_key is not None:
                    env_vars['BITGET_API_KEY'] = api_key
                if secret is not None:
                    env_vars['BITGET_SECRET'] = secret
                if password is not None:
                    env_vars['BITGET_PASSWORD'] = password
            elif exchange_lower == 'aster':
                if api_key is not None:
                    env_vars['ASTER_USER'] = api_key
                if signer is not None:
                    env_vars['ASTER_SIGNER'] = signer
                if secret is not None:
                    env_vars['ASTER_PRIVATE_KEY'] = secret
            elif exchange_lower == 'mexc':
                if api_key is not None:
                    env_vars['MEXC_SPOT_API_KEY'] = api_key
                if secret is not None:
                    env_vars['MEXC_SPOT_SECRET'] = secret
            else:
                logger.error("unsupported_exchange", exchange=exchange)
                return False
            
            # 寫入更新後的設定
            success = self.write_env_file(env_vars)
            
            if success:
                logger.info("api_keys_updated", exchange=exchange)
                # 更新環境變數
                self._update_environment_variables(env_vars)
            
            return success
            
        except Exception as e:
            logger.error("update_api_keys_error", error=str(e))
            return False
    
    def clear_api_keys(self, exchange: str) -> bool:
        """清除指定交易所的 API 金鑰"""
        return self.update_api_keys(exchange, api_key="", secret="", password="", signer="")
    
    def _backup_env_file(self) -> bool:
        """備份 .env 檔案"""
        try:
            if self.env_path.exists():
                import shutil
                shutil.copy2(self.env_path, self.backup_path)
                logger.info("env_file_backed_up", backup_path=str(self.backup_path))
                return True
        except Exception as e:
            logger.error("env_file_backup_error", error=str(e))
        return False
    
    def _update_environment_variables(self, env_vars: Dict[str, str]) -> None:
        """更新環境變數"""
        for key, value in env_vars.items():
            os.environ[key] = value

# 創建全域實例
env_manager = EnvManager()
