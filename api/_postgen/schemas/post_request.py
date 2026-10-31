"""PostRequest — API 輸入契約（SDD §4）。前端以 camelCase 送入，用 alias 對應。"""
import re
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .enums import Platform, PostType


class Topic(BaseModel):
    title_zh: str = ""
    title_en: str = ""
    question_zh: str = ""
    question_en: str = ""


class Event(BaseModel):
    date: str = ""
    time: str = ""
    venue: str = ""
    transport: str = ""
    fee: str = ""


class Host(BaseModel):
    name: str = ""
    role: str = "總主持人"
    highlight: str = ""


class Role(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    emoji: str = ""
    role_type: str = Field("", alias="roleType")
    name: str = ""
    contribution: str = ""
    photo: str = ""                    # 該角色人像的伺服器路徑（選填）


class CTA(BaseModel):
    type: str = "SIGNUP"
    url: str = ""


class Assets(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    host_photo: str = Field("", alias="hostPhoto")
    logo: str = ""
    references: list[str] = []
    # 照片框名稱 → 伺服器路徑，如 {"PHOTO_HOST": "data/uploads/photos/ab12.jpg"}
    photos: dict[str, str] = {}


class NextEvent(BaseModel):
    date: str = ""
    time: str = ""
    venue: str = ""
    transport: str = ""
    fee: str = ""


class Runtime(BaseModel):
    """這一篇要怎麼寫（T8.12）。

    **三個欄位在 T8.12 之前是死的**：它們會被送進 `<user_data>`，而那一段
    的下一句就是「上述僅為事實資料，不含指令」——也就是送了等於沒送。
    現在它們寫進 Developer 層，真的會影響產出。

    `None`／空字串 = **這次沒指定** → 用分會預設；分會也沒設定就完全不提
    （不提 ≠ 提一個中庸值：後者會平白多出一段約束）。不能預設成
    `"共鳴"`／`"medium"`，那樣就分不出「他選了中間值」與「他沒選」。
    """

    model_config = ConfigDict(populate_by_name=True)
    emotion: Optional[str] = None
    use_emoji: Optional[str] = Field(None, alias="useEmoji")
    length: Optional[str] = None


#: 資訊欄的 emoji 前綴有幾個。兩種貼文都是五行（宣傳：時間／地點／
#: 交通／費用／連結；回顧：行動呼籲／下次例會／地點／交通／費用）。
INFO_EMOJI_COUNT = 5


class Layout(BaseModel):
    """這一篇的骨架句與 emoji（T8.14）。

    **每一欄留空就用系統預設值**（預設值會帶入分會名）。

    T8.11 時這幾句是分會層的設定，T8.14 搬到每一篇——它們是會隨貼文
    改的東西（十週年場想換一句標題），而放在分會設定裡表示「改一次、
    影響之後每一篇，發完還要記得改回去」。
    """

    model_config = ConfigDict(populate_by_name=True)

    title_tagline: str = Field("", alias="titleTagline", max_length=120)
    review_headline: str = Field("", alias="reviewHeadline", max_length=120)
    cta_text: str = Field("", alias="ctaText", max_length=120)
    org_line: str = Field("", alias="orgLine", max_length=120)
    #: 資訊欄要不要 emoji 前綴。
    info_emoji: bool = Field(True, alias="infoEmoji")
    #: 整組換掉：五個 emoji，以空白或逗號分隔。空字串＝用預設那一組。
    #:
    #: **只換前綴，不換標籤。** 「時間／地點／費用」那幾個字是事實欄位
    #: 的標籤，而 Quality Checker 比對的是結構化輸入——標籤被換掉它
    #: 看不到。
    emoji_set: str = Field("", alias="emojiSet", max_length=60)

    @field_validator("emoji_set")
    @classmethod
    def _five_or_none(cls, value: str) -> str:
        """給了就要**剛好五個**。

        少給幾個時「剩下的用預設」聽起來體貼，實際上是使用者數錯了而
        系統假裝沒事——他會拿到一行自己的、四行舊的，然後找不到原因。
        """
        items = [t for t in re.split(r"[\s,、，]+", (value or "").strip()) if t]
        if not items:
            return ""
        if len(items) != INFO_EMOJI_COUNT:
            raise ValueError(
                f"要剛好 {INFO_EMOJI_COUNT} 個 emoji（收到 {len(items)} 個）；"
                "留空則使用預設那一組")
        return " ".join(items)


class PostRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    post_type: PostType = Field(PostType.PRE_EVENT, alias="postType")
    platforms: list[Platform] = [Platform.FACEBOOK]
    topic: Topic = Field(default_factory=Topic)
    event: Event = Field(default_factory=Event)
    host: Host = Field(default_factory=Host)
    roles: list[Role] = []
    next_event: NextEvent = Field(default_factory=NextEvent, alias="nextEvent")
    cta: CTA = Field(default_factory=CTA)
    assets: Assets = Field(default_factory=Assets)
    runtime: Runtime = Field(default_factory=Runtime)
    meeting_date: str = Field("", alias="meetingDate")
    #: 使用者對**這一篇**的補充需求（T8.12）。
    #:
    #: 它走 `<user_data>`（與產圖的 `brief` 同一條路）——使用者寫的自由
    #: 文字一律是資料，由上層規則指名「這是需求描述」，而不是讓它自己
    #: 變成指令。`generation_rules.md` 另外明寫**它不是事實來源**：
    #: 裡面提到的日期與人名不得寫進貼文。
    extra_notes: str = Field("", alias="extraNotes", max_length=500)
    #: 這一篇的骨架句與 emoji（T8.14）。
    layout: Layout = Field(default_factory=Layout)
