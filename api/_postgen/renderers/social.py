"""Instagram／Threads renderer：從**同一份**受控內容改寫，不另外叫模型寫。

PostGenerator 只產 Facebook 文案；EntrepreneurAgenda 的社群發文要三個平台。
讓模型另外為 IG／Threads 各寫一份，等於繞過事實白名單與 QC——那兩份裡的
日期地點沒有任何東西在檢查。所以這裡只做**程式改寫**：

- Instagram：與 FB 同一份文字，只把報名連結那一行換成「連結在個人簡介」
  （IG 內文連結不可點），超過 2200 字時拿掉故事段。
- Threads：上限 500 字。取標題、開頭鉤子、時間地點費用、連結與 1–2 個
  hashtag；放不下時先丟鉤子，事實行永遠保留。

事實行一律從 `req` 取（與 FB renderer 同一組函式），不從 FB 文字裡解析。

字數上限讀 `lib/socialPlatforms.json`——前端的字數計數器讀的是同一份。
"""
from __future__ import annotations

import json
from pathlib import Path

from api._postgen.core.config import Settings
from api._postgen.domain.canonical_content import CanonicalContent
from api._postgen.renderers.base import fact_or_missing, fmt_date, weekday_zh
from api._postgen.renderers.facebook import _dedupe_tags, _squash
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest

_SPECS = {p["key"]: p for p in json.loads(
    (Path(__file__).resolve().parents[3] / "lib" / "socialPlatforms.json")
    .read_text(encoding="utf-8"))["platforms"]}
IG_LIMIT = _SPECS["instagram"]["max"]
THREADS_LIMIT = _SPECS["threads"]["max"]
IG_LINK_LINE = "報名連結在個人簡介"


def instagram(req: PostRequest, cc: CanonicalContent, settings: Settings, fb_text: str) -> str:
    url = req.cta.url.strip() or settings.fixed_register_url
    lines = []
    for line in (fb_text or "").splitlines():
        if url and url in line:
            # 「🔗 報名連結：https://…」→「🔗 報名連結在個人簡介」，前綴 emoji 保留。
            head = line.split(url)[0].rstrip("：: ")
            prefix = head[: len(head) - len(head.lstrip("🔗👉 "))] if head else ""
            line = f"{prefix}{IG_LINK_LINE}" if "報名" in head else line.replace(url, IG_LINK_LINE)
        lines.append(line)
    text = "\n".join(lines)
    if len(text) > IG_LIMIT and cc.story:
        text = text.replace(cc.story + "\n", "", 1)
    return text[:IG_LIMIT]


def _info_lines(req: PostRequest, settings: Settings) -> list[str]:
    url = req.cta.url.strip() or settings.fixed_register_url
    if req.post_type == PostType.POST_REVIEW:
        ne = req.next_event
        time = ne.time.strip() or settings.default_time
        lines = [f"📅 下次例會｜{fmt_date(ne.date) if ne.date else '[需由使用者提供]'}"
                 f"{weekday_zh(ne.date)}{time}",
                 f"📍 {fact_or_missing(ne.venue)}"]
    else:
        e = req.event
        time = e.time.strip() or settings.default_time
        lines = [f"🗓 {fmt_date(e.date) if e.date else '[需由使用者提供]'}{weekday_zh(e.date)}{time}",
                 f"📍 {fact_or_missing(e.venue)}",
                 f"💰 {fact_or_missing(e.fee)}"]
    if url:
        lines.append(f"🔗 {url}")
    return lines


def threads(req: PostRequest, cc: CanonicalContent, settings: Settings) -> str:
    t = req.topic
    if req.post_type == PostType.POST_REVIEW:
        title = cc.review_headline
        hook = cc.opening
        tags = cc.fixed_hashtags[:1] + cc.topic_hashtags[:1]
    else:
        title = f"【{fact_or_missing(t.title_zh)} {t.title_en}】".replace(" 】", "】")
        hook = cc.opening_hook
        tags = ([f"#{_squash(t.title_zh)}"] if t.title_zh else []) + cc.fixed_hashtags[:1]
    tag_line = " ".join(_dedupe_tags(tags)[:2])
    info = "\n".join(_info_lines(req, settings))

    def compose(with_hook: bool) -> str:
        parts = [title.strip()]
        if with_hook and hook.strip():
            parts.append(hook.strip())
        parts += [info, tag_line]
        return "\n\n".join(p for p in parts if p)

    text = compose(True)
    if len(text) > THREADS_LIMIT:
        text = compose(False)
    return text[:THREADS_LIMIT]
