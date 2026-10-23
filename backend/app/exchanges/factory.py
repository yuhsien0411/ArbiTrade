"""
交易所工廠類
統一創建和管理交易所實例
"""

from typing import Dict, Optional, Type
from .base import BaseExchange
from .bybit import BybitExchange
from .binance import BinanceExchange
from .okx import OKXExchange
from .bitget import BitgetExchange
from .aster import AsterExchange
from .mexc import MEXCExchange
from ..config.env import config
from ..utils.logger import get_logger


class ExchangeFactory:
    """交易所工廠類"""
    
    # 註冊的交易所類別
    _exchanges: Dict[str, Type[BaseExchange]] = {
        "bybit": BybitExchange,
        "binance": BinanceExchange,
        "okx": OKXExchange,
        "bitget": BitgetExchange,
        "aster": AsterExchange,
        "mexc": MEXCExchange,
    }
    
    # 實例快取
    _instances: Dict[str, BaseExchange] = {}
    
    @classmethod
    def register_exchange(cls, name: str, exchange_class: Type[BaseExchange]):
        """註冊新的交易所類別"""
        cls._exchanges[name.lower()] = exchange_class
    
    @classmethod
    def get_supported_exchanges(cls) -> list[str]:
        """獲取支援的交易所列表"""
        return list(cls._exchanges.keys())
    
    @classmethod
    def create_exchange(
        cls, 
        name: str, 
        api_key: str = "", 
        api_secret: str = "", 
        testnet: bool = False,
        use_cache: bool = True,
        **kwargs
    ) -> BaseExchange:
        """創建交易所實例
        
        Args:
            name: 交易所名稱
            api_key: API 密鑰
            api_secret: API 密鑰
            testnet: 是否使用測試網
            use_cache: 是否使用快取
            **kwargs: 其他交易所特定參數（如 Binance 的 use_portfolio_margin）
        """
        name = name.lower()
        
        if name not in cls._exchanges:
            raise ValueError(f"不支援的交易所: {name}. 支援的交易所: {cls.get_supported_exchanges()}")
        
        # 生成快取鍵（包含額外參數）
        extra_key = "_".join(f"{k}={v}" for k, v in sorted(kwargs.items()))
        cache_key = f"{name}_{testnet}_{bool(api_key)}_{extra_key}"
        
        # 檢查快取
        if use_cache and cache_key in cls._instances:
            return cls._instances[cache_key]
        
        # 創建新實例
        exchange_class = cls._exchanges[name]
        instance = exchange_class(
            api_key=api_key, 
            api_secret=api_secret, 
            testnet=testnet,
            **kwargs
        )
        
        # 快取實例
        if use_cache:
            cls._instances[cache_key] = instance
        
        return instance
    
    @classmethod
    def create_from_config(cls, name: str, testnet: bool = False, use_cache: bool = True, **kwargs) -> BaseExchange:
        """從配置文件創建交易所實例
        
        Args:
            name: 交易所名稱
            testnet: 是否使用測試網
            use_cache: 是否使用快取
            **kwargs: 其他交易所特定參數（會覆蓋配置中的設置）
        """
        name = name.lower()
        
        # 從配置獲取 API 密鑰
        exchange_config = config.get_exchange_config(name)
        api_key = exchange_config.get("apiKey", "")
        api_secret = exchange_config.get("secret", "")
        
        # Binance 特定配置
        if name == "binance":
            # 默認啟用統一交易帳戶，除非明確設置為 False
            if "use_portfolio_margin" not in kwargs:
                kwargs["use_portfolio_margin"] = exchange_config.get("use_portfolio_margin", True)
        
        # OKX 特定配置
        if name == "okx":
            password = exchange_config.get("password", "")
            return cls.create_exchange(name, api_key, api_secret, testnet, use_cache, password=password, **kwargs)
        
        # Bitget 特定配置
        if name == "bitget":
            password = exchange_config.get("password", "")
            return cls.create_exchange(name, api_key, api_secret, testnet, use_cache, password=password, **kwargs)

        # Aster 特定配置（apiKey=user, secret=private_key, signer=api wallet）
        if name == "aster":
            signer = exchange_config.get("signer", "")
            return cls.create_exchange(name, api_key, api_secret, testnet, use_cache, signer=signer, **kwargs)
        
        return cls.create_exchange(name, api_key, api_secret, testnet, use_cache, **kwargs)
    
    @classmethod
    def get_all_configured_exchanges(cls, testnet: bool = False) -> Dict[str, BaseExchange]:
        """獲取所有已配置的交易所實例"""
        exchanges = {}
        
        for name in cls.get_supported_exchanges():
            try:
                exchange = cls.create_from_config(name, testnet)
                exchanges[name] = exchange
            except Exception as e:
                logger = get_logger()
                logger.warning(f"創建 {name} 交易所實例失敗", error=str(e))
        
        return exchanges
    
    @classmethod
    def clear_cache(cls):
        """清空實例快取"""
        cls._instances.clear()
    
    @classmethod
    def get_exchange_info(cls, name: str) -> Dict[str, any]:
        """獲取交易所資訊"""
        name = name.lower()
        
        if name not in cls._exchanges:
            return {
                "name": name,
                "supported": False,
                "connected": False,
                "error": f"不支援的交易所: {name}"
            }
        
        try:
            # 創建公開實例（不需要 API 密鑰）
            exchange = cls.create_exchange(name)
            
            # 從配置檢查是否有 API 密鑰
            exchange_config = config.get_exchange_config(name)
            has_credentials = bool(exchange_config.get("apiKey")) and bool(exchange_config.get("secret"))
            
            return {
                "name": exchange.name,
                "supported": True,
                "connected": exchange_config.get("connected", False),
                "authenticated": has_credentials,
                "public_only": not has_credentials,
                "class": exchange.__class__.__name__
            }
            
        except Exception as e:
            return {
                "name": name,
                "supported": True,
                "connected": False,
                "error": str(e)
            }


# 便利函數

def get_exchange(name: str, testnet: bool = False) -> BaseExchange:
    """快速獲取交易所實例（從配置）"""
    return ExchangeFactory.create_from_config(name, testnet)


def get_bybit(testnet: bool = False) -> BybitExchange:
    """快速獲取 Bybit 實例"""
    return ExchangeFactory.create_from_config("bybit", testnet)


def get_binance(testnet: bool = False) -> BinanceExchange:
    """快速獲取 Binance 實例"""
    return ExchangeFactory.create_from_config("binance", testnet)


def get_okx(testnet: bool = False) -> OKXExchange:
    """快速獲取 OKX 實例"""
    return ExchangeFactory.create_from_config("okx", testnet)


def get_bitget(testnet: bool = False) -> BitgetExchange:
    """快速獲取 Bitget 實例"""
    return ExchangeFactory.create_from_config("bitget", testnet)


def get_aster(testnet: bool = False) -> AsterExchange:
    """快速獲取 Aster 實例"""
    return ExchangeFactory.create_from_config("aster", testnet)


def list_exchanges() -> list[str]:
    """列出支援的交易所"""
    return ExchangeFactory.get_supported_exchanges()


def check_exchange_support(name: str) -> bool:
    """檢查是否支援指定交易所"""
    return name.lower() in ExchangeFactory.get_supported_exchanges()
