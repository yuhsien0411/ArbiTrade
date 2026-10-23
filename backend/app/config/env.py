"""
環境變數配置模組
處理 .env 檔案載入和環境變數管理
"""

import os
from typing import Optional
from dotenv import load_dotenv
from pathlib import Path

# 載入 .env 檔案
env_path = Path(__file__).parent.parent.parent.parent / ".env"
load_dotenv(env_path)

class EnvConfig:
    """環境變數配置類別"""
    
    @property
    def DEBUG(self) -> bool:
        return os.getenv("DEBUG", "false").lower() == "true"
    
    @property
    def LOG_LEVEL(self) -> str:
        return os.getenv("LOG_LEVEL", "INFO")
    
    @property
    def BYBIT_API_KEY(self) -> Optional[str]:
        return os.getenv("BYBIT_API_KEY")
    
    @property
    def BYBIT_SECRET(self) -> Optional[str]:
        return os.getenv("BYBIT_SECRET")
    
    @property
    def BINANCE_API_KEY(self) -> Optional[str]:
        return os.getenv("BINANCE_API_KEY")
    
    @property
    def BINANCE_SECRET(self) -> Optional[str]:
        return os.getenv("BINANCE_SECRET")
    
    @property
    def BINANCE_USE_PORTFOLIO_MARGIN(self) -> bool:
        """Binance 是否使用統一交易帳戶（Portfolio Margin）
        默認為 True，可以通過環境變數 BINANCE_USE_PORTFOLIO_MARGIN=false 關閉
        """
        return os.getenv("BINANCE_USE_PORTFOLIO_MARGIN", "true").lower() == "true"
    
    @property
    def OKX_API_KEY(self) -> Optional[str]:
        return os.getenv("OKX_API_KEY")
    
    @property
    def OKX_SECRET(self) -> Optional[str]:
        return os.getenv("OKX_SECRET")
    
    @property
    def OKX_PASSWORD(self) -> Optional[str]:
        return os.getenv("OKX_PASSWORD")
    
    @property
    def BITGET_API_KEY(self) -> Optional[str]:
        return os.getenv("BITGET_API_KEY")
    
    @property
    def BITGET_SECRET(self) -> Optional[str]:
        return os.getenv("BITGET_SECRET")
    
    @property
    def BITGET_PASSWORD(self) -> Optional[str]:
        return os.getenv("BITGET_PASSWORD")

    @property
    def ASTER_USER(self) -> Optional[str]:
        return os.getenv("ASTER_USER")

    @property
    def ASTER_SIGNER(self) -> Optional[str]:
        return os.getenv("ASTER_SIGNER")

    @property
    def ASTER_PRIVATE_KEY(self) -> Optional[str]:
        return os.getenv("ASTER_PRIVATE_KEY")

    @property
    def MEXC_API_KEY(self) -> Optional[str]:
        return os.getenv("MEXC_SPOT_API_KEY") or os.getenv("MEXC_API_KEY")

    @property
    def MEXC_SECRET(self) -> Optional[str]:
        return os.getenv("MEXC_SPOT_SECRET") or os.getenv("MEXC_SECRET")
    
    def _is_valid_api_key(self, key: Optional[str]) -> bool:
        """檢查 API 密鑰是否有效（不是佔位符）"""
        if not key:
            return False
        # 排除常見的佔位符
        placeholders = ["your_", "example_", "placeholder_", "test_", "demo_"]
        is_valid = not any(key.lower().startswith(p) for p in placeholders)
        
        return is_valid
    
    def get_exchange_config(self, exchange: str) -> dict:
        """取得指定交易所的 API 設定"""
        if exchange.lower() == "bybit":
            has_valid_keys = (
                self._is_valid_api_key(self.BYBIT_API_KEY) and 
                self._is_valid_api_key(self.BYBIT_SECRET)
            )
            return {
                "apiKey": self.BYBIT_API_KEY or "",
                "secret": self.BYBIT_SECRET or "",
                "connected": has_valid_keys,
                "publicOnly": not has_valid_keys
            }
        elif exchange.lower() == "binance":
            has_valid_keys = (
                self._is_valid_api_key(self.BINANCE_API_KEY) and 
                self._is_valid_api_key(self.BINANCE_SECRET)
            )
            return {
                "apiKey": self.BINANCE_API_KEY or "",
                "secret": self.BINANCE_SECRET or "",
                "connected": has_valid_keys,
                "publicOnly": not has_valid_keys,
                "use_portfolio_margin": self.BINANCE_USE_PORTFOLIO_MARGIN
            }
        elif exchange.lower() == "okx":
            has_valid_keys = (
                self._is_valid_api_key(self.OKX_API_KEY) and 
                self._is_valid_api_key(self.OKX_SECRET) and
                self._is_valid_api_key(self.OKX_PASSWORD)
            )
            return {
                "apiKey": self.OKX_API_KEY or "",
                "secret": self.OKX_SECRET or "",
                "password": self.OKX_PASSWORD or "",
                "connected": has_valid_keys,
                "publicOnly": not has_valid_keys
            }
        elif exchange.lower() == "bitget":
            has_valid_keys = (
                self._is_valid_api_key(self.BITGET_API_KEY) and 
                self._is_valid_api_key(self.BITGET_SECRET) and
                self._is_valid_api_key(self.BITGET_PASSWORD)
            )
            return {
                "apiKey": self.BITGET_API_KEY or "",
                "secret": self.BITGET_SECRET or "",
                "password": self.BITGET_PASSWORD or "",
                "connected": has_valid_keys,
                "publicOnly": not has_valid_keys
            }
        elif exchange.lower() == "aster":
            has_valid_keys = (
                self._is_valid_api_key(self.ASTER_USER) and
                self._is_valid_api_key(self.ASTER_SIGNER) and
                self._is_valid_api_key(self.ASTER_PRIVATE_KEY)
            )
            return {
                "apiKey": self.ASTER_USER or "",
                "secret": self.ASTER_PRIVATE_KEY or "",
                "signer": self.ASTER_SIGNER or "",
                "connected": has_valid_keys,
                "publicOnly": not has_valid_keys
            }
        elif exchange.lower() == "mexc":
            has_valid_keys = (
                self._is_valid_api_key(self.MEXC_API_KEY) and
                self._is_valid_api_key(self.MEXC_SECRET)
            )
            return {
                "apiKey": self.MEXC_API_KEY or "",
                "secret": self.MEXC_SECRET or "",
                "connected": has_valid_keys,
                "publicOnly": not has_valid_keys
            }
        else:
            return {
                "apiKey": "",
                "secret": "",
                "connected": False,
                "publicOnly": True
            }
    
    def get_all_exchanges_config(self) -> dict:
        """取得所有交易所的 API 設定"""
        return {
            "bybit": self.get_exchange_config("bybit"),
            "binance": self.get_exchange_config("binance"),
            "okx": self.get_exchange_config("okx"),
            "bitget": self.get_exchange_config("bitget"),
            "aster": self.get_exchange_config("aster"),
            "mexc": self.get_exchange_config("mexc"),
        }
    
    def get_all_exchanges_status(self) -> dict:
        """可提供給前端的設定狀態；不包含憑證或錢包地址。"""
        statuses = {}
        for exchange, settings in self.get_all_exchanges_config().items():
            status = {
                "connected": settings["connected"],
                "publicOnly": settings["publicOnly"],
                "hasApiKey": bool(settings.get("apiKey")),
                "hasSecret": bool(settings.get("secret")),
            }
            if exchange in ("okx", "bitget"):
                status["hasPassword"] = bool(settings.get("password"))
            if exchange == "aster":
                status["hasSigner"] = bool(settings.get("signer"))
            statuses[exchange] = status
        return statuses

    def validate_api_keys(self) -> dict:
        """驗證 API 金鑰格式"""
        errors = []
        warnings = []
        
        # 檢查 Bybit API 金鑰
        if self.BYBIT_API_KEY:
            if len(self.BYBIT_API_KEY) < 10:
                errors.append("BYBIT_API_KEY 格式不正確（長度不足）")
            if not self.BYBIT_SECRET:
                errors.append("BYBIT_SECRET 缺失")
            elif len(self.BYBIT_SECRET) < 10:
                errors.append("BYBIT_SECRET 格式不正確（長度不足）")
        elif self.BYBIT_SECRET:
            errors.append("BYBIT_API_KEY 缺失")
        
        # 檢查 Binance API 金鑰
        if self.BINANCE_API_KEY:
            if len(self.BINANCE_API_KEY) < 10:
                errors.append("BINANCE_API_KEY 格式不正確（長度不足）")
            if not self.BINANCE_SECRET:
                errors.append("BINANCE_SECRET 缺失")
            elif len(self.BINANCE_SECRET) < 10:
                errors.append("BINANCE_SECRET 格式不正確（長度不足）")
        elif self.BINANCE_SECRET:
            errors.append("BINANCE_API_KEY 缺失")
        
        # 檢查 OKX API 金鑰
        if self.OKX_API_KEY:
            if len(self.OKX_API_KEY) < 10:
                errors.append("OKX_API_KEY 格式不正確（長度不足）")
            if not self.OKX_SECRET:
                errors.append("OKX_SECRET 缺失")
            elif len(self.OKX_SECRET) < 10:
                errors.append("OKX_SECRET 格式不正確（長度不足）")
            if not self.OKX_PASSWORD:
                errors.append("OKX_PASSWORD 缺失")
        elif self.OKX_SECRET or self.OKX_PASSWORD:
            errors.append("OKX_API_KEY 缺失")
        
        # 檢查 Bitget API 金鑰
        if self.BITGET_API_KEY:
            if len(self.BITGET_API_KEY) < 10:
                errors.append("BITGET_API_KEY 格式不正確（長度不足）")
            if not self.BITGET_SECRET:
                errors.append("BITGET_SECRET 缺失")
            elif len(self.BITGET_SECRET) < 10:
                errors.append("BITGET_SECRET 格式不正確（長度不足）")
            if not self.BITGET_PASSWORD:
                errors.append("BITGET_PASSWORD 缺失")
        elif self.BITGET_SECRET or self.BITGET_PASSWORD:
            errors.append("BITGET_API_KEY 缺失")
        
        # 檢查是否至少配置了一個交易所
        if self.MEXC_API_KEY:
            if len(self.MEXC_API_KEY) < 10:
                errors.append("MEXC_SPOT_API_KEY is too short")
            if not self.MEXC_SECRET:
                errors.append("MEXC_SPOT_SECRET is missing")
            elif len(self.MEXC_SECRET) < 10:
                errors.append("MEXC_SPOT_SECRET is too short")
        elif self.MEXC_SECRET:
            errors.append("MEXC_SPOT_API_KEY is missing")

        if not (self.BYBIT_API_KEY and self.BYBIT_SECRET) and \
           not (self.BINANCE_API_KEY and self.BINANCE_SECRET) and \
           not (self.OKX_API_KEY and self.OKX_SECRET and self.OKX_PASSWORD) and \
           not (self.BITGET_API_KEY and self.BITGET_SECRET and self.BITGET_PASSWORD) and \
           not (self.ASTER_USER and self.ASTER_SIGNER and self.ASTER_PRIVATE_KEY) and \
           not (self.MEXC_API_KEY and self.MEXC_SECRET):
            warnings.append("未配置任何交易所 API 金鑰，將只能使用公開數據")
        
        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "bybit_configured": bool(self.BYBIT_API_KEY and self.BYBIT_SECRET),
            "binance_configured": bool(self.BINANCE_API_KEY and self.BINANCE_SECRET),
            "okx_configured": bool(self.OKX_API_KEY and self.OKX_SECRET and self.OKX_PASSWORD),
            "bitget_configured": bool(self.BITGET_API_KEY and self.BITGET_SECRET and self.BITGET_PASSWORD),
            "aster_configured": bool(self.ASTER_USER and self.ASTER_SIGNER and self.ASTER_PRIVATE_KEY),
            "mexc_configured": bool(self.MEXC_API_KEY and self.MEXC_SECRET),
        }
    
    def is_configured(self) -> bool:
        """檢查是否有任何交易所已配置 API 金鑰"""
        bybit_configured = bool(self.BYBIT_API_KEY and self.BYBIT_SECRET)
        binance_configured = bool(self.BINANCE_API_KEY and self.BINANCE_SECRET)
        okx_configured = bool(self.OKX_API_KEY and self.OKX_SECRET and self.OKX_PASSWORD)
        bitget_configured = bool(self.BITGET_API_KEY and self.BITGET_SECRET and self.BITGET_PASSWORD)
        aster_configured = bool(self.ASTER_USER and self.ASTER_SIGNER and self.ASTER_PRIVATE_KEY)
        mexc_configured = bool(self.MEXC_API_KEY and self.MEXC_SECRET)
        return bybit_configured or binance_configured or okx_configured or bitget_configured or aster_configured or mexc_configured

# 創建全域配置實例
config = EnvConfig()
