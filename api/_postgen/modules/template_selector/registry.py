"""③ Template Selector / Registry（REQ-005/013）。

Demo：以程式內建骨架描述（含 mutability），提供給 Prompt 的 Template 層。
key = (postType, platform)；查無回退通用版。
"""
from api._postgen.schemas.enums import PostType

_TEMPLATE_BLOCKS = {
    PostType.PRE_EVENT: (
        "骨架（PRE_EVENT × FACEBOOK）鉤子→內容主體→品牌固定段→CTA+資訊\n"
        "- openingHook   : FREE        （你生成）\n"
        "- story         : FREE        （你生成）\n"
        "- hostIntro     : CONSTRAINED （你生成，忠於 host.highlight，不新增事實）\n"
        "- topicQuestion : DATA_ONLY   （系統填，勿動）\n"
        "- eventDetails  : DATA_ONLY   （系統填，勿動）\n"
        "- cta           : CONSTRAINED （措辭可變，url 鎖定）\n"
        "- brandSignature: LOCKED      （系統填，逐字不可改）"
    ),
    PostType.POST_REVIEW: (
        "骨架（POST_REVIEW × FACEBOOK）標題→#例會tag→開場→逐一角色亮點→品牌固定段→下次例會\n"
        "- opening        : FREE        （你生成，2–4 行）\n"
        "- roleHighlights : CONSTRAINED （你生成，順序同輸入 roles，忠於 contribution、含動詞+成果）\n"
        "- meetingInfo    : DATA_ONLY   （系統填，勿動）\n"
        "- cta            : CONSTRAINED （指向下一場，url 鎖定）\n"
        "- brandSignature : LOCKED      （系統填，逐字不可改）"
    ),
}


def get_template_block(post_type: PostType) -> str:
    return _TEMPLATE_BLOCKS.get(post_type, _TEMPLATE_BLOCKS[PostType.PRE_EVENT])
