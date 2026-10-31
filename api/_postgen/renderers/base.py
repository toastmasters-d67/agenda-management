"""Renderer 介面：把 (CanonicalContent + 事實) 轉為各平台輸出。"""
from typing import Protocol


def fmt_date(iso: str) -> str:
    """YYYY-MM-DD → M/D；非日期原樣回。"""
    parts = (iso or "").split("-")
    if len(parts) == 3 and parts[0].isdigit():
        try:
            return f"{int(parts[1])}/{int(parts[2])}"
        except ValueError:
            return iso
    return iso


_WEEKDAYS_ZH = "一二三四五六日"


def weekday_zh(iso: str) -> str:
    """YYYY-MM-DD → 「（二）」；不是日期就回空字串。

    PostGenerator 的資訊欄把「（二）」寫死在字串裡——那是 Chill Hi High 的
    例會日。多分會之後星期幾是**日期算出來的事實**，不是版面的一部分。
    """
    from datetime import date

    try:
        y, m, d = (int(x) for x in (iso or "").split("-"))
        return f"（{_WEEKDAYS_ZH[date(y, m, d).weekday()]}）"
    except ValueError:
        return ""


def fact_or_missing(v: str) -> str:
    return v.strip() if (v and v.strip()) else "[需由使用者提供]"


class Renderer(Protocol):
    def render(self, req, cc, settings): ...
