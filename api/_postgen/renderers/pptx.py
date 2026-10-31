"""PPTX renderer（REQ-050）：CanonicalContent + 事實 → PosterPlan（模板填充計畫）。

- PRE_EVENT：單頁海報。
- POST_REVIEW：多頁回顧 deck（封面 → 角色亮點分頁 → 封底）。

版面與配色完全由設計師的 .pptx 模板決定，這裡只決定「哪個 token 填什麼」。
事實文字（DATA_ONLY）逐字取自 req；缺漏留 [需由使用者提供]。實際產檔在
infrastructure/pptx/template_filler。

（PostGenerator 另有一條「模板庫為空時由程式畫圖」的舊路徑；內建模板一定
存在，那條路走不到，整併時沒有搬過來。）
"""
from api._postgen.core.config import Settings
from api._postgen.domain.canonical_content import CanonicalContent, RoleHighlight
from api._postgen.renderers.base import fact_or_missing, fmt_date
from api._postgen.schemas.post_request import PostRequest

_ROLES_PER_SLIDE = 4
# 角色類型分組（一類一頁；超過每頁上限再分頁）。順序即投影片順序。
_CATEGORY_ORDER = ["主持群", "功能組", "演講員", "講評群", "其他"]


def _category(role_type: str) -> str:
    rt = role_type or ""
    if "演講" in rt:
        return "演講員"
    if "講評" in rt or "評" in rt:
        return "講評群"
    if "主持" in rt or "暖場" in rt or "司儀" in rt:
        return "主持群"
    if any(k in rt for k in ("計時", "記錄", "攝影", "白板")):
        return "功能組"
    return "其他"


def build_poster_plan(req: PostRequest, cc: CanonicalContent, settings: Settings,
                      templates: list[dict] | None = None,
                      template_id: str | None = None) -> dict | None:
    """M1：產出模板填充計畫（PosterPlan）。座標與配色交給模板，不由程式決定。

    `templates` 由呼叫端取好傳入——T2.1 把 DB 存取移出 renderers/，
    因為模板清單是分會層級資料，取它需要 conn 與 club_id。
    """
    from api._postgen.modules.template_selector import pptx_registry
    from api._postgen.schemas.poster_plan import PosterPlan

    use = req.post_type.value
    tpl = pptx_registry.resolve_from(
        templates or [], template_id or cc.poster_template_id or None)
    if not tpl:
        return None

    warnings: list[str] = []
    fields: dict[str, str] = {}
    role_pages: list[dict[str, str]] = []
    dropped_roles: list[str] = []
    role_photos: list[dict[str, str]] = []
    # 照片：優先用 assets.photos（貼文附圖），相容舊的 hostPhoto 欄位
    photos: dict[str, str] = dict(req.assets.photos or {})
    if req.assets.host_photo and "PHOTO_HOST" not in photos:
        photos["PHOTO_HOST"] = req.assets.host_photo
    t = req.topic

    if use == "PRE_EVENT":
        e = req.event
        fields = {
            "HEADLINE": cc.poster_headline or f"{fact_or_missing(t.title_zh)} {t.title_en}".strip(),
            "THEME": f"{fact_or_missing(t.title_zh)} {t.title_en}".strip(),
            "QUESTION_ZH": t.question_zh or "",
            "QUESTION_EN": t.question_en or "",
            "HOST_NAME": req.host.name or "",
            "DATE": fmt_date(e.date) if e.date else "[需由使用者提供]",
            "TIME": e.time.strip() or settings.default_time,
            "VENUE": fact_or_missing(e.venue),
            "TRANSPORT": e.transport or "",
            "FEE": fact_or_missing(e.fee),
            "REGISTER_URL": req.cta.url.strip() or settings.fixed_register_url,
        }
    else:
        ne = req.next_event
        fields = {
            "HEADLINE": cc.poster_headline or f"{fact_or_missing(t.title_zh)} {t.title_en}".strip(),
            "MEETING_DATE": fmt_date(req.meeting_date) if req.meeting_date else "[需由使用者提供]",
            "THEME": f"{fact_or_missing(t.title_zh)} {t.title_en}".strip(),
            "QUESTION_ZH": t.question_zh or "",
            "NEXT_DATE": fmt_date(ne.date) if ne.date else "[需由使用者提供]",
            "NEXT_TIME": ne.time.strip() or settings.default_time,
            "NEXT_VENUE": fact_or_missing(ne.venue),
            "NEXT_TRANSPORT": ne.transport or "",
            "NEXT_FEE": fact_or_missing(ne.fee),
            "REGISTER_URL": req.cta.url.strip() or settings.fixed_register_url,
            "BRAND_SIGNATURE": cc.brand_signature or "",
        }
        # 角色依類型分組 → 每頁 role_slots_per_page 位
        photo_by_name = {r.name: r.photo for r in req.roles if r.name and r.photo}
        highlights = cc.role_highlights or [
            RoleHighlight(emoji=r.emoji, role_type=r.role_type, name=r.name, highlight=r.contribution)
            for r in req.roles
        ]
        grouped: dict[str, list] = {label: [] for label in _CATEGORY_ORDER}
        for h in highlights:
            grouped[_category(h.role_type)].append(h)

        slots = int(tpl.get("role_slots_per_page") or _ROLES_PER_SLIDE)
        for label in _CATEGORY_ORDER:
            members = grouped[label]
            if not members:
                continue
            chunks = [members[i:i + slots] for i in range(0, len(members), slots)]
            for ci, chunk in enumerate(chunks):
                page = {"GROUP_TITLE": label + (f" {ci + 1}/{len(chunks)}" if len(chunks) > 1 else "")}
                page_photo: dict[str, str] = {}
                for i, h in enumerate(chunk, 1):
                    page[f"ROLE_{i}_HEAD"] = f"{h.emoji} {h.role_type} · {h.name or '[需由使用者提供]'}".strip()
                    page[f"ROLE_{i}_BODY"] = h.highlight or ""
                    photo = photo_by_name.get(h.name)
                    if photo:
                        page_photo[f"PHOTO_ROLE_{i}"] = photo
                role_pages.append(page)
                role_photos.append(page_photo)

        available = int(tpl.get("role_pages") or 0)
        if available and len(role_pages) > available:
            # 分組會產生「沒填滿的頁」（主持群 2 人、其他 1 人…），頁數因此虛胖。
            # 先把塞得下的頁合併，保住每一個人；真的塞不下才排除，且必須回報姓名。
            role_pages, role_photos, merged = _compact_pages(role_pages, role_photos, available, slots)
            if merged:
                warnings.append("角色頁超出模板預留頁數 → 已合併未填滿的頁：" + "、".join(merged))
        if available and len(role_pages) > available:
            dropped_roles = [n for page in role_pages[available:] for n in _page_names(page, slots)]
            warnings.append(
                f"模板僅預留 {available} 頁（每頁 {slots} 位，最多 {available * slots} 位）→ "
                f"{len(dropped_roles)} 位角色未納入海報，請擴充模板頁數"
            )
            role_pages = role_pages[:available]
            role_photos = role_photos[:available]

    return PosterPlan(
        template_id=tpl["id"], template_file=tpl["file"], use=use,
        template_name=tpl["name"],
        preview=tpl.get("preview_url"),
        fields=fields, role_pages=role_pages, warnings=warnings,
        photos=photos, role_photos=role_photos, dropped_roles=dropped_roles,
    ).model_dump()


def _page_names(page: dict, slots: int) -> list[str]:
    """從 ROLE_n_HEAD（「emoji 角色 · 姓名」）取回姓名。"""
    out = []
    for i in range(1, slots + 1):
        head = page.get(f"ROLE_{i}_HEAD") or ""
        if head:
            out.append(head.split(" · ")[-1].strip())
    return out


def _filled(page: dict, slots: int) -> int:
    return sum(1 for i in range(1, slots + 1) if page.get(f"ROLE_{i}_HEAD"))


def _join_pages(pa: dict, pb: dict, fa: dict, fb: dict, slots: int) -> tuple[dict, dict]:
    n = _filled(pa, slots)
    for k in range(1, slots + 1):
        head = pb.get(f"ROLE_{k}_HEAD")
        if not head:
            continue
        n += 1
        pa[f"ROLE_{n}_HEAD"] = head
        pa[f"ROLE_{n}_BODY"] = pb.get(f"ROLE_{k}_BODY", "")
        photo = fb.get(f"PHOTO_ROLE_{k}")
        if photo:
            fa[f"PHOTO_ROLE_{n}"] = photo
    ta, tb = pa.get("GROUP_TITLE", ""), pb.get("GROUP_TITLE", "")
    pa["GROUP_TITLE"] = f"{ta}・{tb}" if ta and tb else (ta or tb)
    return pa, fa


def _compact_pages(pages: list[dict], photos: list[dict], available: int, slots: int):
    """合併未填滿的角色頁，直到符合模板頁數。回傳 (頁, 照片, 被合併的標題)。"""
    merged: list[str] = []
    while len(pages) > available:
        best = None
        for i in range(len(pages)):
            for j in range(i + 1, len(pages)):
                total = _filled(pages[i], slots) + _filled(pages[j], slots)
                if total <= slots and (best is None or total > best[0]):
                    best = (total, i, j)
        if best is None:
            break                       # 沒有兩頁塞得下 → 交給呼叫端排除並回報
        _, i, j = best
        pages[i], photos[i] = _join_pages(pages[i], pages[j], photos[i], photos[j], slots)
        merged.append(pages[i]["GROUP_TITLE"])
        pages.pop(j)
        photos.pop(j)
    return pages, photos, merged
