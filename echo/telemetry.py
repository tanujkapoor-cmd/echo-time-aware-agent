import json
import logging
from datetime import UTC, datetime
from time import perf_counter


class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps(
            {
                "at": datetime.fromtimestamp(record.created, UTC).isoformat(),
                "level": record.levelname,
                "logger": record.name,
                "event": record.getMessage(),
                **getattr(record, "details", {}),
            },
            ensure_ascii=False,
        )


logger = logging.getLogger("echo")


def configure(level: str):
    logger.setLevel(level.upper())
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    logger.propagate = False


def ms(start: float) -> float:
    return round((perf_counter() - start) * 1000, 2)


def event(name: str, **fields):
    logger.info(name, extra={"details": fields})
