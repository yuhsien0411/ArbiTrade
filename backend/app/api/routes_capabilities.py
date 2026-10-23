"""
交易所能力查詢 API
提供前端查詢交易所支援的交易類型與帳戶模式
"""

from fastapi import APIRouter, HTTPException
from typing import Dict, Any, List
from app.exchanges.registry import (
    get_capabilities,
    get_supported_trade_types,
    is_unified_like,
    get_account_profile,
    as_dict,
    EXCHANGE_CAPABILITIES
)
from app.utils.logger import get_logger
from .response import api_success

logger = get_logger()

router = APIRouter(prefix="/api/exchanges", tags=["exchanges"])


@router.get("/{exchange_name}/capabilities")
async def get_exchange_capabilities(exchange_name: str) -> Dict[str, Any]:
    """
    獲取指定交易所的能力信息
    
    Args:
        exchange_name: 交易所名稱（bybit, binance, okx, bitget）
        
    Returns:
        交易所能力詳情，包含支援的交易類型、帳戶模式等
        
    Example:
        GET /api/exchanges/okx/capabilities
        {
            "name": "okx",
            "supportsSpot": false,
            "supportsLinear": true,
            "supportsInverse": false,
            "supportsUnifiedAccount": false,
            "accountProfile": "classic",
            "supportedTradeTypes": ["linear"],
            "isUnifiedLike": false,
            "notes": "本專案僅支援 USDT-M 永續合約（SWAP）"
        }
    """
    exchange_lower = exchange_name.lower().strip()
    
    # 檢查交易所是否存在
    if exchange_lower not in EXCHANGE_CAPABILITIES:
        available = ", ".join(EXCHANGE_CAPABILITIES.keys())
        logger.warning(f"Unknown exchange requested: {exchange_lower}")
        raise HTTPException(
            status_code=404,
            detail=f"Exchange '{exchange_name}' not found. Available: {available}"
        )
    
    try:
        # 獲取完整能力信息
        capabilities = as_dict(exchange_lower)

        logger.info(f"Retrieved capabilities for {exchange_lower}: {capabilities}")
        return api_success(capabilities)

    except Exception as e:
        logger.error(f"Error retrieving capabilities for {exchange_lower}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve capabilities: {str(e)}"
        )


@router.get("/capabilities")
async def get_all_capabilities() -> Dict[str, Any]:
    """
    獲取所有交易所的能力信息
    
    Returns:
        所有交易所的能力信息字典
        
    Example:
        GET /api/exchanges/capabilities
        {
            "bybit": { ... },
            "binance": { ... },
            "okx": { ... },
            "bitget": { ... }
        }
    """
    try:
        all_caps = {}
        for exchange_name in EXCHANGE_CAPABILITIES.keys():
            all_caps[exchange_name] = as_dict(exchange_name)

        logger.info(f"Retrieved all capabilities for {len(all_caps)} exchanges")
        return api_success(all_caps)

    except Exception as e:
        logger.error(f"Error retrieving all capabilities: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve capabilities: {str(e)}"
        )


@router.get("/{exchange_name}/supported-types")
async def get_supported_types(exchange_name: str) -> Dict[str, List[str]]:
    """
    獲取交易所支援的交易類型列表
    
    Args:
        exchange_name: 交易所名稱
        
    Returns:
        支援的交易類型列表
        
    Example:
        GET /api/exchanges/binance/supported-types
        {"supportedTypes": ["spot", "linear"]}
    """
    exchange_lower = exchange_name.lower().strip()
    
    if exchange_lower not in EXCHANGE_CAPABILITIES:
        raise HTTPException(
            status_code=404,
            detail=f"Exchange '{exchange_name}' not found"
        )
    
    try:
        types = get_supported_trade_types(exchange_lower)
        return api_success({"supportedTypes": types})

    except Exception as e:
        logger.error(f"Error retrieving supported types for {exchange_lower}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve supported types: {str(e)}"
        )

