"""MCP tools added with the PostGenerator merge, against a throwaway database.

Handlers are called the way the MCP endpoint calls them: (caller, args).
"""
import base64
import io
import json
import os
import uuid
import zipfile

import pytest

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"),
                                reason="TEST_DATABASE_URL not set")


@pytest.fixture(scope="module")
def index():
    import api.index as index
    return index


@pytest.fixture()
def env(index):
    tag = uuid.uuid4().hex[:8]
    with index.get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO clubs (name, name_zh, fee, settings) VALUES (%s,%s,'NTD150',%s::jsonb)"
                        " RETURNING id", (f"MCP {tag}", f"MCP 分會{tag}",
                                         json.dumps({"venue": "會議室", "timeRange": "19:00 ~ 21:00"})))
            cid = cur.fetchone()[0]
            cur.execute("INSERT INTO users (username, password_hash, role, club_id, status)"
                        " VALUES (%s,'x','club_admin',%s,'active')", (f"off_{tag}", cid))
            cur.execute("INSERT INTO agendas (username, data, meeting_date, club_id) VALUES (%s,%s::jsonb,%s,%s)"
                        " RETURNING id", (f"off_{tag}", json.dumps({
                            "meetingDate": "2026-12-01", "meetingTheme": "希望 Hope", "tme": "Amy",
                            "timer": "Ben", "speeches": [{"speaker": "Cat"}], "evaluators": ["Dan"]}),
                                          "2026-12-01", cid))
            aid = cur.fetchone()[0]
            cur.execute("INSERT INTO club_post_prefs (club_id, prefs) VALUES (%s, %s::jsonb)",
                        (cid, json.dumps({"register_url": "https://example.org/r"})))
    officer = {"username": f"off_{tag}", "role": "club_admin", "club_id": cid, "memberships": {}}
    admin = {"username": "sysadmin_test", "role": "system_admin", "club_id": cid, "memberships": {}}
    yield {"cid": cid, "aid": aid, "officer": officer, "admin": admin}
    with index.get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM clubs WHERE id=%s", (cid,))
            cur.execute("DELETE FROM users WHERE username=%s", (f"off_{tag}",))


def call(index, name, caller, args):
    tool = next(t for t in index.MCP_TOOLS if t["name"] == name)
    return tool["handler"](caller, args)


def test_new_tools_are_registered_with_valid_scopes(index):
    names = {t["name"] for t in index.MCP_TOOLS}
    for n in ("start_post", "submit_post", "get_post_prefs", "update_post_prefs", "list_post_templates",
              "make_post_poster", "set_word_template", "set_custom_roles", "list_machines",
              "pair_machine", "update_machine"):
        assert n in names
    assert all(t["scope"] in (None, *index.MCP_SCOPES) for t in index.MCP_TOOLS)


def test_two_stage_post_with_the_callers_own_ai(index, env):
    from api._postgen.infrastructure.llm.fake import FakeLLMClient
    args = {"agenda_id": env["aid"], "kind": "recap", "role_notes": {"Cat": "講得很好"}}
    brief = call(index, "start_post", env["officer"], args)
    assert not brief["isError"]
    schema = brief["structuredContent"]["content_schema"]
    assert "roleHighlights" in schema["properties"]
    text = brief["content"][0]["text"]
    assert "三條不可違反的紅線" in text and "Cat" in text
    # The "user's AI" writes the content (here: the fake model, from the same prompt).
    system, user = text.split("=== 本次資料與任務（user）===")
    content = FakeLLMClient().generate("", user, {"name": "emit_canonical_content",
                                                 "input_schema": schema})
    out = call(index, "submit_post", env["officer"], {**args, "content": content})
    assert not out["isError"], out["content"][0]["text"]
    post = out["structuredContent"]["post"]
    assert post["reviewState"] == "pending"
    assert "Dan" in post["governance"]["aiWrittenHighlights"]
    assert "Cat" not in post["governance"]["aiWrittenHighlights"]


def test_submit_with_wrong_names_is_refused_not_saved(index, env):
    args = {"agenda_id": env["aid"], "kind": "recap"}
    content = {"postType": "POST_REVIEW", "opening": "x",
               "roleHighlights": [{"name": "冒名者", "roleType": "總主持人", "highlight": "x"}]}
    out = call(index, "submit_post", env["officer"], {**args, "content": content})
    assert out["isError"] and "沒有存檔" in out["content"][0]["text"]


def test_generate_copy_reports_the_governed_post_instead_of_blanking_it(index, env):
    created = call(index, "create_post", env["officer"], {"club_id": env["cid"], "kind": "promo",
                                                          "agenda_id": env["aid"]})
    pid = created["structuredContent"]["id"] if "id" in created["structuredContent"] else created["structuredContent"]["postId"]
    out = call(index, "generate_copy", env["officer"], {"post_id": pid})
    assert not out["isError"], out["content"][0]["text"]
    post = call(index, "get_post", env["officer"], {"post_id": pid})["structuredContent"]
    assert post["reviewState"] == "pending"
    assert "希望" in post["variants"]["facebook"]["text"] and post["body"]


def test_post_prefs_tools(index, env):
    out = call(index, "update_post_prefs", env["officer"],
               {"prefs": {"brand_signature": "一起說話。", "fixed_hashtags": ["#MCP"]}})
    assert not out["isError"]
    got = call(index, "get_post_prefs", env["officer"], {})["structuredContent"]
    assert got["prefs"]["brand_signature"] == "一起說話。" and got["prefs"]["fixed_hashtags"] == ["#MCP"]
    tpls = call(index, "list_post_templates", env["officer"], {})["structuredContent"]["templates"]
    assert any(t["source"] == "builtin" for t in tpls)


def _docx(text: str) -> str:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml",
                   f'<w:document><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return base64.b64encode(buf.getvalue()).decode()


class _FakeR2:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[Key] = (Body, ContentType)


def test_word_template_tool_checks_then_stores(index, env, monkeypatch):
    fake = _FakeR2()
    monkeypatch.setattr(index, "_r2", lambda: fake)
    bad = call(index, "set_word_template", env["admin"],
               {"club_id": env["cid"], "file_base64": _docx("{{#演講}}{{講題}} {{總主持人")})
    assert bad["isError"] and not fake.objects
    ok = call(index, "set_word_template", env["admin"],
              {"club_id": env["cid"], "file_base64": _docx("{{#演講}}{{講題}}{{/演講}} {{總主持人}}")})
    assert not ok["isError"] and len(fake.objects) == 1
    club = call(index, "get_club", env["admin"], {"club_id": env["cid"]})["structuredContent"]
    assert club["settings"]["word_template_url"] == ok["structuredContent"]["url"]
    cleared = call(index, "set_word_template", env["admin"], {"club_id": env["cid"], "clear": True})
    assert not cleared["isError"]
    with pytest.raises(index.HTTPException):
        call(index, "set_word_template", env["officer"], {"club_id": env["cid"], "clear": True})


def test_custom_roles_keep_their_ids(index, env):
    first = call(index, "set_custom_roles", env["admin"],
                 {"club_id": env["cid"], "roles": [{"zh": "攝影師"}, {"zh": "  "}]})
    roles = first["structuredContent"]["roles"]
    assert len(roles) == 1 and roles[0]["id"].startswith("r")
    renamed = call(index, "set_custom_roles", env["admin"],
                   {"club_id": env["cid"], "roles": [{"id": roles[0]["id"], "zh": "攝影組", "en": "Photo"}]})
    assert renamed["structuredContent"]["roles"][0]["id"] == roles[0]["id"]


def test_update_club_takes_the_display_switches_as_booleans(index, env):
    out = call(index, "update_club", env["admin"], {"club_id": env["cid"], "settings": {"show_logo": False}})
    assert not out["isError"]
    assert out["structuredContent"]["settings"]["show_logo"] is False


def test_machine_tools(index, env):
    out = call(index, "list_machines", env["officer"], {})
    assert not out["isError"] and out["structuredContent"]["machines"] == []
    with pytest.raises(index.HTTPException):
        call(index, "pair_machine", env["officer"], {"code": "000000", "username": env["officer"]["username"]})


def test_catalogue_lists_the_new_tools(index, env):
    from fastapi.testclient import TestClient
    token = index.make_token(env["officer"]["username"])
    r = TestClient(index.app).get("/api/mcp/catalog", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert "start_post" in json.dumps(r.json(), ensure_ascii=False)


def test_members_cannot_use_the_officer_only_machine_tools(index, env):
    member = {**env["officer"], "role": "club_member"}
    for name, args in (("pair_machine", {"code": "123456", "username": "x"}),
                       ("update_machine", {"machine_id": 1, "name": "x"}),
                       ("list_machines", {})):
        with pytest.raises(index.HTTPException) as e:
            call(index, name, member, args)
        assert e.value.status_code == 403
