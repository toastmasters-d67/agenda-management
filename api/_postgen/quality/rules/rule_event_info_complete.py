"""QC-03：活動資訊 5 項齊全（日期/時間/地點/費用/連結）。"""
from api._postgen.quality.base import CheckItem
from api._postgen.schemas.enums import PostType


def check(req, cc, fb_text, settings) -> CheckItem:
    if req.post_type == PostType.POST_REVIEW:
        ev = req.next_event
        items = {"日期": req.meeting_date, "地點": ev.venue, "費用": ev.fee}
    else:
        ev = req.event
        # 報名連結是選填，不算進「活動資訊齊全」。
        items = {"日期": ev.date, "時間": ev.time, "地點": ev.venue, "費用": ev.fee}
    missing = [k for k, v in items.items() if not (v and str(v).strip())]
    if missing:
        return CheckItem("event", "warn", "活動資訊齊全（QC-03）", "缺：" + "、".join(missing))
    return CheckItem("event", "ok", "活動資訊齊全（QC-03）", "日期／時間／地點／費用／連結")
