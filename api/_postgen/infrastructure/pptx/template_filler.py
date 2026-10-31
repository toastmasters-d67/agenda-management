"""模板填充引擎（M1）：開啟設計師的 .pptx → 替換 token → 刪除多餘角色頁 → 回傳 bytes。

設計要點
- **只改文字**：背景、色塊、Logo、照片框、字級、位置一律保留 → 視覺完全由模板決定。
- **格式優先保留**：先做 run 層替換（保住該 token 的字級/顏色）；token 被切成多段時，
  退回段落層合併替換（格式統一為該段第一個 run）。
- **未使用 token 一律清空**，不留 `{{...}}` 於產出。
- python-pptx 無法複製投影片 → 採「模板預留 N 頁角色頁，填完刪除多餘頁」。
"""
import io
import logging
import re
from pathlib import Path

from PIL import Image
from pptx import Presentation

logger = logging.getLogger(__name__)

_R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
_TOKEN_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def _sub(text: str, mapping: dict[str, str]) -> str:
    """替換已知 token；未提供值的 token 一律清成空字串。"""
    return _TOKEN_RE.sub(lambda m: mapping.get(m.group(1), ""), text)


def _fill_paragraph(para, mapping: dict[str, str]) -> None:
    joined = "".join(r.text for r in para.runs)
    if "{{" not in joined:
        return
    # ① run 層替換（保留各 run 原格式）
    for run in para.runs:
        if "{{" in run.text:
            run.text = _sub(run.text, mapping)
    if "{{" not in "".join(r.text for r in para.runs):
        return
    # ② 退路：token 跨 run（設計師在 token 中間改過格式）→ 合併到第一個 run
    merged = _sub("".join(r.text for r in para.runs), mapping)
    runs = list(para.runs)
    if runs:
        runs[0].text = merged
        for r in runs[1:]:
            r.text = ""


def _embed_photos(slide, photos: dict[str, str], resolve_photo) -> None:
    """把照片嵌入命名的照片框（PHOTO_*），並置中裁切以填滿、不變形。

    做法：在佔位框的相同位置與尺寸插入圖片，再刪除原佔位框。

    `photos` 的值來自**請求內容**，因此一律經 `resolve_photo(ref)` 解析成
    本機路徑——由呼叫端決定哪些引用算數（EntrepreneurAgenda：只收這則貼文
    自己的附圖）。解析不到的行為與「沒上傳」相同：保留佔位框，不報錯。
    """
    if not photos or resolve_photo is None:
        return
    for shape in list(slide.shapes):
        name = getattr(shape, "name", "")
        if not name.startswith("PHOTO_"):
            continue
        ref = photos.get(name)
        path = resolve_photo(ref) if ref else None
        if not path:
            if ref:
                logger.warning("照片引用解析失敗，該框保留佔位：slot=%s ref=%s", name, ref)
            continue                       # 沒上傳（或不屬於自己）就保留佔位框
        left, top = shape.left, shape.top
        width, height = shape.width, shape.height
        pic = slide.shapes.add_picture(str(path), left, top, width=width, height=height)
        _center_crop(pic, str(path), width, height)
        shape._element.getparent().remove(shape._element)   # 移除佔位框


def _center_crop(pic, image_path: str, box_w: int, box_h: int) -> None:
    """以置中裁切填滿外框，避免照片被拉伸變形。"""
    try:
        with Image.open(image_path) as im:
            img_w, img_h = im.size
    except Exception:                       # noqa: BLE001 — 讀不到尺寸就維持原樣
        return
    if not img_w or not img_h or not box_w or not box_h:
        return
    img_ratio = img_w / img_h
    box_ratio = box_w / box_h
    if abs(img_ratio - box_ratio) < 1e-3:
        return
    if img_ratio > box_ratio:               # 圖太寬 → 左右各裁一些
        keep = box_ratio / img_ratio
        cut = (1 - keep) / 2
        pic.crop_left = cut
        pic.crop_right = cut
    else:                                   # 圖太高 → 上下各裁一些
        keep = img_ratio / box_ratio
        cut = (1 - keep) / 2
        pic.crop_top = cut
        pic.crop_bottom = cut


def _fill_slide(slide, mapping: dict[str, str]) -> None:
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            _fill_paragraph(para, mapping)


def _delete_slides(prs: Presentation, indices: list[int]) -> None:
    """刪除指定索引的投影片（由大到小刪，避免索引位移）。"""
    id_list = prs.slides._sldIdLst
    entries = list(id_list)
    for idx in sorted(indices, reverse=True):
        if 0 <= idx < len(entries):
            entry = entries[idx]
            rid = entry.get(_R_NS)
            if rid:
                prs.part.drop_rel(rid)
            id_list.remove(entry)


def fill_template(template_path: str | Path, plan: dict, *,
                  resolve_photo=None) -> bytes:
    """依 PosterPlan 填充模板。

    plan: {use, fields{token:value}, role_pages[[{token:value}...]]}
    - PRE_EVENT：所有投影片套用 fields。
    - POST_REVIEW：第 1 頁（封面）與最後 1 頁（封底）套用 fields；
      中間為角色頁 → 依序填 role_pages，未用到的頁刪除。
    """
    prs = Presentation(str(template_path))
    fields = plan.get("fields") or {}
    role_pages = plan.get("role_pages") or []
    photos = plan.get("photos") or {}                 # 全域照片（主持人／團體照）
    role_photos = plan.get("role_photos") or []       # 每頁角色人像
    use = (plan.get("use") or "PRE_EVENT").upper()
    slides = list(prs.slides)

    if use != "POST_REVIEW" or len(slides) < 3:
        for slide in slides:
            _fill_slide(slide, fields)
            _embed_photos(slide, photos, resolve_photo)
        return _save(prs)

    for slide in (slides[0], slides[-1]):   # 封面 / 封底
        _fill_slide(slide, fields)
        _embed_photos(slide, photos, resolve_photo)

    role_idx = list(range(1, len(slides) - 1))
    unused: list[int] = []
    for n, idx in enumerate(role_idx):
        if n < len(role_pages):
            _fill_slide(slides[idx], {**fields, **role_pages[n]})
            page_photos = {**photos, **(role_photos[n] if n < len(role_photos) else {})}
            _embed_photos(slides[idx], page_photos, resolve_photo)
        else:
            unused.append(idx)
    if unused:
        _delete_slides(prs, unused)
    return _save(prs)


def _save(prs: Presentation) -> bytes:
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()
