"""complianceNotes — 內部治理欄位（REQ-018）：缺漏 / 套用預設 / 未驗證。"""
from typing import Literal

from pydantic import BaseModel


class ComplianceNote(BaseModel):
    severity: Literal["info", "warn", "crit"]
    text: str
