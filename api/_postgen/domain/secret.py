"""不會誤入日誌的秘密字串（T5.1）。

為什麼需要一個型別
------------------
使用者的 API Key 在程式裡是一個 `str`，而 `str` 會在**很多不明顯的地方**
把自己印出來：例外的 `repr`、`logging` 的 `%s`、pytest 失敗時的 assert 訊息、
`json.dumps`、`pickle`、除錯用的 `print`。這些路徑沒有一條是「有人故意
把金鑰寫進日誌」，全都是順手寫下的一行造成的。

`Secret` 的作法是**讓那些路徑全部得不到明文**：取明文只有 `reveal()`
一條路，那個名字在 code review 時看得見。

刻意做的事，以及為什麼
----------------------
- **不繼承 `str`。** 繼承的話 `secret[0:8]`、`"".join([secret])`、
  `secret.upper()`、`f"{secret}"` 全都會洩漏，而且沒有辦法一一擋掉。
- **不可雜湊**（定義了 `__eq__` 就沒有 `__hash__`）。這是刻意的副作用：
  `Secret` 進不了 `set`、當不了 dict 的鍵、`functools.lru_cache` 也快取不了它。
  規劃書 §T5.2 要求「`get_credential` 的回傳值不得被快取到模組層變數」——
  型別本身擋掉一種最容易發生的意外快取。
- **不可 pickle / deepcopy。** `pickle.dumps(secret)` 會把明文寫進位元組流
  （多行程、快取層、session 序列化都會用到它）。這裡直接讓它拋錯。
- **`__eq__` 用 `hmac.compare_digest`**，而且**只跟另一個 `Secret` 比**。
  跟 `str` 比一律回 `NotImplemented`（結果是 False）——這樣
  `if secret == "sk-ant-…"` 不會因為時間差洩漏前綴，也不會有人誤以為
  可以拿它當字串用。

這一層不是唯一的防線：`app/core/logging.py` 的 redaction filter 是第二層。
兩層防的是不同的東西——這裡防「秘密被格式化成字串」，那裡防
「已經是字串的秘密被寫出去」。
"""
from __future__ import annotations

import hmac
from typing import Any, NoReturn

__all__ = ["Secret"]

MASK = "***"


class Secret:
    """包住一個明文秘密。取值只有 `reveal()` 一條路。"""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        if not isinstance(value, str):
            # 不把 value 放進訊息裡——它可能就是秘密本身。
            raise TypeError(f"Secret 只接受 str，收到 {type(value).__name__}")
        self._value = value

    # ── 取值 ─────────────────────────────────────────────────────
    def reveal(self) -> str:
        """取出明文。**呼叫點應該少到可以一眼看完。**"""
        return self._value

    def __bool__(self) -> bool:
        """空秘密是 falsy。這不算洩漏——長度是否為 0 不是秘密。"""
        return bool(self._value)

    def __len__(self) -> int:
        """長度不是秘密，而且驗證輸入時會用到（例如「金鑰太短」）。"""
        return len(self._value)

    def last4(self) -> str:
        """末四碼，供介面顯示「sk-…abcd」。太短就整串遮掉。"""
        return self._value[-4:] if len(self._value) >= 8 else ""

    # ── 所有轉字串的路徑都回遮罩 ─────────────────────────────────
    def __repr__(self) -> str:
        return MASK

    def __str__(self) -> str:
        return MASK

    def __format__(self, spec: str) -> str:
        """f-string 與 `format()`。

        **忽略格式規格**是刻意的：`f"{secret:.8}"` 若照規格走，
        會把遮罩截成 `***`……看起來沒事，但 `f"{secret:>40}"` 這種
        也會讓人以為格式有效。一律回原樣的遮罩，行為單一。
        """
        return MASK

    # ── 序列化：全部拒絕 ─────────────────────────────────────────
    def __reduce__(self) -> NoReturn:
        raise TypeError("Secret 不可序列化（pickle 會把明文寫進位元組流）")

    def __copy__(self) -> NoReturn:
        raise TypeError("Secret 不可複製——需要的話請明確地重新建立")

    def __deepcopy__(self, memo: dict) -> NoReturn:
        raise TypeError("Secret 不可複製——需要的話請明確地重新建立")

    # ── 比較 ─────────────────────────────────────────────────────
    def __eq__(self, other: Any) -> Any:
        if isinstance(other, Secret):
            return hmac.compare_digest(self._value, other._value)
        # **不跟 str 比。** 回 NotImplemented 讓 Python 得到 False，
        # 而不是做一次會洩漏前綴長度的逐字元比較。
        return NotImplemented

    # `__eq__` 一旦定義，`__hash__` 就會變成 None（不可雜湊）。
    # 這正是我們要的，見模組說明。這一行只是把它寫出來，
    # 免得日後有人「順手補一個 __hash__」而不知道那會拿掉一層保護。
    __hash__ = None                                    # type: ignore[assignment]
