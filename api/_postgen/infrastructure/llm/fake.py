"""假 LLM client：不需金鑰即可測通整條管線（讀 <user_data> 產生示範可變段）。"""
import json
import re


def _pick_template(tool: dict) -> str:
    """從 tool schema 的 enum 挑一個模板 id。

    假 LLM 無語意判斷，固定選**最後一個**——與 registry 的 fallback（第一個）不同，
    便於驗證「AI 挑模板」這條接線真的有作用。
    """
    prop = (tool.get("input_schema", {}).get("properties", {}) or {}).get("posterTemplateId") or {}
    ids = prop.get("enum") or []
    return ids[-1] if ids else ""


def _fake_agenda(text: str) -> dict:
    """假解析器：刻意**天真**——只做 tab 切欄，不做任何過濾。

    這樣「頁尾角色說明表」「報到人員」「同一人多角色」等陷阱都會原樣冒出來，
    真正把關的是服務層（agenda_service）。若這裡先幫忙擋掉，測試就變成自我安慰。
    """
    roles, unresolved, notes = [], [], []
    for line in text.splitlines():
        cols = [c.strip() for c in line.split("	")]
        if len(cols) < 4 or cols[3] in ("", "主持"):
            if "	" in line and len(cols) >= 3 and cols[0] and cols[3:4] == [""]:
                unresolved.append(line.strip())
            continue
        section = cols[2]
        rt = re.match(r"^([^A-Za-z]+)", section)
        role_type = (rt.group(1) if rt else section).strip(" ：:、")
        for name in [n.strip() for n in cols[3].split("/") if n.strip()]:
            roles.append({"name": name, "roleType": role_type,
                          "contribution": section, "sourceLine": line.strip()})

    topic, date = {}, ""
    for line in text.splitlines():
        if line.startswith("會議主題"):
            body = line.split("：", 1)[-1].strip()
            zh, _, en = body.partition(" ")
            topic["titleZh"], topic["titleEn"] = zh, en.strip()
        elif line.startswith("主題題目"):
            topic["questionZh"] = line.split("：", 1)[-1].strip()
    md = re.search(r"(\d{4})/(\d{1,2})/(\d{1,2})", text)
    if md:
        date = f"{md.group(1)}-{int(md.group(2)):02d}-{int(md.group(3)):02d}"
    return {"roles": roles, "topic": topic, "meetingDate": date,
            "unresolved": unresolved, "notes": notes}


def _fake_image_prompt(data: dict) -> dict:
    """假的產圖 Prompt（T6.1）。

    刻意**天真**，與 `_fake_agenda` 同一個原則：把 brief 原樣塞進
    `promptEn`，不做任何過濾。真正的把關在 `image_prompt_service`
    ——這裡先幫忙擋掉的話，那些檢查的測試就變成自我安慰。

    比例固定回 `4:5`。使用者指定的比例在 system prompt 的 template 層，
    假 LLM 看不到——而那**不影響正確性**：服務層本來就會把回來的值
    改成使用者指定的那個（模型不聽話是要處理的情況，不是要相信的前提）。
    刻意讓假 LLM 回一個「不聽話」的值，那條接線才會真的被測到。
    """
    brief = (data.get("brief") or "").strip()
    hints = [h for h in (data.get("styleHints") or []) if h]
    aspect = "4:5"
    return {
        "promptEn": (
            f"{brief} — warm natural light, clean composition, "
            "candid bilingual meetup atmosphere, space for text overlay "
            "（示範文字 · 假 LLM）"
        ).strip(),
        "promptZh": f"依你的需求「{brief}」產生的示範 prompt（假 LLM，未呼叫真實模型）",
        "negativePrompt": "text, watermark, distorted hands, cluttered background",
        "aspectRatio": aspect,
        "styleNotes": hints or ["溫暖自然光", "構圖乾淨、主體明確", "留白供後製加字"],
        "avoidedElements": ["浮水印", "難以辨識的文字"],
    }


class FakeLLMClient:
    def generate(self, system: str, user: str | list[dict], tool: dict) -> dict:
        if isinstance(user, list):
            # 影像／PDF 輸入：假 LLM 看不懂圖，回空草稿（用來驗 verified=False 這條路）
            text = " ".join(b.get("text", "") for b in user if b.get("type") == "text")
            if tool.get("name") == "emit_agenda_draft":
                return {"roles": [], "topic": {}, "meetingDate": "", "unresolved": [],
                        "notes": ["假 LLM 無法讀取影像；請改用文字貼上，或設定真實 API 金鑰"]}
            user = text

        if tool.get("name") == "emit_agenda_draft":
            body = re.search(r"<user_data>\s*(.*?)\s*</user_data>", user, re.S)
            return _fake_agenda(body.group(1) if body else "")

        if tool.get("name") == "emit_image_prompt":
            body = re.search(r"<user_data>\s*(\{.*\})\s*</user_data>", user, re.S)
            return _fake_image_prompt(json.loads(body.group(1)) if body else {})

        m = re.search(r"<user_data>\s*(\{.*\})\s*</user_data>", user, re.S)
        data = json.loads(m.group(1)) if m else {}
        post_type = data.get("postType", "PRE_EVENT")
        template_id = _pick_template(tool)

        if post_type == "POST_REVIEW":
            highlights = [
                {
                    "emoji": r.get("emoji", ""),
                    "roleType": r.get("roleType", ""),
                    "name": r.get("name", ""),
                    "highlight": (r.get("contribution") or "").strip(),
                }
                for r in data.get("roles", [])
            ]
            return {
                "postType": post_type,
                "opening": "每一位上台的人，都曾在心跳加速的那一刻選擇留下來。（示範文字 · 假 LLM）",
                "roleHighlights": highlights,
                "ctaText": "立即報名下一場例會",
                "topicHashtags": [],
                "posterHeadline": "歡樂雙語學習聚會",
                "posterSubhead": "",
                "posterTemplate": "poster_center",
                "posterBackground": "navy",
                "posterTemplateId": template_id,
                "complianceNotes": [],
            }

        host = data.get("host", {}) or {}
        topic = data.get("topic", {}) or {}
        tz = topic.get("title_zh", "")
        return {
            "postType": post_type,
            "openingHook": "有些勇氣很小很小——卻足以改變一切。（示範文字 · 假 LLM）",
            "story": "是明明很緊張，還是走上台講完那三分鐘；是關係卡住時，選擇多說一句真心話。",
            "hostIntro": (
                f"本次特別邀請{host.get('role', '總主持人')} {host.get('name', '')}，"
                "帶大家用中英雙語聊聊這回主題。"
            ).strip(),
            "ctaText": "立即報名",
            "transition": "",
            "topicHashtags": [],
            "posterHeadline": (f"{tz}，就從這一步開始" if tz else "鼓起勇氣，就從這一步開始"),
            "posterSubhead": "",
            "posterTemplate": ("poster_right" if host.get("name") else "poster_center"),
            "posterBackground": "navy",
            "posterTemplateId": template_id,
            "complianceNotes": [],
        }
