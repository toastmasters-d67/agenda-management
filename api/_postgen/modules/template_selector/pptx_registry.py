"""PPTX 模板登錄。

來源優先序：
1. **分會上傳**（EntrepreneurAgenda 的 `post_templates` 表，檔案在 R2）
2. **manifest.yaml**（內建預設，如 token 骨架檔）

新增模板 = 上傳（或放檔 + manifest 加一筆），核心程式不動（REQ-042／OUT-04）。
"""
from functools import lru_cache
from pathlib import Path

import yaml

TEMPLATE_DIR = Path(__file__).resolve().parents[2] / "assets" / "templates" / "pptx"
_MANIFEST = TEMPLATE_DIR / "manifest.yaml"

_DEFAULT_SLOTS = 4


@lru_cache
def _manifest_templates() -> list[dict]:
    if not _MANIFEST.exists():
        return []
    data = yaml.safe_load(_MANIFEST.read_text(encoding="utf-8")) or {}
    out = []
    for t in data.get("templates") or []:
        if not (t.get("id") and t.get("file") and t.get("use")):
            continue
        path = TEMPLATE_DIR / t["file"]
        if not path.exists():
            continue
        out.append({
            "id": t["id"],
            "name": t.get("name") or t["id"],
            "use": t["use"].upper(),
            "style": t.get("style") or [],
            "file": t["file"],
            "path": str(path),
            "preview": t.get("preview"),
            "role_slots_per_page": t.get("role_slots_per_page") or _DEFAULT_SLOTS,
            "role_pages": t.get("role_pages"),
            "source": "builtin",
        })
    return out


def list_templates(uploaded: list[dict] | None = None,
                   use: str | None = None) -> list[dict]:
    """該分會可用的模板：**自己上傳的**（由呼叫端從資料庫取好傳入）+
    **全平台共用的內建模板**。

    內建模板不屬於任何分會（唯讀共用），讓新分會開箱就有骨架可用。
    上傳的模板放在 R2，這裡只看中繼資料；真的要填的時候由呼叫端下載到
    本機再交給 `template_filler`（見 `template_path()`）。
    """
    items = [dict(t, source="upload") for t in (uploaded or [])]
    seen = {t["id"] for t in items}
    items += [t for t in _manifest_templates() if t["id"] not in seen]
    if use:
        items = [t for t in items if t["use"] == use.upper()]
    return items


def resolve_from(items: list[dict], template_id: str | None = None) -> dict | None:
    """**純函式**版本的 resolve：從給定清單挑一個，不碰資料庫。

    renderer 用這個——那一層不該有 DB 存取（T2.1 把 DB 移出 renderers/）。
    """
    if not items:
        return None
    if template_id:
        for t in items:
            if t["id"] == template_id:
                return t
    return items[0]


def template_path(template: dict) -> Path:
    return Path(template.get("path") or (TEMPLATE_DIR / template["file"]))


def ai_choices(items: list[dict]) -> list[dict]:
    """供 Prompt 使用的精簡清單（id + 風格），讓 AI 依主題挑選。

    收的是**已取好的清單**而不是 club_id——`story_builder` 不該碰資料庫。
    """
    return [{"id": t["id"], "name": t["name"], "style": t["style"]} for t in items]
