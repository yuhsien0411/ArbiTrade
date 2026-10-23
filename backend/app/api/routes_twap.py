from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import List, Dict, Any
import time

from ..models.twap import (
    TwapPlan, TwapProgress, CreateTwapRequest, TwapControlRequest, TwapControlResponse, TwapState
)
from ..services.twap_engine import twap_engine
from ..utils.logger import get_logger
from .response import api_success, api_error


router = APIRouter()
logger = get_logger()


@router.post("/twap/plans")
async def create_twap_plan(request: CreateTwapRequest):
    """建立 TWAP 計畫"""
    try:
        plan = TwapPlan(
            name=request.name,
            totalQty=request.totalQty,
            sliceQty=request.sliceQty,
            intervalMs=request.intervalMs,
            legs=request.legs
        )
        
        plan_id = await twap_engine.create_plan(plan)
        
        logger.info("twap_plan_created", planId=plan_id, success=True)
        return api_success({"planId": plan_id})
        
    except Exception as e:
        logger.error("twap_plan_create_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": f"Failed to create TWAP plan: {str(e)}"}
        )


@router.get("/twap/{plan_id}/status")
async def get_twap_status(plan_id: str):
    """取得 TWAP 計畫狀態"""
    progress = await twap_engine.get_progress(plan_id)
    
    if not progress:
        return api_error("TWAP plan not found", status_code=404)
    
    return api_success(progress.dict())


@router.post("/twap/{plan_id}/control")
async def control_twap_plan(plan_id: str, request: TwapControlRequest):
    """控制 TWAP 計畫（開始/暫停/恢復/取消）"""
    try:
        logger.info("twap_control_request", planId=plan_id, action=request.action)
        success = False
        new_state = None
        
        if request.action == "start":
            success = await twap_engine.start_plan(plan_id)
            new_state = "running" if success else None
        elif request.action == "pause":
            success = await twap_engine.pause_plan(plan_id)
            new_state = "paused" if success else None
            logger.info("twap_pause_attempt", planId=plan_id, success=success)
        elif request.action == "resume":
            success = await twap_engine.resume_plan(plan_id)
            new_state = "running" if success else None
        elif request.action == "cancel":
            success = await twap_engine.cancel_plan(plan_id)
            new_state = "cancelled" if success else None
        else:
            raise HTTPException(
                status_code=400,
                detail={"code": "VALIDATION_ERROR", "message": "Invalid action"}
            )
        
        if not success:
            raise HTTPException(
                status_code=400,
                detail={"code": "INVALID_STATE", "message": "Cannot perform action in current state"}
            )
        
        logger.info("twap_control", planId=plan_id, action=request.action, success=True)
        return api_success({"newState": new_state})
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("twap_control_failed", planId=plan_id, action=request.action, error=str(e))
        return api_error("Failed to control TWAP plan", error=str(e), status_code=500)


@router.get("/twap/{plan_id}/executions")
async def get_twap_executions(plan_id: str):
    """取得 TWAP 執行記錄"""
    executions = await twap_engine.get_executions(plan_id)
    
    if executions is None:
        return api_error("TWAP plan not found", status_code=404)
    
    return api_success(executions)


@router.get("/twap/plans")
async def list_twap_plans():
    """列出所有 TWAP 計畫"""
    plans = []
    for plan_id, plan in twap_engine.plans.items():
        progress = await twap_engine.get_progress(plan_id)
        state_value = progress.state.value if progress else "unknown"
        
        # 轉換為前端期望的格式
        plan_data = {
            "id": plan_id,  # 前端使用 id
            "planId": plan_id,  # 保留向後兼容
            "name": plan.name,
            "totalAmount": plan.totalQty,  # 前端使用 totalAmount
            "totalQty": plan.totalQty,
            "sliceQty": plan.sliceQty,
            "amountPerOrder": plan.sliceQty,  # 前端使用 amountPerOrder
            "timeInterval": plan.intervalMs,  # 前端使用 timeInterval
            "intervalMs": plan.intervalMs,
            "orderCount": int(plan.totalQty / plan.sliceQty) if plan.sliceQty > 0 else 0,
            "legs": [leg.dict() for leg in plan.legs],
            "leg1": {
                "exchange": plan.legs[0].exchange if len(plan.legs) > 0 else None,
                "symbol": plan.legs[0].symbol if len(plan.legs) > 0 else None,
                "type": plan.legs[0].category if len(plan.legs) > 0 else None,
                "side": plan.legs[0].side if len(plan.legs) > 0 else None,
            } if len(plan.legs) > 0 else None,
            "leg2": {
                "exchange": plan.legs[1].exchange if len(plan.legs) > 1 else None,
                "symbol": plan.legs[1].symbol if len(plan.legs) > 1 else None,
                "type": plan.legs[1].category if len(plan.legs) > 1 else None,
                "side": plan.legs[1].side if len(plan.legs) > 1 else None,
            } if len(plan.legs) > 1 else None,
            "createdAt": plan.createdAt,
            "status": state_value,  # 前端使用 status
            "state": state_value,  # 保留向後兼容
            "enabled": state_value in ["active", "running", "paused"],
            "priceType": "market",
            "executedOrders": progress.slicesDone if progress else 0,
            "totalTriggers": progress.slicesDone if progress else 0,  # 觸發次數（已執行的切片數）
            "remainingAmount": progress.remaining if progress else plan.totalQty,
            "nextExecutionTime": progress.nextExecutionTs if progress else 0,
            "progress": progress.dict() if progress else None
        }
        plans.append(plan_data)
    
    return api_success(plans)


@router.put("/twap/plans/{plan_id}")
async def update_twap_plan(plan_id: str, request: CreateTwapRequest):
    """更新 TWAP 計畫"""
    try:
        if plan_id not in twap_engine.plans:
            return api_error("TWAP plan not found", status_code=404)
        
        # 檢查計畫是否正在運行
        progress = await twap_engine.get_progress(plan_id)
        if progress and progress.state.value in ["running", "paused"]:
            return api_error("Cannot update running or paused plan", status_code=400)
        
        # 創建新的計畫對象
        updated_plan = TwapPlan(
            planId=plan_id,
            name=request.name,
            totalQty=request.totalQty,
            sliceQty=request.sliceQty,
            intervalMs=request.intervalMs,
            legs=request.legs,
            createdAt=twap_engine.plans[plan_id].createdAt  # 保持原始創建時間
        )
        
        # 更新計畫
        twap_engine.plans[plan_id] = updated_plan
        
        # 重新初始化進度追蹤
        twap_engine.progress[plan_id] = TwapProgress(
            planId=plan_id,
            executed=0.0,
            remaining=request.totalQty,
            slicesDone=0,
            slicesTotal=int(request.totalQty / request.sliceQty),
            state=TwapState.PENDING
        )
        
        # 清空執行記錄
        twap_engine.executions[plan_id] = []
        
        logger.info("twap_plan_updated", planId=plan_id, success=True)
        
        return api_success({"planId": plan_id})
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("twap_plan_update_failed", planId=plan_id, error=str(e))
        return api_error("Failed to update TWAP plan", error=str(e), status_code=500)


@router.post("/twap/{plan_id}/emergency-rollback")
async def emergency_rollback(plan_id: str):
    """緊急回滾 TWAP 計畫的所有成功腿"""
    try:
        if plan_id not in twap_engine.plans:
            return api_error("TWAP plan not found", status_code=404)
        
        success = await twap_engine.emergency_rollback(plan_id)
        
        if success:
            logger.info("twap_emergency_rollback_success", planId=plan_id)
            return api_success(message="Emergency rollback completed")
        else:
            return api_error("Emergency rollback failed", status_code=500)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("twap_emergency_rollback_failed", planId=plan_id, error=str(e))
        return api_error("Emergency rollback failed", error=str(e), status_code=500)


@router.delete("/twap/plans/{plan_id}")
async def delete_twap_plan(plan_id: str):
    """刪除 TWAP 計畫（如果計畫正在運行或暫停，會自動先取消再刪除）"""
    try:
        if plan_id not in twap_engine.plans:
            return api_error("TWAP plan not found", status_code=404)
        
        # 檢查計畫是否正在運行或暫停，如果是則自動取消
        progress = await twap_engine.get_progress(plan_id)
        if progress and progress.state.value in ["running", "paused"]:
            logger.info("twap_plan_auto_cancel_before_delete", planId=plan_id, currentState=progress.state.value)
            # 自動取消計畫
            cancel_success = await twap_engine.cancel_plan(plan_id)
            if not cancel_success:
                logger.warning("twap_plan_cancel_failed_before_delete", planId=plan_id)
                # 即使取消失敗，也繼續嘗試刪除
        
        # 取消正在運行的任務（如果有的話）
        if plan_id in twap_engine._running_tasks:
            try:
                twap_engine._running_tasks[plan_id].cancel()
                del twap_engine._running_tasks[plan_id]
            except Exception as task_error:
                logger.warning("twap_task_cancel_error", planId=plan_id, error=str(task_error))
        
        # 刪除計畫和相關數據
        if plan_id in twap_engine.plans:
            del twap_engine.plans[plan_id]
        if plan_id in twap_engine.progress:
            del twap_engine.progress[plan_id]
        if plan_id in twap_engine.executions:
            del twap_engine.executions[plan_id]
        
        logger.info("twap_plan_deleted", planId=plan_id, success=True)
        
        return api_success()
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("twap_plan_delete_failed", planId=plan_id, error=str(e))
        return api_error("Failed to delete TWAP plan", error=str(e), status_code=500)


@router.get("/twap/executions")
async def get_twap_executions_history(limit: int = 200):
    """獲取 TWAP 執行歷史"""
    try:
        # 合併：記憶體中的執行記錄 + JSONL 持久化資料
        mem_executions = {}
        for plan_id, executions in twap_engine.executions.items():
            mem_executions[plan_id] = [exec.dict() for exec in executions]
        
        # 讀取持久化的記錄
        try:
            persisted = twap_engine.get_persisted_recent(limit=limit)
            logger.info("twap_api_executions", mem_count=len(mem_executions), persisted_count=len(persisted))
        except Exception as pe:
            logger.error("twap_api_persisted_failed", error=str(pe))
            persisted = []
        
        return api_success({"executions": mem_executions, "recent": persisted})
    except Exception as e:
        logger.error("twap_executions_fetch_failed", error=str(e))
        return api_error("Failed to fetch TWAP executions", error=str(e), status_code=500)