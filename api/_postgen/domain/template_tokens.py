"""模板 token 契約 — 單一事實來源。

檢查工具（tools/check_template）、模板填充引擎、模板上傳驗證關卡共用此定義，
避免三處各自維護造成不一致（比照 domain/fact_whitelist.py 的做法）。
"""
import re

TOKEN_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")

ROLE_SLOTS_PER_PAGE = 4

# ── 預告海報（單頁）────────────────────────────────────────────────
PRE_EVENT_REQUIRED = {
    "HEADLINE", "THEME", "QUESTION_ZH",
    "DATE", "TIME", "VENUE", "FEE", "REGISTER_URL",
}
PRE_EVENT_OPTIONAL = {"QUESTION_EN", "TRANSPORT", "HOST_NAME"}
PRE_EVENT_PHOTOS = {"PHOTO_HOST"}

# ── 回顧（封面 / 角色頁 / 封底）─────────────────────────────────────
RECAP_COVER_REQUIRED = {"HEADLINE", "MEETING_DATE", "THEME"}
RECAP_COVER_OPTIONAL = {"QUESTION_ZH", "QUESTION_EN"}

RECAP_ROLE_REQUIRED = {"GROUP_TITLE", "ROLE_1_HEAD", "ROLE_1_BODY"}
RECAP_ROLE_OPTIONAL = {
    f"ROLE_{i}_{part}"
    for i in range(2, ROLE_SLOTS_PER_PAGE + 1)
    for part in ("HEAD", "BODY")
}

RECAP_CLOSING_REQUIRED = {
    "NEXT_DATE", "NEXT_TIME", "NEXT_VENUE", "NEXT_FEE",
    "REGISTER_URL", "BRAND_SIGNATURE",
}
RECAP_CLOSING_OPTIONAL = {"NEXT_TRANSPORT", "THEME"}

RECAP_PHOTOS = {"PHOTO_GROUP"} | {f"PHOTO_ROLE_{i}" for i in range(1, ROLE_SLOTS_PER_PAGE + 1)}

# 事實類 token（缺值填 [需由使用者提供]，不得由 AI 補完；REQ-003/034）
FACT_TOKENS = {
    "THEME", "QUESTION_ZH", "QUESTION_EN", "HOST_NAME",
    "DATE", "TIME", "VENUE", "TRANSPORT", "FEE", "REGISTER_URL",
    "MEETING_DATE",
    "NEXT_DATE", "NEXT_TIME", "NEXT_VENUE", "NEXT_TRANSPORT", "NEXT_FEE",
}
# 品牌鎖定 token（逐字帶入知識庫內容，不可改寫；REQ-023）
LOCKED_TOKENS = {"BRAND_SIGNATURE"}

ALL_KNOWN = (
    PRE_EVENT_REQUIRED | PRE_EVENT_OPTIONAL
    | RECAP_COVER_REQUIRED | RECAP_COVER_OPTIONAL
    | RECAP_ROLE_REQUIRED | RECAP_ROLE_OPTIONAL
    | RECAP_CLOSING_REQUIRED | RECAP_CLOSING_OPTIONAL
)
ALL_PHOTOS = PRE_EVENT_PHOTOS | RECAP_PHOTOS


def find_tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text or "")
