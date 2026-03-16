# tools-gateway/core/logging.py
import logging

from .config import settings


def configure_logging() -> logging.Logger:
    level_name = settings.TOOLS_GATEWAY_LOG_LEVEL.upper()
    level = getattr(logging, level_name, logging.INFO)

    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )
    logger = logging.getLogger("tools-gateway")
    logger.setLevel(level)
    logger.info("Логирование инициализировано (уровень %s)", level_name)
    return logger
