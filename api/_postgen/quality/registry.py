"""Quality Checker 規則註冊表：MVP 啟用的硬規則（可逐條開關）。"""
from api._postgen.quality.rules import (
    rule_banned_words,
    rule_cta_consistency,
    rule_event_info_complete,
    rule_no_fabricated_facts,
    rule_roles_match_input,
)

ACTIVE_RULES = [
    rule_no_fabricated_facts,   # QC-01（紅線）
    rule_event_info_complete,   # QC-03
    rule_roles_match_input,     # QC-04（紅線）
    rule_banned_words,          # QC-05
    rule_cta_consistency,       # QC-08
]


def run_all(req, cc, fb_text, settings):
    return [rule.check(req, cc, fb_text, settings) for rule in ACTIVE_RULES]
