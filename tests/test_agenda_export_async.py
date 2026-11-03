"""export_agenda starts a render and get_agenda_export reads its outcome.

No database or bucket: the agenda lookup, R2 and the call to the web side are
stand-ins, so this checks the job handshake, not the render itself.
"""
import contextlib
import io
import json
import time

import pytest


@pytest.fixture()
def index(monkeypatch):
    import api.index as index
    monkeypatch.setattr(index, "R2_BUCKET_NAME", "bucket")
    monkeypatch.setattr(index, "R2_PUBLIC_URL", "https://pub.example")
    return index


OFFICER = {"username": "off", "role": "club_admin", "club_id": 27, "memberships": {}, "origin": "http://web"}
OTHER = {**OFFICER, "club_id": 99}


class FakeR2:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.presigned = []

    def generate_presigned_url(self, op, Params, ExpiresIn):
        self.presigned.append((Params["Key"], Params["ContentType"], ExpiresIn))
        return f"https://acct.r2.cloudflarestorage.com/{Params['Key']}?sig"

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey()
        return {"Body": io.BytesIO(self.objects[Key])}

    def list_objects_v2(self, Bucket, Prefix):
        return {"Contents": [{"Key": k} for k in self.objects if k.startswith(Prefix)]}


def test_export_starts_an_async_render_and_returns_a_job(index, monkeypatch):
    r2 = FakeR2()
    monkeypatch.setattr(index, "_r2", lambda: r2)

    @contextlib.contextmanager
    def fake_db():
        class Conn:
            @contextlib.contextmanager
            def cursor(self):
                yield None
        yield Conn()
    monkeypatch.setattr(index, "get_db", fake_db)
    monkeypatch.setattr(index, "_agenda_for",
                        lambda cur, aid, caller: ({"meetingDate": "2026-09-12", "meetingNo": "241"}, 27))

    sent = {}

    class Res:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"accepted": true}'

    def fake_urlopen(req, timeout):
        sent["url"], sent["body"], sent["timeout"] = req.full_url, json.loads(req.data), timeout
        return Res()
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    out = index._tool_export_agenda(OFFICER, {"agenda_id": 6})

    assert not out.get("isError"), out
    job = out["structuredContent"]["job"]
    assert index._EXPORT_JOB_RE.match(job) and job.startswith("27-")
    assert sent["url"] == "http://web/svc/agenda-export"
    assert sent["body"]["async"] is True
    assert sent["timeout"] <= 30
    status_key = next(k for k, ctype, _ in r2.presigned if k.endswith("/status.json"))
    assert status_key == f"media/clubs/27/agendas/{job.split('-')[1]}/status.json"
    assert sent["body"]["uploads"]["status"].startswith("https://acct.r2.cloudflarestorage.com/" + status_key)


def _job(started=None):
    return f"27-0123456789ab-{int(started if started is not None else time.time())}"


PREFIX = "media/clubs/27/agendas/0123456789ab/"


def test_pending_then_done_with_files_in_order(index, monkeypatch):
    r2 = FakeR2()
    monkeypatch.setattr(index, "_r2", lambda: r2)
    out = index._tool_get_agenda_export(OFFICER, {"job": _job()})
    assert out["structuredContent"]["status"] == "pending" and not out.get("isError")

    stem = "Agenda_2026-09-12_No241"
    r2.objects.update({
        PREFIX + "status.json": json.dumps({"ok": True, "jpgPages": 2, "pdf": True}).encode(),
        PREFIX + f"{stem}_p2.jpg": b"", PREFIX + f"{stem}_p1.jpg": b"", PREFIX + f"{stem}.pdf": b"",
    })
    out = index._tool_get_agenda_export(OFFICER, {"job": _job()})
    files = out["structuredContent"]["files"]
    assert out["structuredContent"]["status"] == "done"
    assert [(f["format"], f.get("page")) for f in files] == [("pdf", None), ("jpg", 1), ("jpg", 2)]
    assert files[1]["url"] == f"https://pub.example/{PREFIX}{stem}_p1.jpg"


def test_failure_is_reported(index, monkeypatch):
    r2 = FakeR2({PREFIX + "status.json": json.dumps({"ok": False, "detail": "議程輸出失敗：逾時"}).encode()})
    monkeypatch.setattr(index, "_r2", lambda: r2)
    out = index._tool_get_agenda_export(OFFICER, {"job": _job()})
    assert out.get("isError") and out["structuredContent"]["status"] == "failed"
    assert "逾時" in out["content"][0]["text"]


def test_no_outcome_after_the_stale_limit(index, monkeypatch):
    monkeypatch.setattr(index, "_r2", lambda: FakeR2())
    old = time.time() - index._EXPORT_STALE.total_seconds() - 60
    out = index._tool_get_agenda_export(OFFICER, {"job": _job(old)})
    assert out.get("isError") and out["structuredContent"]["status"] == "stale"


def test_job_of_another_club_or_malformed_is_refused(index, monkeypatch):
    monkeypatch.setattr(index, "_r2", lambda: FakeR2())
    with pytest.raises(index.HTTPException) as e:
        index._tool_get_agenda_export(OTHER, {"job": _job()})
    assert e.value.status_code == 403
    for bad in ("27-../../x-1", "27-0123456789ab", "abc"):
        with pytest.raises(index.HTTPException) as e:
            index._tool_get_agenda_export(OFFICER, {"job": bad})
        assert e.value.status_code == 400
