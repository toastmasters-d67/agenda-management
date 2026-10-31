"""跨層共用列舉（開放擴充，REQ-042/049）。"""
from enum import Enum


class PostType(str, Enum):
    PRE_EVENT = "PRE_EVENT"
    POST_REVIEW = "POST_REVIEW"


class Platform(str, Enum):
    FACEBOOK = "FACEBOOK"
    PPTX_POSTER = "PPTX_POSTER"      # REQ-049：PPTX renderer 平台


class PostStatus(str, Enum):
    """Human Review 狀態（OPS-03）。"""
    DRAFT = "DRAFT"
    QC_PASSED = "QC_PASSED"
    IN_REVIEW = "IN_REVIEW"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class Mutability(str, Enum):
    LOCKED = "LOCKED"
    DATA_ONLY = "DATA_ONLY"
    CONSTRAINED = "CONSTRAINED"
    FREE = "FREE"
