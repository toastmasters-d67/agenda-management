"""FB renderer：組 CanonicalContent（可變）+ PostRequest（事實）→ 純文字貼文。

事實一律取自 req（DATA_ONLY），創意取自 cc；事實不經 LLM。
"""
from api._postgen.core.config import Settings
from api._postgen.domain.canonical_content import CanonicalContent
from api._postgen.renderers.base import fact_or_missing, fmt_date, weekday_zh
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest


def _squash(text: str) -> str:
    """拿掉所有空白。**hashtag 裡有空白，Facebook 只認到第一個空白為止**：
    `#The Gift of Failure` 會變成 `#The` 一個標籤，後面三個字成了普通文字。

    英文主題幾乎都是多個字，2026-10-24 品質評估時三篇裡就有一篇這樣斷掉。
    """
    return "".join((text or "").split())


def _dedupe_tags(tags: list[str]) -> list[str]:
    """去除重複 hashtag（AI 補的主題標籤可能與系統帶入的重疊），保留原順序。

    比對前先拿掉空白（見 `_squash`），所以 `#The Gift of Failure` 與 AI 補的
    `#TheGiftOfFailure` 算同一個。
    """
    seen: set[str] = set()
    out: list[str] = []
    for t in tags:
        tag = _squash(t)
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    return out


def _prefixes(cc: CanonicalContent, fallback: tuple[str, ...]) -> list[str]:
    """這一篇資訊欄的五個前綴，**已經套好開關與自訂那一組**（T8.14）。

    關掉時回五個空字串——連同 emoji 後面那個空格一起不印。

    **只有前綴可以換，標籤（時間／地點／費用…）不行。** 那五行是事實
    欄位，而 Quality Checker 比對的是結構化輸入——標籤被換掉它看不到。
    """
    if not cc.info_emoji:
        return [""] * len(fallback)
    chosen = list(cc.info_emojis) if len(cc.info_emojis) == len(fallback) \
        else list(fallback)
    return [f"{e} " for e in chosen]


def render(req: PostRequest, cc: CanonicalContent, settings: Settings) -> str:
    if req.post_type == PostType.POST_REVIEW:
        return _render_review(req, cc, settings)
    return _render_pre_event(req, cc, settings)


def _render_pre_event(req: PostRequest, cc: CanonicalContent, settings: Settings) -> str:
    t = req.topic
    e = req.event
    url = req.cta.url.strip() or settings.fixed_register_url
    time = e.time.strip() or settings.default_time
    date = fmt_date(e.date) if e.date else "[需由使用者提供]"

    tags = ([f"#{t.title_zh}"] if t.title_zh else []) \
        + ([f"#{t.title_en}"] if t.title_en else []) \
        + cc.fixed_hashtags + cc.topic_hashtags

    p = _prefixes(cc, ("🗓", "📍", "🚶", "💰", "🔗"))
    lines = [
        f"【{fact_or_missing(t.title_zh)} {t.title_en}】{cc.title_tagline}".rstrip(),
        "",
        cc.opening_hook,
        cc.story,
        "",
        cc.host_intro,
        "",
        # 本週問句是選填：沒有就整段不印（不印「需由使用者提供」）。
        *(["本週主題｜", t.question_zh, t.question_en, ""] if t.question_zh.strip() else []),
        cc.cta_text,
        f"{p[0]}時間｜{date}{weekday_zh(e.date)}{time}",
        f"{p[1]}地點｜{fact_or_missing(e.venue)}",
        f"{p[2]}交通｜{e.transport or '[需由使用者提供]'}",
        f"{p[3]}費用｜{fact_or_missing(e.fee)}",
        # 報名連結是選填：沒有就整行不印，不留一個空的冒號。
        *([f"{p[4]}報名連結：{url}"] if url else []),
        "",
        " ".join(_dedupe_tags(tags)),
    ]
    return "\n".join(l for l in lines if l is not None)


def _render_review(req: PostRequest, cc: CanonicalContent, settings: Settings) -> str:
    t = req.topic
    ne = req.next_event
    url = req.cta.url.strip() or settings.fixed_register_url
    time = ne.time.strip() or settings.default_time
    tag = f"#例會{(req.meeting_date or '').replace('-', '')} #{_squash(t.title_zh + t.title_en)}"

    role_blocks = []
    for h in cc.role_highlights:
        head = f"{h.emoji} {h.role_type} {h.name or '[需由使用者提供]'}".strip()
        role_blocks.append(f"{head}\n{h.highlight}".rstrip())

    p = _prefixes(cc, ("👉", "📅", "📍", "🚶", "💰"))
    lines = [
        cc.review_headline,
        tag,
        "",
        cc.opening,
        "",
        "\n\n".join(role_blocks),
        "",
        "—",
        cc.brand_signature,
        "",
        f"{p[0]}{cc.cta_text}：{url}" if url else f"{p[0]}{cc.cta_text}",
        f"{p[1]}下次例會｜{fmt_date(ne.date) if ne.date else '[需由使用者提供]'}{weekday_zh(ne.date)}{time}",
        f"{p[2]}地點｜{fact_or_missing(ne.venue)}",
        f"{p[3]}交通｜{ne.transport or '[需由使用者提供]'}",
        f"{p[4]}費用｜{fact_or_missing(ne.fee)}",
        "",
        " ".join(_dedupe_tags(cc.fixed_hashtags + ["#Toastmasters"] + cc.topic_hashtags)),
    ]
    return "\n".join(l for l in lines if l is not None)
