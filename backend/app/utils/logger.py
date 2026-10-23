import logging
import sys
from typing import Any

import structlog


def configure_logging() -> None:
    if getattr(configure_logging, "_configured", False):
        return

    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=logging.INFO)

    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        # 只輸出 warning/error，避免正常 200 流程刷屏
        wrapper_class=structlog.make_filtering_bound_logger(logging.WARNING),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    configure_logging._configured = True  # type: ignore[attr-defined]


def get_logger() -> Any:
    return structlog.get_logger()


