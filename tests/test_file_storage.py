"""The R2 / Azure Blob storage switch (the _store_* helpers and /api/files).

No cloud: Blob is a fake container client, R2 a fake boto3 client. Checks
that a deployment without AZURE_STORAGE_* keeps R2 exactly as before, and
that one with it serves and accepts files through its own /api/files routes.
"""
import io
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from azure.core.exceptions import ResourceNotFoundError
from fastapi.testclient import TestClient

BASE = "https://vm.example/club-management"


class FakeDownload:
    def __init__(self, data, ctype):
        self.data, self.properties = data, SimpleNamespace(
            size=len(data), content_settings=SimpleNamespace(content_type=ctype))

    def readall(self):
        return self.data

    def chunks(self):
        yield self.data


class FakeContainer:
    def __init__(self):
        self.blobs = {}

    def upload_blob(self, name, data, overwrite, content_settings):
        self.blobs[name] = (bytes(data), content_settings.content_type)

    def download_blob(self, name, offset=None, length=None):
        if name not in self.blobs:
            raise ResourceNotFoundError("missing")
        data, ctype = self.blobs[name]
        return FakeDownload(data[:length] if length else data, ctype)

    def delete_blob(self, name):
        if name not in self.blobs:
            raise ResourceNotFoundError("missing")
        del self.blobs[name]

    def list_blobs(self, name_starts_with):
        return [SimpleNamespace(name=n) for n in self.blobs if n.startswith(name_starts_with)]


@pytest.fixture()
def blob(monkeypatch):
    import api.index as index
    cc = FakeContainer()
    monkeypatch.setattr(index, "AZURE_STORAGE_ACCOUNT", "std67agfiles")
    monkeypatch.setattr(index, "AZURE_STORAGE_CONTAINER", "agenda-files")
    monkeypatch.setattr(index, "FILES_PUBLIC_URL", "")
    monkeypatch.setattr(index, "R2_PUBLIC_URL", "https://pub.r2.example")
    monkeypatch.setenv("PUBLIC_BASE_URL", BASE)
    monkeypatch.setattr(index, "_blob", lambda: cc)
    monkeypatch.setattr(index, "_r2", lambda: pytest.fail("R2 must not be used on Blob"))
    return index, cc


def test_r2_stays_the_default(monkeypatch):
    import api.index as index
    monkeypatch.setattr(index, "AZURE_STORAGE_ACCOUNT", "")
    monkeypatch.setattr(index, "R2_PUBLIC_URL", "https://pub.r2.example")
    monkeypatch.setattr(index, "R2_BUCKET_NAME", "bucket")
    calls = []

    class FakeR2:
        def put_object(self, **kw):
            calls.append(kw)

        def generate_presigned_url(self, op, Params, ExpiresIn):
            return f"https://acct.r2.cloudflarestorage.com/{Params['Key']}?sig"
    monkeypatch.setattr(index, "_r2", lambda: FakeR2())

    index._store_put("media/a.png", b"x", "image/png")
    assert calls == [{"Bucket": "bucket", "Key": "media/a.png", "Body": b"x", "ContentType": "image/png"}]
    assert index._store_url("media/a.png") == "https://pub.r2.example/media/a.png"
    assert index._store_presign_put("media/a.png", "image/png", 60).startswith("https://acct.r2")
    assert index._store_key("https://pub.r2.example/media/a.png") == "media/a.png"
    assert index._store_key("https://elsewhere.example/media/a.png") is None


def test_blob_urls_and_legacy_r2_links(blob):
    index, cc = blob
    assert index._store_url("media/clubs/1/x.png") == f"{BASE}/api/files/media/clubs/1/x.png"
    assert index._store_key(f"{BASE}/api/files/media/clubs/1/x.png") == "media/clubs/1/x.png"
    # Links still pointing at R2 resolve to the same key (the move keeps keys).
    assert index._store_key("https://pub.r2.example/media/clubs/1/x.png") == "media/clubs/1/x.png"
    assert index._store_key("https://evil.example/media/x.png") is None


def test_blob_put_get_list_delete(blob):
    index, cc = blob
    index._store_put("media/clubs/1/a/status.json", b'{"ok":true}', "application/json")
    assert index._store_get("media/clubs/1/a/status.json") == (b'{"ok":true}', "application/json")
    assert index._store_list("media/clubs/1/a/") == ["media/clubs/1/a/status.json"]
    index._store_delete("media/clubs/1/a/status.json")
    index._store_delete("media/clubs/1/a/status.json")       # already gone: fine
    with pytest.raises(index.StoreMissing):
        index._store_get("media/clubs/1/a/status.json")


def test_signed_upload_then_public_read(blob):
    index, cc = blob
    client = TestClient(index.app)
    url = index._store_presign_put("media/clubs/1/logo.png", "image/png", 300)
    assert url.startswith(f"{BASE}/api/files/upload/media/clubs/1/logo.png?")
    path = urlsplit(url)
    local = path.path[len("/club-management"):] + "?" + path.query    # nginx strips the prefix

    assert client.put(local, content=b"PNG", headers={"Content-Type": "image/png"}).status_code == 200
    assert cc.blobs["media/clubs/1/logo.png"] == (b"PNG", "image/png")

    r = client.get("/api/files/media/clubs/1/logo.png")
    assert r.status_code == 200 and r.content == b"PNG"
    assert r.headers["content-type"] == "image/png"
    assert "immutable" in r.headers["cache-control"]
    assert client.get("/api/files/media/clubs/1/nope.png").status_code == 404


def test_upload_rejects_bad_signature_type_and_expiry(blob):
    index, cc = blob
    client = TestClient(index.app)
    url = index._store_presign_put("media/clubs/1/a.png", "image/png", 300)
    path = urlsplit(url)
    q = {k: v[0] for k, v in parse_qs(path.query).items()}
    local = path.path[len("/club-management"):]

    # Another key with this signature.
    r = client.put("/api/files/upload/media/clubs/2/a.png", params=q, content=b"x",
                   headers={"Content-Type": "image/png"})
    assert r.status_code == 403
    # Content type differs from the one signed.
    r = client.put(local, params=q, content=b"x", headers={"Content-Type": "text/html"})
    assert r.status_code == 400
    # Expired.
    exp = int(time.time()) - 1
    old = {"ct": "image/png", "exp": exp, "sig": index._upload_sig("media/clubs/1/a.png", "image/png", exp)}
    r = client.put(local, params=old, content=b"x", headers={"Content-Type": "image/png"})
    assert r.status_code == 403
    assert not cc.blobs


def test_status_json_is_not_cached_and_keys_are_checked(blob):
    index, cc = blob
    cc.blobs["media/clubs/1/agendas/f/status.json"] = (b"{}", "application/json")
    client = TestClient(index.app)
    assert client.get("/api/files/media/clubs/1/agendas/f/status.json").headers["cache-control"] == "no-store"
    assert client.get("/api/files/etc/passwd").status_code == 404
    assert client.get("/api/files/media/../secret").status_code == 404


def test_files_routes_are_off_on_r2(monkeypatch):
    import api.index as index
    monkeypatch.setattr(index, "AZURE_STORAGE_ACCOUNT", "")
    assert TestClient(index.app).get("/api/files/media/a.png").status_code == 404


def test_export_status_read_through_blob(blob):
    index, cc = blob
    caller = {"username": "off", "role": "club_admin", "club_id": 27}
    prefix = "media/clubs/27/agendas/abc123def456/"
    cc.blobs[prefix + index._EXPORT_STATUS_NAME] = (b'{"ok": true}', "application/json")
    cc.blobs[prefix + "Agenda_x.pdf"] = (b"%PDF", "application/pdf")
    out = index._tool_get_agenda_export(caller, {"job": f"27-abc123def456-{int(time.time())}"})
    files = out["structuredContent"]["files"] if "structuredContent" in out else None
    text = str(out)
    assert f"{BASE}/api/files/{prefix}Agenda_x.pdf" in text, (files, text)


def test_migrate_copies_missing_objects_only(blob, monkeypatch, capsys):
    index, cc = blob
    import api.migrate_storage as mig
    cc.blobs["media/same.png"] = (b"12345", "image/png")
    monkeypatch.setattr(cc, "list_blobs", lambda name_starts_with="": [
        SimpleNamespace(name=n, size=len(d)) for n, (d, _) in cc.blobs.items()])
    objects = {"media/same.png": (b"12345", "image/png"), "media/new.docx": (b"DOCX", "application/x-docx")}

    class FakeR2:
        def get_paginator(self, op):
            return SimpleNamespace(paginate=lambda Bucket: [
                {"Contents": [{"Key": k, "Size": len(d)} for k, (d, _) in objects.items()]}])

        def get_object(self, Bucket, Key):
            return {"Body": io.BytesIO(objects[Key][0]), "ContentType": objects[Key][1]}
    monkeypatch.setattr(index, "_r2", lambda: FakeR2())
    monkeypatch.setattr(index, "R2_BUCKET_NAME", "bucket")

    mig.copy_objects(apply=False)
    assert "media/new.docx" not in cc.blobs
    mig.copy_objects(apply=True)
    assert cc.blobs["media/new.docx"] == (b"DOCX", "application/x-docx")
    assert "需要複製 1 個" in capsys.readouterr().out
