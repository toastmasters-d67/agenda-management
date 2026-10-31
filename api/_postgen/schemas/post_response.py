"""GenerateResponse — /generate 的回應契約（對應 §5 Output + complianceNotes）。"""
from typing import Optional

from pydantic import BaseModel

from .compliance_notes import ComplianceNote


class QcCheck(BaseModel):
    key: str
    state: str        # ok | warn | crit
    title: str
    detail: str = ""


class GenerateResponse(BaseModel):
    post_type: str
    facebook: Optional[str] = None          # FB renderer 輸出（純文字）
    design_spec: Optional[dict] = None      # 舊：程式繪製的座標指令（保留相容）
    poster_plan: Optional[dict] = None      # M1：模板填充計畫（template_id + token 值）
    compliance_notes: list[ComplianceNote] = []
    qc: list[QcCheck] = []
    blocked: bool = False                   # 有紅線未過 → 前端擋下載
    # 未提供亮點筆記、描述由 AI 依角色職責補寫的角色姓名。
    # 這些句子沒有事實依據，核可前必須逐一審閱（治理決策：允許補寫，但要看得見）。
    ai_written_highlights: list[str] = []
    project_id: Optional[int] = None    # S4：對應的歷史專案
    used_model: str
    used_fake: bool
