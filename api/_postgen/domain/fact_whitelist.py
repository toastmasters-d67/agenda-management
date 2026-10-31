"""事實紅線白名單（§4.3）— 單一事實來源，供 parser / injection / quality 共用。"""
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest

# (屬性路徑, 顯示名稱)
# EntrepreneurAgenda：「本週問句」改為選填——多數分會的議程沒有這一欄，
# 照 PostGenerator 列為必填會擋下每一則宣傳。主題仍然必填（欄位名沿用
# title_zh，但不限中文：只有英文主題的分會一樣放在這裡）。
REQUIRED_PRE = [
    ("topic.title_zh", "主題"),
    ("event.date", "日期"),
    ("event.venue", "地點"),
    ("event.fee", "費用"),
]
REQUIRED_REVIEW = [
    ("topic.title_zh", "主題"),
    ("meeting_date", "例會日期"),
    ("next_event.venue", "下次地點"),
    ("next_event.fee", "下次費用"),
]


def _get_path(obj, path: str):
    cur = obj
    for part in path.split("."):
        cur = getattr(cur, part, None)
        if cur is None:
            return None
    return cur


def required_fields(req: PostRequest):
    return REQUIRED_REVIEW if req.post_type == PostType.POST_REVIEW else REQUIRED_PRE


def find_missing(req: PostRequest) -> list[str]:
    """回傳缺漏的必填事實欄位『顯示名稱』清單。"""
    missing = []
    for path, label in required_fields(req):
        val = _get_path(req, path)
        if not (val and str(val).strip()):
            missing.append(label)
    return missing
