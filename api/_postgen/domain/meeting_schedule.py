"""例會週期：由規則推下次例會日，並由歷史例會日反推規則（S5 §2.2）。

純函式、零框架相依，與其他紅線邏輯同層。兩條原則貫穿本模組：

- **規則不明就不猜**：無解時回 None / "insufficient"，不編造日期（同 REQ-003 精神）。
- **多解不任選**：若多個規則都能解釋歷史，回報全部候選讓人決定（REQ-067）。

支援兩種規則型別::

    {"type": "monthly_nth_weekday", "weekday": 1, "nths": [2, 4]}   # 每月第 2、4 個週二
    {"type": "fixed_interval", "days": 14, "anchor": "2026-08-11"}  # 每兩週

`weekday` 採 Python date.weekday() 慣例（0=週一 … 6=週日）。
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta

MIN_SAMPLES = 3            # 少於此數不推導（§2.2.4）
MAX_OUTLIERS = 1           # 容忍幾場調期（§2.2.5）
INTERVALS = (7, 14, 21, 28)
_WEEKDAY_ZH = "一二三四五六日"
_MAX_MONTHS = 36           # next_meeting_date 的搜尋上限，避免規則無解時無限迴圈


# ── 規則正規化 ────────────────────────────────────────────────────────
def parse_date(value: date | str) -> date | None:
    """把 ISO 字串或 date 轉成 date；無法解析回 None（不猜）。"""
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except (TypeError, ValueError):
        return None


def normalize(cadence: dict | None) -> dict | None:
    """檢查並正規化規則；不合法回 None（呼叫端據此不推算）。

    相容舊寫法 {"type": "biweekly", "anchor": ...} → fixed_interval days=14。
    """
    if not isinstance(cadence, dict) or not cadence:
        return None
    kind = cadence.get("type")
    try:
        if kind == "monthly_nth_weekday":
            weekday = int(cadence["weekday"])
            nths = sorted({int(n) for n in cadence["nths"]})
            if not 0 <= weekday <= 6 or not nths or not all(1 <= n <= 5 for n in nths):
                return None
            return {"type": "monthly_nth_weekday", "weekday": weekday, "nths": nths}
        if kind in ("fixed_interval", "biweekly"):
            days = int(cadence.get("days", 14))
            anchor = parse_date(cadence.get("anchor", ""))
            if days <= 0 or anchor is None:
                return None
            return {"type": "fixed_interval", "days": days, "anchor": anchor.isoformat()}
    except (KeyError, TypeError, ValueError):
        return None
    return None


def describe(cadence: dict | None) -> str:
    """人看得懂的規則說明，用於 complianceNote 與介面。"""
    c = normalize(cadence)
    if not c:
        return "未設定"
    if c["type"] == "monthly_nth_weekday":
        nths = "、".join(str(n) for n in c["nths"])
        return f"每月第 {nths} 個週{_WEEKDAY_ZH[c['weekday']]}"
    days = c["days"]
    label = {7: "每週", 14: "每兩週", 21: "每三週", 28: "每四週"}.get(days, f"每 {days} 天")
    anchor = parse_date(c["anchor"])
    return f"{label}（自 {anchor} 起算）"


# ── 由規則推日期 ──────────────────────────────────────────────────────
def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date | None:
    """該月第 nth 個 weekday；該月沒有第 nth 個（如第 5 個週二）回 None。"""
    first = date(year, month, 1)
    day = 1 + (weekday - first.weekday()) % 7 + 7 * (nth - 1)
    try:
        d = date(year, month, day)
    except ValueError:
        return None
    return d if d.month == month else None


def series(lo: date, hi: date, cadence: dict | None) -> list[date]:
    """規則在 [lo, hi] 區間內預測的所有例會日（含端點）。"""
    c = normalize(cadence)
    if not c or lo > hi:
        return []
    out: list[date] = []
    if c["type"] == "monthly_nth_weekday":
        y, m = lo.year, lo.month
        while (y, m) <= (hi.year, hi.month):
            for n in c["nths"]:
                d = _nth_weekday(y, m, c["weekday"], n)
                if d and lo <= d <= hi:
                    out.append(d)
            m += 1
            if m > 12:
                y, m = y + 1, 1
    else:
        days, anchor = c["days"], parse_date(c["anchor"])
        d = anchor + timedelta(days=days * ((lo - anchor).days // days))
        while d < lo:
            d += timedelta(days=days)
        while d <= hi:
            out.append(d)
            d += timedelta(days=days)
    return sorted(out)


def next_meeting_date(after: date, cadence: dict | None) -> date | None:
    """after 之後（不含當日）的下一個例會日；規則不明或無解回 None。"""
    c = normalize(cadence)
    if not c or not isinstance(after, date):
        return None
    if c["type"] == "fixed_interval":
        days, anchor = c["days"], parse_date(c["anchor"])
        return anchor + timedelta(days=days * ((after - anchor).days // days + 1))
    # monthly：由當月往後掃，遇到第一個晚於 after 的即回傳
    y, m = after.year, after.month
    for _ in range(_MAX_MONTHS):
        found = [d for n in c["nths"]
                 if (d := _nth_weekday(y, m, c["weekday"], n)) and d > after]
        if found:
            return min(found)
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return None


# ── 由歷史日期反推規則 ────────────────────────────────────────────────
@dataclass(frozen=True)
class InferResult:
    """三態回報（REQ-067）。多解時 candidates 必含全部候選，呼叫端不得任選。"""

    status: str                                   # unique | ambiguous | insufficient | no_match
    candidates: tuple[dict, ...] = ()
    outliers: tuple[str, ...] = ()                # 不符規則的日期（可能是調期）
    samples: int = 0
    note: str = ""

    def as_dict(self) -> dict:
        return {"status": self.status, "candidates": list(self.candidates),
                "outliers": list(self.outliers), "samples": self.samples,
                "note": self.note, "描述": [describe(c) for c in self.candidates]}


def _nth_of(d: date) -> int:
    return (d.day - 1) // 7 + 1


def _candidates(ds: list[date]) -> list[dict]:
    """列出所有值得評分的規則。

    monthly 的 nths **不可直接取觀測到的全集**，否則一次調期就會被學成規則的一部分：
    9/29 是當月第 5 個週二，全集會變成「第 2、4、5 個」——它完美解釋歷史卻是錯的。
    因此只採納「有跨月支撐」的 nth：資料橫跨 3 個月以上時，該 nth 至少要出現 2 次。
    """
    out: list[dict] = []
    weekday = Counter(d.weekday() for d in ds).most_common(1)[0][0]
    on_wd = [d for d in ds if d.weekday() == weekday]
    counts = Counter(_nth_of(d) for d in on_wd)
    months = {(d.year, d.month) for d in on_wd}
    min_support = 2 if len(months) >= 3 else 1
    nths = sorted(n for n, c in counts.items() if c >= min_support) or sorted(counts)
    out.append({"type": "monthly_nth_weekday", "weekday": weekday, "nths": nths})
    # 首場本身可能就是離群值 → 錨點多試幾個
    for days in INTERVALS:
        for anchor in ds[: MAX_OUTLIERS + 1]:
            out.append({"type": "fixed_interval", "days": days, "anchor": anchor.isoformat()})
    return out


def _score(ds: list[date], cadence: dict) -> tuple[int, list[date]] | None:
    """回傳 (分數, 離群日)；規則無法接受時回 None。分數越低越貼合。

    unexplained：實際開過但規則解釋不了 → 就是「調期」，回報之。
    missed：規則預測會開但沒開 → 也算誤差，否則「每週」會被誤判為符合「每兩週」的紀錄。
    """
    predicted = set(series(ds[0], ds[-1], cadence))
    observed = set(ds)
    unexplained = sorted(observed - predicted)
    missed = predicted - observed
    if len(unexplained) > MAX_OUTLIERS:
        return None
    if len(missed) > MAX_OUTLIERS + len(unexplained):
        return None
    return len(unexplained) + len(missed), unexplained


def _canonical(cadence: dict, ds: list[date]) -> dict:
    """把等價規則收斂成同一形式，避免同一規則被當成多個候選。"""
    if cadence["type"] != "fixed_interval":
        return cadence
    hit = [d for d in series(ds[0], ds[-1], cadence) if d in set(ds)]
    if hit:
        cadence = {**cadence, "anchor": hit[0].isoformat()}
    return cadence


def _key(cadence: dict) -> tuple:
    if cadence["type"] == "monthly_nth_weekday":
        return ("m", cadence["weekday"], tuple(cadence["nths"]))
    return ("f", cadence["days"], cadence["anchor"])


def infer_cadence(dates) -> InferResult:
    """由歷史例會日反推週期規則（§2.2.2 層 2）。

    刻意不回傳「最像的一個」——多解時一律回 ambiguous 並列出全部候選，
    由人決定或等資料再累積（實測需約 6 場才能唯一確定，見 §2.2.3）。
    """
    ds = sorted({d for d in (parse_date(x) for x in (dates or [])) if d is not None})
    if len(ds) < MIN_SAMPLES:
        return InferResult("insufficient", samples=len(ds),
                           note=f"需至少 {MIN_SAMPLES} 場，目前 {len(ds)} 場")

    scored = []
    for cand in _candidates(ds):
        got = _score(ds, cand)
        if got:
            scored.append((got[0], _canonical(cand, ds), got[1]))
    if not scored:
        return InferResult("no_match", samples=len(ds),
                           note="現有紀錄無法以任何單一規則解釋，週期可能已變更")

    best = min(n for n, _, _ in scored)
    winners: dict[tuple, tuple[dict, list[date]]] = {}
    for n, cand, outliers in scored:
        if n == best:
            winners.setdefault(_key(cand), (cand, outliers))

    if len(winners) == 1:
        cand, outliers = next(iter(winners.values()))
        note = describe(cand)
        if outliers:
            note += f"（{len(ds)} 場中 {len(ds) - len(outliers)} 場符合）"
        return InferResult("unique", (cand,), tuple(d.isoformat() for d in outliers),
                           len(ds), note)

    cands = tuple(c for c, _ in winners.values())
    return InferResult("ambiguous", cands, (), len(ds),
                       f"{len(cands)} 種規則都符合現有 {len(ds)} 場紀錄，需再累積或手動指定")
