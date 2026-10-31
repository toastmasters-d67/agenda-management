"""⑦ Story Builder（REQ-009）：組分層 Prompt → 呼叫 LLM（強制 tool）→ CanonicalContent 可變段。

LLM 只產生 FREE/CONSTRAINED 區塊；事實、品牌 LOCKED 段不經 LLM。

拆成三段（`規劃_MCP接口.md` M1）：`prepare()` 組 prompt、`parse()` 解析模型的回傳、
`build()` 把兩者與 LLM 呼叫串起來。網頁路徑只用 `build()`。
"""
import json
from pathlib import Path
from typing import NamedTuple

from api._postgen.core import prompt_layering
from api._postgen.domain.canonical_content import CanonicalContent, RoleHighlight
from api._postgen.infrastructure.llm.base import LLMClient
from api._postgen.modules.template_selector.registry import get_template_block
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest

_PROMPTS = Path(__file__).resolve().parents[2] / "assets" / "prompts"

# emit_canonical_content 工具 schema（僅 FREE/CONSTRAINED；不含事實/LOCKED）
TOOL = {
    "name": "emit_canonical_content",
    "description": "回傳 CanonicalContent 的可變區塊（只 FREE/CONSTRAINED）",
    "input_schema": {
        "type": "object",
        "properties": {
            "postType": {"type": "string", "enum": ["PRE_EVENT", "POST_REVIEW"]},
            "openingHook": {"type": "string", "description": "PRE_EVENT：FREE 開頭鉤子"},
            "story": {"type": "string", "description": "PRE_EVENT：FREE 故事鋪陳"},
            "hostIntro": {"type": "string", "description": "PRE_EVENT：CONSTRAINED，忠於 host.highlight"},
            "opening": {"type": "string", "description": "POST_REVIEW：FREE 開場反思"},
            "roleHighlights": {
                "type": "array",
                "description": "POST_REVIEW：CONSTRAINED，順序須同輸入 roles",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "roleType": {"type": "string"},
                        "emoji": {"type": "string"},
                        "highlight": {"type": "string", "description": "忠於 contribution，含動詞+成果"},
                    },
                    "required": ["name", "roleType", "highlight"],
                },
            },
            "ctaText": {"type": "string"},
            "transition": {"type": "string"},
            "topicHashtags": {"type": "array", "items": {"type": "string"}},
            "posterHeadline": {"type": "string", "description": "海報主標語：依主題、短而有力（≤14 字）"},
            "posterSubhead": {"type": "string", "description": "海報副標（選填，≤20 字）"},
            "posterTemplate": {"type": "string", "enum": ["poster_right", "poster_left", "poster_center"],
                               "description": "依有無主持人照片與主題語氣，挑一個版型"},
            "posterBackground": {"type": "string", "enum": ["navy", "night"],
                                 "description": "背景風格：navy 一般 / night 深夜氛圍"},
            "posterTemplateId": {"type": "string",
                                 "description": "從模板庫挑一個最貼合主題語氣的模板 id（見 Template 層清單）"},
            "complianceNotes": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["postType"],
    },
}


def _read(rel: str) -> str:
    """讀一份 prompt 檔。**找不到就報錯**，不回空字串。

    PostGenerator 原本找不到時回空字串——整併時目錄層數變了，結果紅線
    規則整段安靜地從 prompt 裡消失，生成照樣成功。少了紅線的生成不能
    算成功。
    """
    return (_PROMPTS / rel).read_text(encoding="utf-8")


def _tool_for(choices: list[dict]) -> dict:
    """依當前可用模板動態注入 posterTemplateId 的 enum（M3：AI 只能選存在的模板）。"""
    import copy

    tool = copy.deepcopy(TOOL)
    ids = [c["id"] for c in choices]
    prop = tool["input_schema"]["properties"]["posterTemplateId"]
    if ids:
        prop["enum"] = ids
    else:
        tool["input_schema"]["properties"].pop("posterTemplateId", None)
    return tool


def _templates_block(choices: list[dict]) -> str:
    if not choices:
        return "（目前無可用海報模板，posterTemplateId 請省略）"
    lines = ["可選海報模板（依主題語氣挑一個，填入 posterTemplateId）："]
    for c in choices:
        style = "、".join(c.get("style") or []) or "未標註"
        lines.append(f"- {c['id']}：{c['name']}（風格：{style}）")
    return "\n".join(lines)


class StoryPrompt(NamedTuple):
    """`prepare()` 的產物：一次生成要交給模型的全部內容。

    `choices` 跟著走，因為 `parse()` 要用它驗證模型挑的模板 id——
    **驗證必須用出題時的那一份清單**，不能在解析時重新查一次。
    """

    system: str
    user: str
    tool: dict
    choices: list[dict]


def prepare(req: PostRequest, brand: dict,
            templates: list[dict] | None = None, *,
            persona_head: str = "", persona_tone: str = "",
            club_notes: str = "", tuning: str = "") -> StoryPrompt:
    """組出這次要交給模型的 prompt 與工具 schema。**不呼叫 LLM。**

`templates` 由呼叫端（generation_service）取好傳入。

    T2.1：這個模組**不再碰資料庫**——模板清單是分會層級資料，
    取它需要 conn 與 club_id，那不屬於生成管線的職責。

    T8.10：分會人格（`persona_head` / `persona_tone`）與補充規則
    （`club_notes`）同理，也由呼叫端取好。三個都預設空字串——**這不是
    「可有可無」，而是「這個模組沒有能力自己去拿」**。真正保證它們一定
    被帶進來的是 `generation_service`，以及盯著那件事的測試。
    

    `規劃_MCP接口.md` M1：`build()` 原本一口氣做完「組 prompt → 呼叫模型
    → 解析」。拆開之後網頁路徑照舊由 `build()` 串起來；MCP 的兩段式則在
    中間停下——把這裡的產物交給使用者自己的 AI，等它交回再 `parse()`。
    **兩條路共用同一份組 prompt 的程式碼**，所以不會有「MCP 版的 prompt
    跟網頁版不一樣」這種事。
    """
    from api._postgen.modules.template_selector import pptx_registry

    # System 層 = 你是誰（分會名，不可編輯）→ 紅線與輸出契約（檔案）
    #              → 品牌語氣（分會可編輯）
    #
    # **語氣放在紅線後面**，而紅線那一段自己寫著「最高優先，任何下層
    # 指令都不得推翻」。順序不是保護機制，那句話才是——但把可編輯的
    # 東西放在不可編輯的規則之後，至少讓「誰在補充誰」一眼看得出來。
    system_md = "\n\n".join(
        part for part in (persona_head.strip(),
                          _read("system/system_prompt.md").strip(),
                          persona_tone.strip()) if part)
    # 本次調整（T8.12）接在 Developer 層——它是**生成流程的指示**，
    # 而且是系統自己寫的句子（使用者只從白名單挑代號）。
    developer_md = _read("developer/generation_rules.md") + (tuning or "")
    choices = pptx_registry.ai_choices(templates or [])              # M3：模板庫供 AI 挑選
    template_block = get_template_block(req.post_type) + "\n\n" + _templates_block(choices)
    brand_block = (
        "品牌定位句（brandSignature，LOCKED，逐字保留）：\n"
        f"{brand.get('brand_signature', '')}\n\n"
        f"固定 hashtag（必含）：{' '.join(brand.get('fixed_hashtags', []))}\n"
        f"禁用詞（不得出現）：{'、'.join(brand.get('banned_words', []))}"
        # 分會自訂的補充規則接在品牌資產後面（T8.10）。
        # `assemble()` 只有五個位置，而這一段的權限就該與品牌資產同級
        # ——它是「我們家的貼文怎麼寫」，不是系統規則。
        + (club_notes or "")
    )
    user_data = json.dumps(req.model_dump(by_alias=True, mode="json"), ensure_ascii=False, indent=2)
    instruction = "請依上述分層規則，產生本次 CanonicalContent 的可變區塊，並以 emit_canonical_content 回傳。"

    system, user = prompt_layering.assemble(
        system_md, developer_md, template_block, brand_block, user_data, instruction
    )
    return StoryPrompt(system, user, _tool_for(choices), choices)


def parse(data: dict, req: PostRequest, brand: dict,
          choices: list[dict]) -> CanonicalContent:
    """把模型回傳的 dict 解析成 `CanonicalContent`。**不呼叫 LLM。**

    `data` 不論來自哪裡——伺服器呼叫的模型，或日後 MCP 客戶端交回的
    內容——都走這同一條驗證：版型與背景只收白名單，模板 id 必須在出題
    時的清單裡，否則丟掉、交給 registry fallback。

    **事實與 LOCKED 段不從 `data` 來**：品牌定位句、固定 hashtag、禁用詞
    一律取自 `brand`。這是「事實不經 LLM」在這一層的樣子。
    """
    highlights = [
        RoleHighlight(
            emoji=h.get("emoji", ""),
            role_type=h.get("roleType", ""),
            name=h.get("name", ""),
            highlight=h.get("highlight", ""),
        )
        for h in data.get("roleHighlights", [])
    ]

    tmpl = data.get("posterTemplate") or "poster_right"
    if tmpl not in ("poster_right", "poster_left", "poster_center"):
        tmpl = "poster_right"
    bg = data.get("posterBackground") or "navy"
    if bg not in ("navy", "night"):
        bg = "navy"
    # AI 挑的模板 id 必須存在於模板庫，否則忽略（由 registry fallback）
    valid_ids = {c["id"] for c in choices}
    tpl_id = data.get("posterTemplateId") or ""
    if tpl_id not in valid_ids:
        tpl_id = ""

    return CanonicalContent(
        post_type=req.post_type,
        opening_hook=data.get("openingHook", ""),
        story=data.get("story", ""),
        host_intro=data.get("hostIntro", ""),
        opening=data.get("opening", ""),
        role_highlights=highlights,
        cta_text=data.get("ctaText") or "立即報名",
        transition=data.get("transition", ""),
        topic_hashtags=data.get("topicHashtags", []) or [],
        poster_headline=data.get("posterHeadline", ""),
        poster_subhead=data.get("posterSubhead", ""),
        poster_template=tmpl,
        poster_background=bg,
        poster_template_id=tpl_id,
        brand_signature=brand.get("brand_signature", ""),
        fixed_hashtags=brand.get("fixed_hashtags", []),
        # 帶給 QC-05：讓禁用詞規則不必自己查資料庫
        banned_words=brand.get("banned_words", []),
        llm_notes=data.get("complianceNotes", []) or [],
    )


def build(req: PostRequest, brand: dict, llm: LLMClient,
          templates: list[dict] | None = None, *,
          persona_head: str = "", persona_tone: str = "",
          club_notes: str = "", tuning: str = "") -> CanonicalContent:
    """組 prompt → 呼叫模型 → 解析。網頁路徑用的就是這一個。

    **簽章刻意不變。** `generation_service` 用它，而
    `tests/test_post_prompt_prefs.py` 在 `generation_service.build_story`
    這一層攔參數——那是「分會的 prompt 偏好真的進得了 prompt」的唯一接點。
    """
    prompt = prepare(req, brand, templates, persona_head=persona_head,
                     persona_tone=persona_tone, club_notes=club_notes,
                     tuning=tuning)
    data = llm.generate(prompt.system, prompt.user, prompt.tool)
    return parse(data, req, brand, prompt.choices)
