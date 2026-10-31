"""OpenAI client：與 AnthropicClient 同一個介面（強制 tool use → 回傳工具的 input）。

EntrepreneurAgenda 的使用者可以選 Claude 或 ChatGPT 寫文案；兩家拿到的是
**同一份** system／user／tool schema，回傳同一種 dict，管線不在乎是誰寫的。
"""
import json

from api._postgen.core.exceptions import LLMError
from api._postgen.domain.secret import Secret


class OpenAIClient:
    def __init__(self, api_key: Secret, model: str):
        if not isinstance(api_key, Secret):
            raise TypeError(f"api_key 必須是 Secret，收到 {type(api_key).__name__}。")
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key.reveal())
        self.model = model

    def generate(self, system: str, user, tool: dict) -> dict:
        try:
            resp = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": user}],
                tools=[{"type": "function", "function": {
                    "name": tool["name"], "description": tool.get("description", ""),
                    "parameters": tool["input_schema"]}}],
                tool_choice={"type": "function", "function": {"name": tool["name"]}},
            )
        except Exception as exc:                          # noqa: BLE001
            # 訊息不含 str(exc) 以外的請求內容；OpenAI 的錯誤訊息本身不帶 prompt。
            detail = getattr(exc, "message", None) or exc.__class__.__name__
            raise LLMError(f"OpenAI 產生文案失敗：{detail}"[:300],
                           "請確認金鑰與模型設定，或稍後再試。") from exc
        choice = (resp.choices or [None])[0]
        calls = getattr(getattr(choice, "message", None), "tool_calls", None) or []
        for call in calls:
            if call.function.name == tool["name"]:
                try:
                    return json.loads(call.function.arguments or "{}")
                except ValueError as exc:
                    raise LLMError("OpenAI 回傳的格式無法解析", "請再試一次。") from exc
        if getattr(choice, "finish_reason", "") == "length":
            raise LLMError("回應超過長度上限，結果不完整", "請減少角色數量或分批處理。")
        raise LLMError("OpenAI 未回傳結構化結果", "請重試；持續發生請回報。")
