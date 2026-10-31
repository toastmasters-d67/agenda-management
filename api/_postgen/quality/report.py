"""彙整 QualityReport → complianceNotes（REQ-018）。"""
from api._postgen.quality.base import CheckItem
from api._postgen.schemas.compliance_notes import ComplianceNote


def is_blocked(checks: list[CheckItem]) -> bool:
    return any(c.state == "crit" for c in checks)


def build_compliance_notes(
    input_notes: list[ComplianceNote],
    checks: list[CheckItem],
    llm_notes: list[str],
) -> list[ComplianceNote]:
    notes: list[ComplianceNote] = list(input_notes)
    for c in checks:
        if c.state == "crit":
            notes.append(ComplianceNote(severity="crit", text=f"{c.title} 未過：{c.detail}"))
        elif c.state == "warn":
            notes.append(ComplianceNote(severity="warn", text=f"{c.title}：{c.detail}"))
    for n in llm_notes:
        if n and str(n).strip():
            notes.append(ComplianceNote(severity="info", text=f"LLM 註記：{n}"))
    return notes
