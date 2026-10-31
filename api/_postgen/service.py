"""編排層：九模組管線 + Quality Checker retry（搬自 PostGenerator 的 generation_service）。

拆成三段，網頁與 MCP 共用：
    begin()            ①–⑥ 取好這次生成的一切（不呼叫 LLM）
    story_prompt()     交給模型的 prompt（MCP 兩段式交給使用者自己的 AI）
    render_and_check() 套骨架固定句 → render → QC
    finish()           ⑨ 海報計畫 → 合規註記 → 回應

與 PostGenerator 的差別只有資料來源：分會資料來自 `ClubProfile`，不是
`(conn, club_id)`。管線、紅線與 QC 一行沒改。
"""
from __future__ import annotations

from dataclasses import dataclass

from api._postgen import context
from api._postgen.context import ClubProfile, PostLayout
from api._postgen.core.config import Settings
from api._postgen.domain.canonical_content import CanonicalContent
from api._postgen.infrastructure.llm.base import LLMClient
from api._postgen.modules.brand_retriever.retriever import get_fixed_assets
from api._postgen.modules.classifier.type_classifier import classify
from api._postgen.modules.cta_generator.cta_generator import resolve as resolve_cta
from api._postgen.modules.injection.slot_filler import apply_defaults_and_notes
from api._postgen.modules.parser.injection_guard import detect as detect_injection
from api._postgen.modules.story_builder.story_builder import StoryPrompt
from api._postgen.modules.story_builder.story_builder import build as build_story
from api._postgen.modules.story_builder.story_builder import parse as parse_story
from api._postgen.modules.story_builder.story_builder import prepare as prepare_story
from api._postgen.modules.template_selector import pptx_registry
from api._postgen.quality import registry as qc_registry
from api._postgen.quality import report as qc_report
from api._postgen.renderers import facebook as fb_renderer
from api._postgen.renderers import pptx as pptx_renderer
from api._postgen.schemas.compliance_notes import ComplianceNote
from api._postgen.schemas.enums import Platform
from api._postgen.schemas.post_request import PostRequest
from api._postgen.schemas.post_response import GenerateResponse, QcCheck


@dataclass(frozen=True)
class GenerationContext:
    """`begin()` 的產物：一次生成需要的全部輸入。frozen：重試與兩段式都不得偷改它。"""

    req: PostRequest                  # 已判型、已套預設
    input_notes: list[ComplianceNote]
    brand: dict
    templates: list[dict]
    layout: PostLayout
    persona_head: str
    persona_tone: str
    club_notes: str
    tuning: str
    cta_text: str


class GenerationService:
    def __init__(self, llm: LLMClient | None, profile: ClubProfile,
                 key_source: str = "user", model: str = ""):
        self.llm = llm
        self.profile = profile
        self.settings: Settings = profile.settings(model)
        #: 這次用的是誰的金鑰（user／club／server／fake／mcp），只用來說明費用歸屬。
        self.key_source = key_source
        #: 最近一次 `generate()` 採用的那份內容與 context——IG／Threads 版本
        #: 要從**同一份**內容改寫，不能再叫一次模型。
        self.last_ctx: GenerationContext | None = None
        self.last_cc: CanonicalContent | None = None

    def generate(self, req: PostRequest) -> GenerateResponse:
        """網頁路徑：①–⑥ → [ 模型 → 套骨架、render、QC ] × (retry_max+1) → ⑨。"""
        ctx = self.begin(req)
        cc = None
        fb_text = None
        checks: list = []
        for _attempt in range(self.settings.retry_max + 1):
            cc = build_story(ctx.req, ctx.brand, self.llm, ctx.templates,
                             persona_head=ctx.persona_head,
                             persona_tone=ctx.persona_tone,
                             club_notes=ctx.club_notes, tuning=ctx.tuning)
            fb_text, checks = self.render_and_check(ctx, cc)
            if not qc_report.is_blocked(checks):
                break
        self.last_ctx, self.last_cc = ctx, cc
        return self.finish(ctx, cc, fb_text, checks)

    def begin(self, req: PostRequest) -> GenerationContext:
        """①–⑥：把這次生成需要的一切準備好。**不呼叫 LLM。**"""
        p = self.profile
        # ① 消毒 / injection 偵測
        input_notes = [ComplianceNote(severity="info", text=n) for n in detect_injection(req)]
        # ② 判型（明示直讀）
        req.post_type = classify(req)
        # ④ 套分會常態 + input 端 complianceNotes（事實不經 LLM）
        req, default_notes = apply_defaults_and_notes(req, self.settings, p.standing_defaults())
        input_notes += default_notes
        # ⑤ 品牌資產（含禁用詞，會隨 CanonicalContent 帶給 QC-05）
        brand = get_fixed_assets(p.brand())
        templates = pptx_registry.list_templates(list(p.templates), req.post_type.value)
        # ⑥ 分會人格與補充規則、本次調整
        layout = context.layout(p, req.post_type, req.layout)
        input_notes += [ComplianceNote(severity="info", text=n) for n in context.pref_notes(p)]
        cta_text, _ = resolve_cta(req, self.settings, layout.cta_text)
        return GenerationContext(
            req=req, input_notes=input_notes, brand=brand, templates=templates,
            layout=layout, persona_head=context.persona_head(p),
            persona_tone=context.persona_tone(p),
            club_notes=context.notes_block(p, req.post_type),
            tuning=context.tuning_block(p, req.runtime), cta_text=cta_text)

    def story_prompt(self, ctx: GenerationContext) -> StoryPrompt:
        """這次要交給模型的 prompt。與 `generate()` 組的是同一份。"""
        return prepare_story(ctx.req, ctx.brand, ctx.templates,
                             persona_head=ctx.persona_head, persona_tone=ctx.persona_tone,
                             club_notes=ctx.club_notes, tuning=ctx.tuning)

    def parse(self, ctx: GenerationContext, data: dict) -> CanonicalContent:
        """解析模型（或 MCP 客戶端）交回的 dict。驗證用出題時的那一份模板清單。"""
        choices = self.story_prompt(ctx).choices
        return parse_story(data, ctx.req, ctx.brand, choices)

    def render_and_check(self, ctx: GenerationContext,
                         cc: CanonicalContent) -> tuple[str | None, list]:
        """套骨架固定句 → FB render → QC。

        CTA、骨架句、emoji、角色名稱是**程式印出來的字，不是模型產的**，
        不論 `cc` 從哪裡來，這裡都會蓋掉。對同一個 `cc` 呼叫兩次結果相同。
        """
        req, layout = ctx.req, ctx.layout
        cc.cta_text = ctx.cta_text
        cc.club_name = layout.club_name
        cc.title_tagline = layout.title_tagline
        cc.review_headline = layout.review_headline
        cc.org_line = layout.org_line
        cc.info_emoji = layout.info_emoji
        cc.info_emojis = list(layout.info_emojis)
        # 角色名稱是事實。只在同一個位置、姓名逐字相同時換成輸入的值；
        # 對不上的交給 QC-04 擋，不硬套到別人頭上。
        for highlight, role in zip(cc.role_highlights, req.roles):
            if highlight.name.strip() == role.name.strip():
                highlight.role_type = role.role_type
        fb_text = (fb_renderer.render(req, cc, self.settings)
                   if Platform.FACEBOOK in req.platforms else None)
        checks = qc_registry.run_all(req, cc, fb_text or "", self.settings)
        return fb_text, checks

    def finish(self, ctx: GenerationContext, cc: CanonicalContent | None,
               fb_text: str | None, checks: list) -> GenerateResponse:
        """⑨ 海報計畫 → 合規註記 → 回應。不修改 `ctx`，可以重複呼叫。"""
        req = ctx.req
        poster_plan = None
        if Platform.PPTX_POSTER in req.platforms and cc is not None:
            poster_plan = pptx_renderer.build_poster_plan(req, cc, self.settings, ctx.templates)

        blocked = qc_report.is_blocked(checks)
        notes = qc_report.build_compliance_notes(ctx.input_notes, checks,
                                                 cc.llm_notes if cc else [])

        # 定位句是 LOCKED 段，會逐字印在回顧貼文結尾。沒設定時是系統組的一句，
        # 不講的話它會一直被發出去，而它看起來就像有人寫過（T8.13）。
        if self.profile.signature_is_default():
            notes.append(ComplianceNote(
                severity="warn",
                text="本分會尚未設定品牌定位句，貼文結尾目前是系統用分會名自動組的一句話。"
                     "請至「社群發文 → 貼文品牌設定」改成你們自己的一句話。"))
        # 費用歸屬是使用者有權知道的資訊（T5.3），不影響 blocked。
        if self.key_source in ("club", "server"):
            who = "分會共用" if self.key_source == "club" else "系統共用"
            notes.append(ComplianceNote(
                severity="info",
                text=f"本次使用{who}的 AI 金鑰（費用不計入你的帳號）。"))

        # 海報頁數不足而排除角色，是「有人不見了」等級的問題 → crit 並擋下。
        dropped = (poster_plan or {}).get("dropped_roles") or []
        if dropped:
            notes.append(ComplianceNote(
                severity="crit",
                text=(f"海報頁數不足 → {len(dropped)} 位角色未納入：{'、'.join(dropped)}。"
                      "請改用角色頁較多的模板，或分兩篇發布")))
            blocked = True
        for w in (poster_plan or {}).get("warnings") or []:
            notes.append(ComplianceNote(severity="warn", text=w))

        return GenerateResponse(
            post_type=req.post_type.value,
            facebook=fb_text,
            poster_plan=poster_plan,
            compliance_notes=notes,
            qc=[QcCheck(key=c.key, state=c.state, title=c.title, detail=c.detail) for c in checks],
            blocked=blocked,
            # 未提供亮點筆記者，其描述由 AI 依角色職責補寫 → 核可前必須逐一審閱
            ai_written_highlights=[r.name for r in req.roles if not r.contribution.strip()],
            used_model=self.settings.model,
            used_fake=(self.key_source == "fake"),
        )
