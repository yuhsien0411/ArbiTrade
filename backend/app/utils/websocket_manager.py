"""
WebSocket 連接管理器
避免循環導入問題
"""

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
import asyncio
import time
import json
from typing import List, Optional
from app.utils.logger import get_logger

logger = get_logger()

# 心跳閒置超時（秒）：在此期間沒有收到任何訊息（包含 ping）才視為過期
HEARTBEAT_TIMEOUT_SECONDS = 120
# 伺服器主動探活間隔（秒）
SERVER_PING_INTERVAL_SECONDS = 20


class ConnectionManager:
    """WebSocket 連接管理器"""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connection_heartbeat: dict[WebSocket, float] = {}
        self._ping_task: Optional[asyncio.Task] = None

    async def connect(self, websocket: WebSocket):
        """接受新的 WebSocket 連接"""
        await websocket.accept()
        self.active_connections.append(websocket)
        self.connection_heartbeat[websocket] = time.time()
        logger.info("websocket_connected", total_connections=len(self.active_connections))

        # 延後啟動伺服器側心跳任務（首次有連線時啟動）
        self._ensure_ping_task()

    async def disconnect(self, websocket: WebSocket):
        """斷開 WebSocket 連接"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        if websocket in self.connection_heartbeat:
            del self.connection_heartbeat[websocket]
        logger.info("websocket_disconnected", total_connections=len(self.active_connections))

    def touch(self, websocket: WebSocket) -> None:
        """更新單一連線的心跳時間（收到任何訊息時呼叫）"""
        if websocket in self.connection_heartbeat:
            self.connection_heartbeat[websocket] = time.time()

    async def broadcast(self, message: str):
        """向所有連接廣播消息"""
        if not self.active_connections:
            logger.debug("websocket_broadcast_no_connections")
            return

        # 清理過期的連接
        await self._cleanup_stale_connections()

        # 發送消息到所有活躍連接
        for connection in self.active_connections.copy():
            try:
                await connection.send_text(message)
            except WebSocketDisconnect as e:
                logger.info("websocket_send_disconnected", error_type=type(e).__name__)
                await self.disconnect(connection)
            except RuntimeError as e:
                logger.info("websocket_send_closed", error=str(e) or repr(e), error_type=type(e).__name__)
                await self.disconnect(connection)
            except Exception as e:
                logger.error("websocket_send_failed", error=str(e) or repr(e), error_type=type(e).__name__)
                await self.disconnect(connection)

    async def _cleanup_stale_connections(self):
        """清理過期的連接（超過 HEARTBEAT_TIMEOUT_SECONDS 無任何訊息）"""
        current_time = time.time()
        stale_connections = []

        for ws, last_heartbeat in self.connection_heartbeat.items():
            if current_time - last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS:
                stale_connections.append(ws)

        for ws in stale_connections:
            await self.disconnect(ws)
            logger.info("stale_connection_cleaned")

    def _ensure_ping_task(self) -> None:
        if self._ping_task is None or self._ping_task.done():
            try:
                loop = asyncio.get_event_loop()
                self._ping_task = loop.create_task(self._server_ping_loop())
            except RuntimeError:
                # 沒有事件迴圈時略過；下次 connect 再重試
                self._ping_task = None

    async def _server_ping_loop(self) -> None:
        """伺服器端主動 ping 任務，避免中介設備斷線並更新心跳"""
        try:
            while True:
                await asyncio.sleep(SERVER_PING_INTERVAL_SECONDS)
                if not self.active_connections:
                    # 沒有連線時先結束，等下次 connect 重啟
                    self._ping_task = None
                    return
                payload = json.dumps({"type": "ping", "data": {"ts": int(time.time() * 1000)}})
                for connection in self.active_connections.copy():
                    try:
                        await connection.send_text(payload)
                    except WebSocketDisconnect as e:
                        logger.info("websocket_ping_disconnected", error_type=type(e).__name__)
                        await self.disconnect(connection)
                    except RuntimeError as e:
                        logger.info("websocket_ping_closed", error=str(e) or repr(e), error_type=type(e).__name__)
                        await self.disconnect(connection)
                    except Exception as e:
                        logger.error("websocket_ping_failed", error=str(e) or repr(e), error_type=type(e).__name__)
                        await self.disconnect(connection)
        except asyncio.CancelledError:
            return


# 全局 WebSocket 管理器實例
manager = ConnectionManager()
