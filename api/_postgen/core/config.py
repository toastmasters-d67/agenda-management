"""引擎的執行設定。

在 PostGenerator 裡這是讀 `.env` 的全站設定；搬進 EntrepreneurAgenda 之後，
**每次生成依分會組一份**（`api/_postgen/context.py` 的 `ClubProfile.settings()`）：
預設時間與報名連結是分會的事實，不是伺服器的——原本的預設值寫死著
Chill Hi High 的時間與報名表單，放在多分會系統裡會印到別的分會的貼文上。
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    #: 例會時間沒填時的後援（分會設定的例會時間）。空字串 = 照樣標成缺漏。
    default_time: str = ""
    #: 報名連結沒填時的後援（分會設定的報名連結）。
    fixed_register_url: str = ""
    #: Quality Checker 擋下後，額外重生幾次。
    retry_max: int = 1
    #: 這次用的模型（回報用）。
    model: str = ""
