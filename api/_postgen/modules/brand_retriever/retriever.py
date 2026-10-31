"""⑤ Brand Knowledge Retriever。

品牌資產由呼叫端（`context.ClubProfile`）從資料庫取好傳入，這裡只挑出管線
要的那幾項——管線層不碰資料庫。
"""


def get_fixed_assets(brand: dict) -> dict:
    """固定品牌資產：定位句（LOCKED）、固定 hashtag、禁用詞、色票。"""
    return {
        "brand_signature": brand.get("brand_signature", ""),
        "fixed_hashtags": brand.get("fixed_hashtags", []),
        "banned_words": brand.get("banned_words", []),
        "colors": brand.get("colors", []),
        "logo_path": brand.get("logo"),
    }
