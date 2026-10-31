"""LLM client 介面（便於在真實 Anthropic 與假 client 間切換、可測試）。"""
from typing import Protocol


class LLMClient(Protocol):
    def generate(self, system: str, user: str | list[dict], tool: dict) -> dict:
        """以強制 tool use 呼叫模型，回傳工具的 input（dict）。

        `user` 可為字串，或 Anthropic content block 陣列（影像／PDF 輸入用，見 S6 §16.2）。
        Messages API 的 content 本來就同時接受兩者，故 client 端為純傳遞。
        """
        ...
