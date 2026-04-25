from __future__ import annotations

ENCRYPTED = "ENCRYPTED"
NO_TEXT = "NO_TEXT"
OLLAMA_DOWN = "OLLAMA_DOWN"
MODEL_MISSING = "MODEL_MISSING"
NO_CHAPTERS = "NO_CHAPTERS"
INVALID_PDF = "INVALID_PDF"
TOO_LARGE = "TOO_LARGE"
CANCELLED = "CANCELLED"
INTERNAL = "INTERNAL"
HAS_TOC = "HAS_TOC"


class WalnutError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
