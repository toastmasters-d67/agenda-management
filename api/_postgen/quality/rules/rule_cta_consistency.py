"""QC-08：CTA 指向與型別一致、含連結。"""
from api._postgen.quality.base import CheckItem
from api._postgen.schemas.enums import PostType


def check(req, cc, fb_text, settings) -> CheckItem:
    url = req.cta.url.strip() or settings.fixed_register_url
    if not url:
        # EntrepreneurAgenda：報名連結是選填（很多分會歡迎直接來，沒有報名表）。
        # 沒有連結時資訊欄不印那一行，行動呼籲只留文字。
        return CheckItem("cta", "ok", "CTA 指向（QC-08）", "未設定報名連結，貼文不印連結")
    target = "下一場例會" if req.post_type == PostType.POST_REVIEW else "本場報名"
    return CheckItem("cta", "ok", "CTA 指向（QC-08）", f"指向{target}")
