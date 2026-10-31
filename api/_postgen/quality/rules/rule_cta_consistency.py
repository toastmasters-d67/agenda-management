"""QC-08：CTA 指向與型別一致、含連結。"""
from api._postgen.quality.base import CheckItem
from api._postgen.schemas.enums import PostType


def check(req, cc, fb_text, settings) -> CheckItem:
    url = req.cta.url.strip() or settings.fixed_register_url
    if not url:
        return CheckItem("cta", "crit", "CTA 指向（QC-08）", "缺報名連結：請至「社群發文 → 貼文品牌設定」填入報名連結")
    target = "下一場例會" if req.post_type == PostType.POST_REVIEW else "本場報名"
    return CheckItem("cta", "ok", "CTA 指向（QC-08）", f"指向{target}")
