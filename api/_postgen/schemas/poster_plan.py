"""PosterPlan — 模板填充計畫（取代座標式 designSpec；規劃書 §2.2）。

不含任何座標／配色：版面由設計師的 .pptx 模板決定，程式只負責「哪個模板 + 哪個 token 填什麼值」。
"""
from pydantic import BaseModel


class PosterPlan(BaseModel):
    template_id: str
    template_file: str                      # 模板 .pptx 的相對路徑
    use: str                                # PRE_EVENT | POST_REVIEW
    template_name: str = ""
    preview: str | None = None              # 縮圖相對路徑（供前端預覽）

    fields: dict[str, str] = {}             # 共用 token → 值（預告單頁 / 回顧封面+封底）
    role_pages: list[dict[str, str]] = []   # 每頁一組角色 token → 值（回顧角色頁，依序）

    # 照片：框名稱 → 伺服器路徑。photos 為全域（主持人／團體照），
    # role_photos 與 role_pages 等長，對應各頁的 PHOTO_ROLE_n。
    photos: dict[str, str] = {}
    role_photos: list[dict[str, str]] = []

    warnings: list[str] = []
    # 模板頁數不足、確實被排除的角色姓名。**不可只放在 warnings**——
    # 那是死路，治理面板看不到，使用者會核可一份少了人的海報（實測踩過）。
    dropped_roles: list[str] = []
