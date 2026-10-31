"""④ Variable Injection（REQ-006/002/003、S5 REQ-056/057）。

事實不經 LLM：這裡只對 PostRequest 補**分會常態**並標記缺漏，
renderer 之後直接引用這些事實字串。

兩條約束（規劃書 §0）：
- **已填不覆蓋**：只填空白欄位，永不覆寫使用者輸入。
- **自動值必留痕**：每個被填入的值都產生一則 complianceNote。

下次例會日期是**推算**出來的，故用 `warn` 而非 `info`——地點費用寫錯讀者看得出來，
日期寫錯讀者會白跑一趟，而週期規則無從得知調期與國定假日順延（§2.4）。
"""
from api._postgen.core.config import Settings
from api._postgen.domain import fact_whitelist, meeting_schedule
from api._postgen.schemas.compliance_notes import ComplianceNote
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest


def _apply(target, attr: str, value, label: str, notes: list[ComplianceNote]) -> None:
    """空白才填，並留下痕跡（約束 A、B）。"""
    current = getattr(target, attr, "") or ""
    text = str(value or "").strip()
    if current.strip() or not text:
        return
    setattr(target, attr, text)
    notes.append(ComplianceNote(
        severity="info", text=f"{label}未填 → 套用分會常態「{text}」（S5）"))


def apply_defaults_and_notes(
    req: PostRequest, settings: Settings, club: dict | None = None
) -> tuple[PostRequest, list[ComplianceNote]]:
    req = req.model_copy(deep=True)
    notes: list[ComplianceNote] = []
    # T2.1：分會常態由呼叫端（generation_service）取好傳入。
    # 這個模組**不再碰資料庫**——管線層拿到的應該是純資料。
    club = club or {}

    time_default = club.get("meeting_time") or settings.default_time
    url_default = club.get("register_url") or settings.fixed_register_url

    if req.post_type == PostType.PRE_EVENT:
        _apply(req.event, "time", time_default, "時間", notes)
        _apply(req.event, "venue", club.get("venue"), "地點", notes)
        _apply(req.event, "transport", club.get("transport"), "交通", notes)
        _apply(req.event, "fee", club.get("fee"), "費用", notes)
    else:
        _apply(req.next_event, "time", time_default, "下次時間", notes)
        _apply(req.next_event, "venue", club.get("venue"), "下次地點", notes)
        _apply(req.next_event, "transport", club.get("transport"), "下次交通", notes)
        _apply(req.next_event, "fee", club.get("fee"), "下次費用", notes)
        _infer_next_date(req, club, notes)

    # 報名連結預設（CTA-02）。選填：分會沒設定就不填，也不留「套用」的紀錄。
    if not req.cta.url.strip() and url_default:
        req.cta.url = url_default
        notes.append(ComplianceNote(severity="info", text="報名連結未填 → 套用分會的報名連結（CTA-02）"))

    # 缺漏必填事實（REQ-003：標記不補完）——在套完常態之後才判定
    for label in fact_whitelist.find_missing(req):
        notes.append(ComplianceNote(severity="crit", text=f"事實欄位「{label}」缺漏 → 標記 [需由使用者提供]，不補完（REQ-003）"))

    # 選填缺漏（省略不杜撰）
    if req.post_type == PostType.PRE_EVENT and not req.host.highlight.strip():
        notes.append(ComplianceNote(severity="info", text="主持人特色未填 → 省略該句、不杜撰（IN-05）"))
    if req.post_type == PostType.POST_REVIEW:
        no_name = sum(1 for r in req.roles if not r.name.strip())
        if no_name:
            notes.append(ComplianceNote(severity="crit", text=f"有 {no_name} 位角色缺姓名 → 角色逐字比對失敗（QC-04）"))
        # 治理決策：允許 AI 依角色職責補寫描述，但**註記必須說實話**。
        # 舊寫法宣稱「省略不杜撰」，實際卻補完了——信任那行字的人就不會去查那幾行。
        no_contrib = [r.name or "（未具名）" for r in req.roles if not r.contribution.strip()]
        if no_contrib:
            notes.append(ComplianceNote(
                severity="warn",
                text=(f"有 {len(no_contrib)} 位角色未提供亮點筆記 → 描述由 AI 依「角色職責」補寫，"
                      f"（非本人實際表現），請在核可前逐一審閱："
                      + "、".join(no_contrib)),
            ))

    return req, notes


def _infer_next_date(req: PostRequest, club: dict, notes: list[ComplianceNote]) -> None:
    """由本次例會日與週期規則推下次例會日（REQ-057）。

    規則未設定或無解 → 不填，交給 find_missing 照常標記缺漏（不猜）。
    """
    if req.next_event.date.strip():
        return                                  # 已填不覆蓋
    base = meeting_schedule.parse_date(req.meeting_date)
    if base is None:
        return
    cadence = club.get("cadence")
    nxt = meeting_schedule.next_meeting_date(base, cadence)
    if not nxt:
        return
    req.next_event.date = nxt.isoformat()
    notes.append(ComplianceNote(
        severity="warn",
        text=(f"下次例會日期未填 → 依週期規則（{meeting_schedule.describe(cadence)}）"
              f"推算為 {nxt.isoformat()}，請務必核對是否調期（S5）"),
    ))
