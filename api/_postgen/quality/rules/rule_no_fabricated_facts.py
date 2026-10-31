"""QC-01（最高優先）：事實白名單——必填事實齊全、可溯源，缺漏即 Fail。"""
from api._postgen.domain import fact_whitelist
from api._postgen.quality.base import CheckItem


def check(req, cc, fb_text, settings) -> CheckItem:
    missing = fact_whitelist.find_missing(req)
    if missing:
        return CheckItem("facts", "crit", "事實白名單（QC-01）", "缺漏：" + "、".join(missing))
    return CheckItem("facts", "ok", "事實白名單（QC-01）", "日期／地點／連結／姓名皆可溯源")
