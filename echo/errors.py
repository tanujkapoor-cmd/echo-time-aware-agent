class EchoError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class SearchUnavailable(Exception):
    """Sanitized provider failure. No request bodies or provider errors escape."""


class ModelUnavailable(Exception):
    """Sanitized model timeout, provider failure, or unusable output."""
