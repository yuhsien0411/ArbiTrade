from __future__ import annotations

import time
from fastapi import APIRouter, HTTPException
from typing import Optional

from app.services.arbitrage_engine import arb_engine
from app.services.twap_engine import twap_engine
from app.api.routes_monitoring import clear_monitoring_data
from app.api.routes_monitoring import monitoring_pairs
from app.utils.logger import get_logger
from app.api.response import api_success, api_error

# 使用統一的資料模型
from app.models.arbitrage import (
    PairConfig, 
    Leg, 
    CreatePairRequest, 
    UpdatePairRequest, 
    EngineControlRequest,
    ApiResponse,
    ExecutionHistoryResponse
)


router = APIRouter()
logger = get_logger()


@router.get("/arbitrage/engine/status")
async def get_engine_status():
    return api_success(arb_engine.get_status())


@router.get("/arbitrage/pairs")
async def get_arbitrage_pairs():
    """取得所有套利監控對"""
    try:
        pairs = []
        for pair_id, config in arb_engine._pairs.items():
            # 從監控對統計帶出觸發資料，避免前端顯示為 0
            mp = monitoring_pairs.get(pair_id, {})
            total_triggers = mp.get('totalTriggers', 0)
            last_triggered = mp.get('lastTriggered', None)
            pair_data = {
                "id": pair_id,
                "leg1": {
                    "exchange": config.leg1.exchange,
                    "symbol": config.leg1.symbol,
                    "type": config.leg1.type,
                    "side": config.leg1.side
                },
                "leg2": {
                    "exchange": config.leg2.exchange,
                    "symbol": config.leg2.symbol,
                    "type": config.leg2.type,
                    "side": config.leg2.side
                },
                "threshold": config.threshold,
                "qty": config.qty,
                "enabled": config.enabled,
                "maxExecs": config.maxExecs,
                "executionsCount": arb_engine._executions_count.get(pair_id, 0),
                "totalTriggers": total_triggers,
                "lastTriggered": last_triggered,
            }
            pairs.append(pair_data)
        return api_success(pairs)
    except Exception as e:
        logger.error("arb_pairs_fetch_failed", error=str(e))
        return api_error("Failed to fetch pairs", error=str(e), status_code=500)


@router.get("/arbitrage/executions")
async def get_executions_history(limit: int = 200):
    try:
        # 合併：記憶體中的監控中歷史 + JSONL 最近資料
        mem = arb_engine.get_executions_history()
        try:
            # 支援 JSON 陣列或 JSONL 檔案
            persisted = arb_engine.get_persisted_recent(limit=limit)
            logger.info("arb_api_executions", mem_count=len(mem), persisted_count=len(persisted), persisted_sample=persisted[:2] if persisted else [])
        except Exception as pe:
            logger.error("arb_api_persisted_failed", error=str(pe))
            persisted = []
        # 統一返回：data 內含 executions 與 recent
        payload = {"executions": mem, "recent": persisted}
        return api_success(payload)
    except Exception as e:
        logger.error("arb_executions_fetch_failed", error=str(e))
        return api_error("Failed to fetch executions", error=str(e), status_code=500)


@router.get("/arbitrage/average-prices")
async def get_average_prices():
    """
    計算每個策略（pairId）的成交均價
    返回格式：{
        "pairId": {
            "leg1AvgPrice": float,
            "leg2AvgPrice": float,
            "totalQty": float,
            "executionCount": int,
            "lastExecution": timestamp
        }
    }
    """
    try:
        # 讀取所有執行記錄
        persisted = arb_engine.get_persisted_recent(limit=1000)
        
        # 按 pairId 聚合
        pair_stats = {}
        
        for record in persisted:
            if record.get('status') != 'success':
                continue  # 只統計成功的執行
            
            pair_id = record.get('pairId')
            if not pair_id:
                continue
            
            qty = float(record.get('qty', 0))
            if qty <= 0:
                continue
            
            leg1_price = record.get('leg1', {}).get('price')
            leg2_price = record.get('leg2', {}).get('price')
            
            # 跳過沒有價格的記錄
            if leg1_price is None or leg2_price is None:
                continue
            
            leg1_price = float(leg1_price)
            leg2_price = float(leg2_price)
            
            # 初始化或更新統計
            if pair_id not in pair_stats:
                pair_stats[pair_id] = {
                    'leg1TotalValue': 0,
                    'leg2TotalValue': 0,
                    'totalQty': 0,
                    'executionCount': 0,
                    'lastExecution': 0,
                    'leg1': record.get('leg1', {}),
                    'leg2': record.get('leg2', {})
                }
            
            stats = pair_stats[pair_id]
            stats['leg1TotalValue'] += leg1_price * qty
            stats['leg2TotalValue'] += leg2_price * qty
            stats['totalQty'] += qty
            stats['executionCount'] += 1
            stats['lastExecution'] = max(stats['lastExecution'], record.get('ts', 0))
        
        # 計算均價
        result = {}
        for pair_id, stats in pair_stats.items():
            if stats['totalQty'] > 0:
                result[pair_id] = {
                    'leg1AvgPrice': stats['leg1TotalValue'] / stats['totalQty'],
                    'leg2AvgPrice': stats['leg2TotalValue'] / stats['totalQty'],
                    'totalQty': stats['totalQty'],
                    'executionCount': stats['executionCount'],
                    'lastExecution': stats['lastExecution'],
                    'leg1Info': {
                        'exchange': stats['leg1'].get('exchange'),
                        'symbol': stats['leg1'].get('symbol'),
                        'type': stats['leg1'].get('type'),
                        'side': stats['leg1'].get('side')
                    },
                    'leg2Info': {
                        'exchange': stats['leg2'].get('exchange'),
                        'symbol': stats['leg2'].get('symbol'),
                        'type': stats['leg2'].get('type'),
                        'side': stats['leg2'].get('side')
                    }
                }
        
        logger.info("arb_average_prices_calculated", pair_count=len(result))
        return api_success(result)
        
    except Exception as e:
        logger.error("arb_average_prices_failed", error=str(e))
        return api_error("Failed to calculate average prices", error=str(e), status_code=500)


@router.post("/arbitrage/engine/control")
async def control_engine(req: EngineControlRequest):
    try:
        if req.action == "start":
            await arb_engine.start()
        elif req.action == "stop":
            await arb_engine.stop()
        else:
            raise HTTPException(status_code=400, detail={"code": "VALIDATION_ERROR", "message": "invalid action"})
        logger.info("arb_engine_control", action=req.action, success=True)
        return api_success()
    except Exception as e:
        logger.error("arb_engine_control_failed", action=req.action, error=str(e))
        return api_error("Engine control failed", error=str(e), status_code=500)


@router.post("/arbitrage/pairs")
async def upsert_pair(req: CreatePairRequest):
    try:
        # 🔍 详细记录 threshold 值
        logger.info("arb_pair_upsert_request", 
                   request=req.dict(),
                   threshold_value=req.threshold,
                   threshold_type=type(req.threshold).__name__)
        
        # 生成 ID（如果未提供）
        pair_id = req.pairId or f"pair_{int(time.time()*1000)}_{hash(str(req.dict()))}"
        
        cfg = PairConfig(
            id=pair_id,
            leg1=req.leg1,
            leg2=req.leg2,
            threshold=req.threshold,
            qty=req.qty,
            maxExecs=req.maxExecs,
            enabled=req.enabled,
        )
        
        logger.info("arb_pair_config_created", pairId=pair_id, config=cfg.dict())
        arb_engine.upsert_pair(pair_id, cfg)
        logger.info("arb_pair_upserted_successfully", pairId=pair_id)
        # 若引擎尚未啟動，嘗試自動啟動，避免未初始化導致不觸發
        status = arb_engine.get_status()
        if not status.get("running", False):
            try:
                await arb_engine.start()
                logger.info("arb_engine_autostart_after_upsert", pairId=req.pairId, success=True)
            except Exception as e:
                logger.error("arb_engine_autostart_failed", pairId=req.pairId, error=str(e))
        
        # 返回完整的交易對數據供前端使用（包含觸發統計）
        mp = monitoring_pairs.get(pair_id, {})
        total_triggers = mp.get('totalTriggers', 0)
        last_triggered = mp.get('lastTriggered', None)
        
        # 更新配置中的統計資料
        cfg.totalTriggers = total_triggers
        cfg.lastTriggered = last_triggered
        
        pair_data = {
            "id": pair_id,
            "leg1": {
                "exchange": cfg.leg1.exchange,
                "symbol": cfg.leg1.symbol,
                "type": cfg.leg1.type,
                "side": cfg.leg1.side
            },
            "leg2": {
                "exchange": cfg.leg2.exchange,
                "symbol": cfg.leg2.symbol,
                "type": cfg.leg2.type,
                "side": cfg.leg2.side
            },
            "threshold": cfg.threshold,
            "qty": cfg.qty,
            "enabled": cfg.enabled,
            "maxExecs": cfg.maxExecs,
            "executionsCount": arb_engine._executions_count.get(pair_id, 0),
            "createdAt": cfg.createdAt,
            "lastTriggered": last_triggered,
            "totalTriggers": total_triggers,
        }
        
        return api_success(pair_data)
    except Exception as e:
        logger.error("arb_pair_upsert_failed", error=str(e))
        return api_error("Failed to upsert pair", error=str(e), status_code=500)


@router.delete("/arbitrage/pairs/{pair_id}")
async def remove_pair(pair_id: str):
    try:
        arb_engine.remove_pair(pair_id)
        return api_success()
    except Exception as e:
        logger.error("arb_pair_remove_failed", pairId=pair_id, error=str(e))
        return api_error("Failed to remove pair", error=str(e), status_code=500)


# UpdatePairRequest 已在 models/arbitrage.py 中定義


@router.put("/arbitrage/pairs/{pair_id}")
async def update_pair(pair_id: str, req: UpdatePairRequest):
    try:
        cfg = arb_engine._pairs.get(pair_id)
        if not cfg:
            raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "pair not found"})
        # 局部更新
        if req.enabled is not None:
            cfg.enabled = bool(req.enabled)
        if req.threshold is not None:
            cfg.threshold = float(req.threshold)
        if req.qty is not None:
            cfg.qty = float(req.qty)
        if req.maxExecs is not None and req.maxExecs >= 1:
            cfg.maxExecs = int(req.maxExecs)
        arb_engine._pairs[pair_id] = cfg
        logger.info("arb_pair_updated", pairId=pair_id, enabled=cfg.enabled)
        return api_success()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("arb_pair_update_failed", pairId=pair_id, error=str(e))
        return api_error("Failed to update pair", error=str(e), status_code=500)


@router.post("/arbitrage/refresh-prices")
async def refresh_all_prices():
    """刷新所有監控對的價格數據"""
    try:
        refreshed_count = 0
        for pair_id, config in arb_engine._pairs.items():
            if config.enabled:
                await arb_engine._refresh_pair_prices(pair_id, config)
                refreshed_count += 1
        
        logger.info("arb_prices_refresh_all", count=refreshed_count, success=True)
        return api_success(message=f"已刷新 {refreshed_count} 個監控對的價格數據")
    except Exception as e:
        logger.error("arb_prices_refresh_all_failed", error=str(e))
        return api_error("Failed to refresh all prices", error=str(e), status_code=500)


@router.post("/arbitrage/pairs/{pair_id}/refresh-prices")
async def refresh_pair_prices(pair_id: str):
    """刷新指定監控對的價格數據"""
    try:
        config = arb_engine._pairs.get(pair_id)
        if not config:
            raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "監控對不存在"})
        
        await arb_engine._refresh_pair_prices(pair_id, config)
        
        logger.info("arb_prices_refresh_pair", pairId=pair_id, success=True)
        return api_success(message=f"已刷新監控對 {pair_id} 的價格數據")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("arb_prices_refresh_pair_failed", pairId=pair_id, error=str(e))
        return api_error("Failed to refresh pair prices", error=str(e), status_code=500)


@router.post("/arbitrage/clear-all-data")
async def clear_all_data():
    """清空所有後端資料"""
    try:
        # 清空套利引擎資料
        arb_engine.clear_all_data()
        
        # 清空 TWAP 引擎資料
        twap_engine.clear_all_data()
        
        # 清空監控對資料
        clear_monitoring_data()
        
        logger.info("all_backend_data_cleared", success=True)
        return api_success(message="所有後端資料已清空")
    except Exception as e:
        logger.error("clear_all_data_failed", error=str(e))
        return api_error("Failed to clear all data", error=str(e), status_code=500)


