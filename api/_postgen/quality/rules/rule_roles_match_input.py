"""QC-04：回顧文角色齊全且姓名逐字比對輸入（順序一致）。"""
from api._postgen.quality.base import CheckItem
from api._postgen.schemas.enums import PostType


def check(req, cc, fb_text, settings) -> CheckItem:
    if req.post_type != PostType.POST_REVIEW:
        return CheckItem("roles", "ok", "角色逐字比對（QC-04）", "非回顧文，略過")

    input_names = [r.name.strip() for r in req.roles]
    output_names = [h.name.strip() for h in cc.role_highlights]
    if any(not n for n in input_names):
        return CheckItem("roles", "crit", "角色逐字比對（QC-04）", "有角色缺姓名")
    if input_names != output_names:
        return CheckItem("roles", "crit", "角色逐字比對（QC-04）",
                         f"角色名單／順序不一致：輸入{input_names} vs 產出{output_names}")
    return CheckItem("roles", "ok", "角色逐字比對（QC-04）", f"{len(input_names)} 位角色與輸入一致")
