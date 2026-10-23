from __future__ import annotations

import time
from typing import Any, Optional
from fastapi.responses import JSONResponse


def _now_ms() -> int:
    return int(time.time() * 1000)


def api_success(data: Any | None = None, message: Optional[str] = None, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "success": True,
            "data": data,
            "message": message,
            "timestamp": _now_ms(),
        },
    )


def api_error(message: str, *, error: Optional[str] = None, data: Any | None = None, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "success": False,
            "error": error or message,
            "message": message,
            "data": data,
            "timestamp": _now_ms(),
        },
    )


