"""② Post Type Classifier（REQ-004、CL-01）。Demo：明示直讀，不呼叫 LLM。"""
from api._postgen.schemas.enums import PostType
from api._postgen.schemas.post_request import PostRequest


def classify(req: PostRequest) -> PostType:
    return req.post_type
