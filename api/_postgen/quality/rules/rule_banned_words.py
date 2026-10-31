"""QC-05：禁用詞／誇張銷售感偵測（品牌語氣紅線）。"""
from api._postgen.quality.base import CheckItem


def check(req, cc, fb_text, settings) -> CheckItem:
    # T2.1：禁用詞由 CanonicalContent 帶入（story_builder 從品牌資產填的），
    # 規則層不查資料庫——否則這個介面就得多收 conn 與 club_id。
    banned = getattr(cc, "banned_words", None) or []
    hits = [w for w in banned if w and w in (fb_text or "")]
    if hits:
        return CheckItem("banned", "crit", "禁用詞／誇張偵測（QC-05）", "命中：" + "、".join(hits))
    return CheckItem("banned", "ok", "禁用詞／誇張偵測（QC-05）", "無銷售感、無誇張詞")
