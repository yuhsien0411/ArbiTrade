from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import time
import json
import os
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv

import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 載入環境變量
load_dotenv()

from app.utils.logger import configure_logging, get_logger
from app.api.response import api_success, api_error
from app.utils.websocket_manager import manager
from app.api.routes_prices import router as prices_router
from app.api.routes_settings import router as settings_router
from app.api.routes_monitoring import router as monitoring_router
from app.api.routes_twap import router as twap_router
from app.api.routes_arbitrage import router as arbitrage_router
from app.api.routes_positions import router as positions_router
from app.api.routes_reports import router as reports_router
from app.api.routes_capabilities import router as capabilities_router
from app.api.routes_klines import router as klines_router
from app.api.routes_trade_records import router as trade_records_router
from app.services.arbitrage_engine import arb_engine
from app.services.chart_ticker_stream import chart_ticker_stream


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    logger = get_logger()
    logger.info("service_start", success=True)
    
    # 啟動時保持數據持久化，只清空執行狀態
    try:
        # 清空套利引擎的執行狀態，保留監控對配置
        arb_engine.clear_all_data()
        logger.info("arbitrage_engine_execution_data_cleared_on_startup", success=True)
        
        # 導入並清空 TWAP 引擎資料
        from app.services.twap_engine import twap_engine
        twap_engine.clear_all_data()
        logger.info("twap_engine_data_cleared_on_startup", success=True)
        
        # 監控對資料已經在模組載入時從文件恢復，不需要清空
        logger.info("monitoring_data_loaded_from_persistence", success=True)
    except Exception as e:
        logger.error("startup_data_initialization_failed", error=str(e))
    
    # 啟動 Binance WebSocket 數據流
    try:
        logger.info("binance_ws_import_starting")
        from app.services.orderbook_feeds.binance import binance_orderbook_feed
        logger.info("binance_ws_import_success")
        
        logger.info("binance_ws_starting")
        await binance_orderbook_feed.start()
        logger.info("binance_orderbook_feed_started", success=True)
    except ImportError as e:
        logger.error("binance_ws_import_failed", error=str(e))
    except Exception as e:
        logger.error("binance_orderbook_feed_start_failed", error=str(e))

    # 啟動 Bybit WebSocket 數據流
    try:
        logger.info("bybit_ws_import_starting")
        from app.services.orderbook_feeds.bybit import bybit_orderbook_feed
        logger.info("bybit_ws_import_success")

        logger.info("bybit_ws_starting")
        await bybit_orderbook_feed.start()
        logger.info("bybit_orderbook_feed_started", success=True)
    except ImportError as e:
        logger.error("bybit_ws_import_failed", error=str(e))
    except Exception as e:
        logger.error("bybit_orderbook_feed_start_failed", error=str(e))

    # 啟動 Bitget WebSocket 數據流
    try:
        logger.info("bitget_ws_import_starting")
        from app.services.orderbook_feeds.bitget import bitget_orderbook_feed
        logger.info("bitget_ws_import_success")

        logger.info("bitget_ws_starting")
        await bitget_orderbook_feed().start()
        logger.info("bitget_orderbook_feed_started", success=True)
    except ImportError as e:
        logger.error("bitget_ws_import_failed", error=str(e))
    except Exception as e:
        logger.error("bitget_orderbook_feed_start_failed", error=str(e))

    # 啟動 OKX WebSocket 數據流
    try:
        logger.info("okx_ws_import_starting")
        from app.services.orderbook_feeds.okx import okx_orderbook_feed
        logger.info("okx_ws_import_success")

        logger.info("okx_ws_starting")
        await okx_orderbook_feed.start()
        logger.info("okx_orderbook_feed_started", success=True)
    except ImportError as e:
        logger.error("okx_ws_import_failed", error=str(e))
    except Exception as e:
        logger.error("okx_orderbook_feed_start_failed", error=str(e))

    # 啟動 Aster WebSocket 數據流
    try:
        logger.info("aster_ws_import_starting")
        from app.services.orderbook_feeds.aster import aster_orderbook_feed
        logger.info("aster_ws_import_success")

        logger.info("aster_ws_starting")
        await aster_orderbook_feed.start()
        logger.info("aster_orderbook_feed_started", success=True)
    except ImportError as e:
        logger.error("aster_ws_import_failed", error=str(e))
    except Exception as e:
        logger.error("aster_orderbook_feed_start_failed", error=str(e))
    
    # 啟動套利引擎
    await arb_engine.start()
    logger.info("arbitrage_engine_started", success=True)
    
    # 啟動淨值自動記錄（每小時記錄一次）
    try:
        from app.services.net_value_scheduler import net_value_scheduler
        
        # 立即記錄一次當前淨值（啟動快照）
        logger.info("recording_initial_net_value_snapshot")
        await net_value_scheduler.record_net_value_once()
        
        # 啟動定時任務
        net_value_scheduler.start(interval_seconds=3600)  # 3600秒 = 1小時
        logger.info("net_value_scheduler_started", interval="1 hour")
    except Exception as e:
        logger.warning("net_value_scheduler_start_failed", error=str(e))
    
    try:
        yield
    finally:
        # 停止淨值記錄
        try:
            from app.services.net_value_scheduler import net_value_scheduler
            net_value_scheduler.stop()
            logger.info("net_value_scheduler_stopped", success=True)
        except Exception as e:
            logger.warning("net_value_scheduler_stop_failed", error=str(e))
        
        # 停止套利引擎
        await arb_engine.stop()
        logger.info("arbitrage_engine_stopped", success=True)
        
        # 停止 Binance WebSocket 數據流
        try:
            from app.services.orderbook_feeds.binance import binance_orderbook_feed
            await binance_orderbook_feed.stop()
            logger.info("binance_orderbook_feed_stopped", success=True)
        except Exception as e:
            logger.warning("binance_orderbook_feed_stop_failed", error=str(e))

        # 停止 Bybit WebSocket 數據流
        try:
            from app.services.orderbook_feeds.bybit import bybit_orderbook_feed
            await bybit_orderbook_feed.stop()
            logger.info("bybit_orderbook_feed_stopped", success=True)
        except Exception as e:
            logger.warning("bybit_orderbook_feed_stop_failed", error=str(e))

        # 停止 Bitget WebSocket 數據流
        try:
            from app.services.orderbook_feeds.bitget import bitget_orderbook_feed
            await bitget_orderbook_feed().stop()
            logger.info("bitget_orderbook_feed_stopped", success=True)
        except Exception as e:
            logger.warning("bitget_orderbook_feed_stop_failed", error=str(e))

        # 停止 OKX WebSocket 數據流
        try:
            from app.services.orderbook_feeds.okx import okx_orderbook_feed
            await okx_orderbook_feed.stop()
            logger.info("okx_orderbook_feed_stopped", success=True)
        except Exception as e:
            logger.warning("okx_orderbook_feed_stop_failed", error=str(e))

        # 停止 Aster WebSocket 數據流
        try:
            from app.services.orderbook_feeds.aster import aster_orderbook_feed
            await aster_orderbook_feed.stop()
            logger.info("aster_orderbook_feed_stopped", success=True)
        except Exception as e:
            logger.warning("aster_orderbook_feed_stop_failed", error=str(e))
        
        logger.info("service_stop", success=True)


app = FastAPI(title="Arbitrage Python Backend", lifespan=lifespan)

# 動態構建 CORS 允許來源列表
allowed_origins = []

# 從環境變數讀取允許的前端網址
# 支持多個本機 URL，用逗號分隔。
frontend_urls = os.getenv("FRONTEND_URL", "http://localhost:3000,http://127.0.0.1:3000")

# 解析多個 URL
for url in frontend_urls.split(","):
    url = url.strip()
    if url:
        allowed_origins.append(url)
        # 同時添加 https 版本（如果使用 SSL）
        if url.startswith("http://"):
            allowed_origins.append(url.replace("http://", "https://"))

# 如果沒有設置 FRONTEND_URL，使用默認的本地開發地址
if not os.getenv("FRONTEND_URL"):
    allowed_origins.extend([
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ])

# 添加 CORS 中間件
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

logger = get_logger()


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """HTTP 請求日誌中間件"""
    
    async def dispatch(self, request: Request, call_next):
        # 記錄請求開始
        start_time = time.time()
        
        # 獲取客戶端 IP
        client_ip = request.client.host if request.client else "unknown"
        
        # 記錄請求信息
        logger.info(
            "http_request_start",
            method=request.method,
            url=request.url.path,
            client_ip=client_ip,
            user_agent=request.headers.get("user-agent", "unknown"),
            content_type=request.headers.get("content-type", "unknown")
        )
        
        # 處理請求
        response = await call_next(request)
        
        # 計算處理時間
        process_time = time.time() - start_time
        
        # 記錄響應信息
        logger.info(
            "http_request_complete",
            method=request.method,
            url=request.url.path,
            status_code=response.status_code,
            process_time_ms=round(process_time * 1000, 2),
            client_ip=client_ip
        )
        
        return response


# 添加請求日誌中間件
app.add_middleware(RequestLoggingMiddleware)


@app.get("/health")
async def health():
    start = time.perf_counter()
    latency_ms = (time.perf_counter() - start) * 1000.0
    logger.info("health_check", success=True, latency_ms=round(latency_ms, 2))
    return api_success({"status": "ok"})
# 驗證錯誤只記錄欄位資訊，避免 input、ctx 或請求本文包含憑證。
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = [
        {"loc": error["loc"], "type": error["type"]}
        for error in exc.errors()
    ]
    logger.error(
        "request_validation_error",
        path=request.url.path,
        method=request.method,
        errors=errors,
    )

    return JSONResponse(
        status_code=422,
        content={
            "detail": errors,
            "message": "Request validation failed",
        },
    )



@app.get("/api/config/status")
async def config_status():
    """檢查系統配置狀態"""
    from app.config.env import config
    
    validation_result = config.validate_api_keys()
    
    return api_success({
        "api_validation": validation_result,
        "exchanges": config.get_all_exchanges_status(),
        "system": {
            "debug": config.DEBUG,
            "log_level": config.LOG_LEVEL
        }
    })


app.include_router(prices_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(monitoring_router, prefix="/api")
app.include_router(twap_router, prefix="/api")
app.include_router(arbitrage_router, prefix="/api")
app.include_router(positions_router, prefix="/api")
app.include_router(klines_router, prefix="/api")
app.include_router(trade_records_router, prefix="/api")
app.include_router(reports_router)
app.include_router(capabilities_router)


# WebSocket 管理器已移至 app.utils.websocket_manager


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    client_id = id(websocket)
    logger.info("websocket_connected", success=True)

    try:
        while True:
            # 任何來自客戶端的訊息都視為活動訊號，更新心跳
            data = await websocket.receive_text()
            manager.touch(websocket)

            # 嘗試解析並回應 ping（若客戶端送 ping 則回 pong）
            try:
                msg = json.loads(data) if data else {}
                if isinstance(msg, dict) and msg.get("type") == "ping":
                    await websocket.send_text(json.dumps({
                        "type": "pong",
                        "data": {"ts": int(time.time() * 1000)}
                    }))
                elif isinstance(msg, dict) and msg.get("type") == "chartTickerSubscribe":
                    payload = msg.get("data") or {}
                    await chart_ticker_stream.subscribe_client(
                        client_id,
                        payload.get("subscriptions") or []
                    )
                elif isinstance(msg, dict) and msg.get("type") == "chartTickerUnsubscribe":
                    payload = msg.get("data") or {}
                    await chart_ticker_stream.unsubscribe_client(
                        client_id,
                        payload.get("subscriptions")
                    )
            except json.JSONDecodeError:
                # 非 JSON 訊息忽略即可（心跳已更新）
                pass
            except Exception as e:
                logger.warning("websocket_client_message_handle_failed", error=str(e))
    except WebSocketDisconnect:
        await chart_ticker_stream.unsubscribe_client(client_id)
        await manager.disconnect(websocket)
        logger.info("websocket_disconnected", success=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app, 
        host="127.0.0.1",
        port=7001, 
        reload=True,
        log_level="info",
        access_log=True
    )
