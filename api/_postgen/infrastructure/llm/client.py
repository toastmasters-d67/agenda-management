"""Anthropic Claude client（真實呼叫）。

金鑰只在後端。**T5.3 起金鑰型別是 `Secret`**，而且是每位使用者自己的
（`api_key_service.get_credential`），不再是全站共用的 `.env` 那一把。

失敗一律轉成 LLMError（帶可行動的提示），避免把 SDK 例外與堆疊直接拋到 API 層。
"""
import logging

import anthropic
from anthropic import Anthropic

from api._postgen.core.exceptions import LLMError
from api._postgen.domain.secret import Secret

logger = logging.getLogger(__name__)

#: Anthropic 錯誤原文最多轉出幾個字。那一句通常很短；上限擋的是意外。
API_DETAIL_MAX = 200


def _api_detail(exc: Exception) -> str:
    """Anthropic 自己寫在錯誤回應裡的那一句（`body["error"]["message"]`）。

    **只用在 403。** 同一個帳號在 Anthropic 網站上正常、從伺服器呼叫卻被拒
    的時候，真正的原因（地區限制、身分驗證、工作區設定…）只寫在這一句裡；
    少了它，提示只能猜——2026-10-24 提示說「帳號未開通該模型」，而帳號在網站上
    完全正常，最可能的原因是伺服器所在地區（香港）。

    取的是回應 body 的那一個欄位，**不是 `str(exc)`**——後者是 SDK 組的
    字串，可能帶著請求內容，而請求裡有使用者的文案。
    """
    body = getattr(exc, "body", None)
    err = body.get("error") if isinstance(body, dict) else None
    msg = err.get("message") if isinstance(err, dict) else None
    if not isinstance(msg, str):
        return ""
    return " ".join(msg.split())[:API_DETAIL_MAX]


# ── SDK 例外 → LLMError 的對映（8 條）──────────────────────────────
#
# **抽成函式是為了讓 `generate()` 與 `ping()` 共用同一組訊息。**
# 「驗證金鑰」與「生成失敗」的原因是同一組（金鑰無效、無權限、額度、
# 逾時、連線…），訊息也該是同一組——為 `ping()` 再寫一份，兩邊就會漂移，
# 而使用者會在兩個地方看到對同一件事的不同說法。
#
# T5.3 起 hint 的措辭改了：金鑰不再來自 `.env`，而是使用者自己在
# 「我的 API Key」設定的。叫使用者去改 `.env` 是**錯的指示**——
# 他沒有主機存取權。
def _as_llm_error(exc: Exception, model: str) -> LLMError:
    if isinstance(exc, LLMError):
        return exc
    if isinstance(exc, anthropic.AuthenticationError):
        return LLMError(
            "Claude API 金鑰無效或已失效",
            "請至右上『我的 API Key』重新輸入 Anthropic 金鑰。")
    if isinstance(exc, anthropic.PermissionDeniedError):
        detail = _api_detail(exc)
        if not detail:
            return LLMError(
                "此金鑰無權使用模型 " + model,
                "請確認你的 Anthropic 帳號已開通該模型。")
        # 伺服器日誌也記一份：使用者截圖時常常只截到標題那一行。
        logger.warning("Anthropic 拒絕呼叫（403）：%s", detail)
        return LLMError(
            "此金鑰無權使用模型 " + model,
            f"Anthropic 的回覆：「{detail}」。若同一個帳號在 Anthropic 網站上"
            "可以正常使用，原因多半在伺服器端，請把這段訊息提供給管理員。")
    if isinstance(exc, anthropic.NotFoundError):
        return LLMError("找不到模型 " + model, "請聯絡管理員檢查模型設定。")
    if isinstance(exc, anthropic.RateLimitError):
        return LLMError("已達 Claude API 速率或額度上限",
                        "請稍候再試，或檢查你的 Anthropic 帳戶額度。")
    if isinstance(exc, anthropic.APITimeoutError):
        return LLMError("呼叫 Claude API 逾時", "請稍後重試；角色很多時可分次生成。")
    if isinstance(exc, anthropic.APIConnectionError):
        return LLMError("無法連線至 Claude API", "請檢查網路或代理設定。")
    if isinstance(exc, anthropic.APIStatusError):
        return LLMError(
            "Claude API 回應錯誤（HTTP " + str(exc.status_code) + "）",
            "請稍後重試；持續失敗請檢查金鑰與模型設定。")
    # 非預期例外。**訊息不含 str(exc)** ——SDK 的例外訊息可能帶著
    # 請求內容，而請求裡有使用者的文案。
    return LLMError("呼叫 Claude API 時發生未預期的錯誤",
                    "請稍後重試；持續發生請回報。")


class AnthropicClient:
    def __init__(self, api_key: Secret, model: str, max_tokens: int,
                 temperature: float = 0.0):
        """`api_key` 必須是 `Secret`。

        **明文只在這一行存在。** `reveal()` 的結果直接交給 SDK，
        不存成 instance 屬性——`self.api_key = …` 會讓金鑰出現在
        除錯器、`vars(client)`、以及任何把物件序列化的地方。

        SDK 自己會把它留在 `self._client.api_key`，那是無法避免的；
        能控制的是**我們的**物件上沒有那個欄位。
        """
        if not isinstance(api_key, Secret):
            # 型別錯誤時**不回吐值**——它可能就是金鑰。
            raise TypeError(
                f"api_key 必須是 Secret，收到 {type(api_key).__name__}。"
                "請用 api_key_service.get_credential() 取得。")
        self._client = Anthropic(api_key=api_key.reveal())
        self.model = model
        self.max_tokens = max_tokens
        # Claude 5 系列已淘汰 temperature 參數（送出會回 400），故不傳遞。
        self.temperature = temperature

    def ping(self) -> str:
        """最小可能的呼叫，只為確認金鑰可用（T5.3 的 `/keys/{p}/test`）。

        `max_tokens=1` 讓費用趨近於零，但**仍然是一次真實的計費呼叫**——
        這就是那個端點需要速率限制的原因（§12.4）。

        沿用 `generate()` 已有的 8 條例外對映：驗證金鑰與生成失敗的
        原因是同一組，訊息也該是同一組，不該為了這裡再寫一份。
        """
        try:
            self._client.messages.create(
                model=self.model, max_tokens=1,
                messages=[{"role": "user", "content": "hi"}])
        except Exception as exc:                          # noqa: BLE001
            raise _as_llm_error(exc, self.model) from exc
        return self.model

    def generate(self, system: str, user: str | list[dict], tool: dict) -> dict:
        # user 可為字串或 content block 陣列（影像／PDF）；Messages API 兩者皆收，此處純傳遞。
        try:
            resp = self._client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                tools=[tool],
                tool_choice={"type": "tool", "name": tool["name"]},
            )
        except Exception as exc:                          # noqa: BLE001
            raise _as_llm_error(exc, self.model) from exc

        # 撞到 max_tokens 時，SDK 會回傳**半截的 tool input**——缺漏的欄位直接消失，
        # 看起來像「模型什麼都沒找到」。這種靜默截斷比報錯危險得多，必須擋下。
        if resp.stop_reason == "max_tokens":
            raise LLMError(
                f"回應超過長度上限（MAX_TOKENS={self.max_tokens}），結果不完整",
                "請在 .env 調高 MAX_TOKENS（角色多的議程或回顧建議 8000 以上），或分批處理。",
            )

        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                return dict(block.input)
        raise LLMError("Claude 未回傳結構化結果", "請重試；持續發生請回報以調整 prompt。")
