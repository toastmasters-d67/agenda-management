"""CanonicalContent — 平台中立內容核心（REQ-043）。

只承載「可由 LLM 生成的可變段」（FREE/CONSTRAINED）+ 品牌鎖定段（LOCKED）。
事實（DATA_ONLY：日期/地點/連結/人名）不放這裡，由 renderer 直接引用 PostRequest，
以結構落實「事實不經 LLM 記憶」（REQ-046）。
"""
from pydantic import BaseModel

from api._postgen.schemas.enums import PostType


class RoleHighlight(BaseModel):
    emoji: str = ""
    role_type: str = ""
    name: str = ""
    highlight: str = ""


class CanonicalContent(BaseModel):
    post_type: PostType

    # 可變層（由 Story Builder / LLM 生成）
    opening_hook: str = ""     # PRE_EVENT
    story: str = ""            # PRE_EVENT
    host_intro: str = ""       # PRE_EVENT（CONSTRAINED，忠於 host.highlight）
    opening: str = ""          # POST_REVIEW 開場反思
    role_highlights: list[RoleHighlight] = []   # POST_REVIEW（CONSTRAINED，順序同輸入）
    cta_text: str = "立即報名"
    transition: str = ""
    topic_hashtags: list[str] = []

    # 海報專用（AI 生成／挑選）
    poster_headline: str = ""          # AI 依主題寫的海報主標語
    poster_subhead: str = ""           # 選填副標
    poster_template: str = "poster_right"   # 舊：程式繪製時的版型（保留相容）
    poster_background: str = "navy"    # 舊：程式繪製時的背景風格
    poster_template_id: str = ""       # 新：AI 從模板庫挑選的模板 id（M3）

    # 骨架固定句（T8.11）：**renderer 直接印出來的字，不是 LLM 產的。**
    #
    # 放在這裡而不是讓 renderer 自己去查，理由與 `banned_words` 相同：
    # renderer 碰資料庫就得收 conn 與 club_id，而它是純函式。
    club_name: str = ""             # 這個分會的名字（**不再寫死**）
    title_tagline: str = ""         # 宣傳貼文標題後面那句
    review_headline: str = ""       # 回顧貼文第一行
    org_line: str = ""              # 海報頁尾署名
    info_emoji: bool = True         # 資訊欄要不要 emoji 前綴
    #: 資訊欄那五行的前綴，**順序就是印出來的順序**（T8.14）。
    #: 空的時候 renderer 用自己的預設，所以直接建構 `CanonicalContent`
    #: 的舊程式與測試不會少掉 emoji。
    info_emojis: list[str] = []

    # 品牌鎖定層（LOCKED，來自知識庫、非 LLM）
    brand_signature: str = ""
    # T2.1：禁用詞隨內容一起帶下去，讓 QC 規則不必自己查資料庫。
    # 規則層碰 DB 會讓它需要 conn 與 club_id，介面就得跟著改——
    # 那是規劃書列為「保留不動」的治理層。
    banned_words: list[str] = []
    fixed_hashtags: list[str] = []

    # LLM 自報的治理註記
    llm_notes: list[str] = []
