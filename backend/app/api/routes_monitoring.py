from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal, List, Dict, Any, Optional
import time
import uuid
import json
from pathlib import Path

from ..utils.logger import get_logger
from .response import api_success, api_error
# 重用 arbitrage 模型以保持一致性
from ..models.arbitrage import Leg, CreatePairRequest, UpdatePairRequest


router = APIRouter()
logger = get_logger()

# 數據持久化設置
DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
DATA_FILE = DATA_DIR / "monitoring_pairs.json"

# 確保數據目錄存在
DATA_DIR.mkdir(exist_ok=True)

# 記憶體儲存（後續可改為資料庫）
monitoring_pairs: Dict[str, Dict[str, Any]] = {}

def load_monitoring_pairs() -> None:
    """從文件載入監控對資料"""
    try:
        if DATA_FILE.exists():
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                monitoring_pairs.update(data)
                logger.info("monitoring_pairs_loaded", count=len(monitoring_pairs))
        else:
            logger.info("monitoring_pairs_file_not_found", file=str(DATA_FILE))
    except Exception as e:
        logger.error("monitoring_pairs_load_failed", error=str(e))

def save_monitoring_pairs() -> None:
    """保存監控對資料到文件"""
    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(monitoring_pairs, f, ensure_ascii=False, indent=2)
        logger.info("monitoring_pairs_saved", count=len(monitoring_pairs))
    except Exception as e:
        logger.error("monitoring_pairs_save_failed", error=str(e))

# 載入現有數據
load_monitoring_pairs()

def clear_monitoring_data() -> None:
    """清空監控對資料"""
    monitoring_pairs.clear()
    # 刪除數據文件
    if DATA_FILE.exists():
        DATA_FILE.unlink()
    logger.info("monitoring_data_cleared", success=True)

def update_pair_trigger_stats(pair_id: str, success: bool = True) -> None:
    """更新交易對的觸發統計"""
    if pair_id in monitoring_pairs:
        if 'totalTriggers' not in monitoring_pairs[pair_id]:
            monitoring_pairs[pair_id]['totalTriggers'] = 0
        if 'lastTriggered' not in monitoring_pairs[pair_id]:
            monitoring_pairs[pair_id]['lastTriggered'] = None
            
        if success:
            monitoring_pairs[pair_id]['totalTriggers'] += 1
            monitoring_pairs[pair_id]['lastTriggered'] = int(time.time() * 1000)
            save_monitoring_pairs()  # 保存到文件
            logger.info("pair_trigger_stats_updated", 
                      pairId=pair_id, 
                      totalTriggers=monitoring_pairs[pair_id]['totalTriggers'],
                      lastTriggered=monitoring_pairs[pair_id]['lastTriggered'])


# 移除重複的模型定義，改用 arbitrage 模型
# class Leg, CreatePairRequest, UpdatePairRequest 已從 arbitrage 模型導入


def _generate_pair_id(leg1: Leg, leg2: Leg) -> str:
    """生成交易對ID"""
    return f"{leg1.exchange}_{leg2.exchange}_{leg1.symbol.lower()}"


def _resolve_pair_id(pair_id: str) -> Optional[str]:
    """嘗試在現有列表中解析對應的 pair_id（忽略大小寫等差異）。"""
    if pair_id in monitoring_pairs:
        return pair_id
    # 常見情況：symbol 大小寫不同
    lowered = pair_id.rsplit('_', 1)
    if len(lowered) == 2:
        alt = f"{lowered[0]}_{lowered[1].lower()}"
        if alt in monitoring_pairs:
            return alt
    # 最後嘗試忽略大小寫比對
    for key in monitoring_pairs.keys():
        if key.lower() == pair_id.lower():
            return key
    return None


@router.get("/monitoring/pairs")
async def get_monitoring_pairs():
    """取得所有監控交易對"""
    pairs = []
    for pair_id, config in monitoring_pairs.items():
        pairs.append({
            "id": pair_id,
            **config
        })
    return api_success(pairs)


@router.post("/monitoring/pairs")
async def create_monitoring_pair(request: CreatePairRequest):
    """新增監控交易對（支援覆蓋現有）"""
    pair_id = _generate_pair_id(request.leg1, request.leg2)
    
    # 如果已存在，直接更新而不是報錯
    if pair_id in monitoring_pairs:
        logger.info("monitoring_pair_exists_updating", pairId=pair_id)
    
    config = {
        "leg1": request.leg1.dict(),
        "leg2": request.leg2.dict(),
        "threshold": request.threshold,
        "qty": request.qty,
        "maxExecs": request.maxExecs,
        "enabled": request.enabled,
        # 初始化統計欄位
        "totalTriggers": 0,
        "lastTriggered": None
    }
    
    monitoring_pairs[pair_id] = config
    save_monitoring_pairs()  # 保存到文件
    
    logger.info("pair_created", pairId=pair_id, success=True)
    
    return api_success({"id": pair_id})


@router.put("/monitoring/pairs/{pair_id}")
async def update_monitoring_pair(pair_id: str, request: UpdatePairRequest):
    """更新監控交易對"""
    resolved_id = _resolve_pair_id(pair_id)
    if not resolved_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "NOT_FOUND", "message": "Pair not found"}
        )
    
    config = monitoring_pairs[resolved_id]
    
    # 更新非空欄位
    if request.threshold is not None:
        config["threshold"] = request.threshold
    if request.qty is not None:
        config["qty"] = request.qty
    if request.maxExecs is not None:
        config["maxExecs"] = request.maxExecs
    if request.enabled is not None:
        config["enabled"] = request.enabled
    
    save_monitoring_pairs()  # 保存到文件
    
    logger.info("pair_updated", pairId=resolved_id, success=True)
    
    return api_success()


@router.delete("/monitoring/pairs/{pair_id}")
async def delete_monitoring_pair(pair_id: str):
    """刪除監控交易對"""
    resolved_id = _resolve_pair_id(pair_id)
    if not resolved_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "NOT_FOUND", "message": "Pair not found"}
        )
    
    del monitoring_pairs[resolved_id]
    save_monitoring_pairs()  # 保存到文件
    
    logger.info("pair_deleted", pairId=resolved_id, success=True)
    
    return api_success()
