"""① 輸入消毒 / Prompt Injection 偵測（REQ-022、IN-04）。"""
from api._postgen.schemas.post_request import PostRequest

INJECTION_PATTERNS = [
    "忽略上述", "忽略以上", "忽略前面", "改用以下", "disregard", "ignore previous",
    "ignore above", "system prompt", "you are now",
]


def _free_texts(req: PostRequest) -> list[str]:
    # **新增自由文字欄位時一定要加進這份清單。** 漏了的症狀是那一欄
    # 完全不經越權偵測，而畫面上什麼都看不出來——有一條測試盯著
    # `extra_notes`（T8.12 加的那一欄）真的會被掃到。
    texts = [req.host.highlight, req.topic.title_zh, req.topic.title_en,
             req.extra_notes]
    texts += [r.contribution for r in req.roles]
    return [t for t in texts if t]


def detect_text(text: str) -> list[str]:
    """對**單一段自由文字**偵測越權字串（T6.1 抽出）。

    抽出來的理由：產圖的 brief 也是使用者輸入的自由文字，一樣要過這一關，
    但它不是 `PostRequest`。原本要嘛複製一份圖樣清單（兩份會漂掉），
    要嘛硬湊一個假的 `PostRequest` 只為了呼叫 `detect()`——兩個都比
    多一個函式差。

    `detect()` 現在也走這裡，所以兩條路徑用的**一定**是同一份清單。
    """
    if not text:
        return []
    low = text.lower()
    for pat in INJECTION_PATTERNS:
        if pat.lower() in low:
            return [f"偵測到疑似越權字串「{pat}」→ 已忽略，僅作資料處理（REQ-022）"]
    return []


def detect(req: PostRequest) -> list[str]:
    """回傳偵測到的越權字串註記（不改資料，僅記入 complianceNotes）。"""
    notes = []
    for text in _free_texts(req):
        notes.extend(detect_text(text))
    return notes
