"""領域例外（REQ-002/003 缺漏與紅線）。"""
from __future__ import annotations


class DomainError(Exception):
    """所有領域例外基底。"""


class MissingRequiredFieldError(DomainError):
    """必填欄位缺漏，需中斷（REQ-002 / IN-02）。"""

    def __init__(self, field: str):
        self.field = field
        super().__init__(f"必填欄位缺漏，中斷：{field}")


class FabricatedFactError(DomainError):
    """偵測到捏造事實（REQ-003/034 紅線）。"""


class PromptInjectionError(DomainError):
    """偵測到越權指令（REQ-022）。"""


class LLMError(DomainError):
    """呼叫 LLM 失敗（金鑰無效、額度不足、逾時、服務異常）。

    帶 hint 供前端直接顯示可行動的修正建議。
    """

    def __init__(self, message: str, hint: str = ""):
        self.hint = hint
        super().__init__(message)
