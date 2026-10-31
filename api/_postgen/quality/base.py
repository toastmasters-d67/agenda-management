"""Quality Checker 規則基底。"""
from dataclasses import dataclass


@dataclass
class CheckItem:
    key: str
    state: str      # ok | warn | crit
    title: str
    detail: str = ""
