"""⑧ CTA Generator（REQ-010、CTA-01/02）：型別化指向 + URL 鎖定。"""
from api._postgen.core.config import Settings
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest


def resolve(req: PostRequest, settings: Settings,
            text: str = "") -> tuple[str, str]:
    """回傳 (cta_text, url)。url 缺漏套品牌固定連結；不可捏造。

    `text` 是**這一篇**的行動呼籲措辭（T8.14；預設值由 `prompt_prefs`
    依貼文類型與分會名組出來）。在 T8.11 之前這裡寫死「立即報名
    Chill Hi High」——那句話會原樣印在每一個分會的貼文裡。

    **兩種貼文都吃這個值。** T8.11 只讓宣傳文可覆寫，於是「為什麼回顧
    貼文改不動」會變成一個沒有人答得出來的問題。
    """
    url = req.cta.url.strip() or settings.fixed_register_url
    fallback = ("立即報名下一場例會"
                if req.post_type == PostType.POST_REVIEW else "立即報名")
    return (text.strip() or fallback), url
