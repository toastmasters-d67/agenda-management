"""PPTX 產檔介面。"""
from typing import Protocol


class PptxWriter(Protocol):
    def build(self, design_spec: dict) -> bytes:
        """由 designSpec 產出可編輯的 .pptx（bytes）。"""
        ...
