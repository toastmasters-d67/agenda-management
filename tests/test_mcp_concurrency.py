"""The MCP endpoint must not stall the API while a tool runs.

export_agenda opens the agenda page in Chromium, and that page calls back into
this same API. On the VM it runs as one uvicorn worker, so a handler run inline
on the event loop left the page waiting until the export itself timed out.
Here a tool calls back into a real server the same way; no database needed.
"""
import json
import socket
import threading
import time
import urllib.request

import pytest

uvicorn = pytest.importorskip("uvicorn")


@pytest.fixture()
def server(monkeypatch):
    import api.index as index

    monkeypatch.setattr(index, "mcp_caller", lambda request: {
        "username": "probe", "role": "system_admin", "club_id": None,
        "memberships": {}, "scopes": set(), "client_id": "", "grant": "", "origin": ""})

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    def probe(caller, args):
        # What the agenda page does: a request back into this API.
        with urllib.request.urlopen(f"{base}/.well-known/oauth-authorization-server", timeout=5) as res:
            return index._tool_text(f"callback {res.status}")

    monkeypatch.setattr(index, "MCP_TOOLS", index.MCP_TOOLS + [
        {"name": "_callback_probe", "scope": None, "handler": probe}])

    srv = uvicorn.Server(uvicorn.Config(index.app, host="127.0.0.1", port=port,
                                        workers=1, log_level="warning"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield base
    srv.should_exit = True
    t.join(timeout=5)


def test_a_tool_can_call_back_into_the_api(server):
    req = urllib.request.Request(
        f"{server}/api/mcp",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                         "params": {"name": "_callback_probe", "arguments": {}}}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=15) as res:
        body = json.loads(res.read())
    result = body["result"]
    assert not result.get("isError"), result
    assert "callback 200" in json.dumps(result, ensure_ascii=False)
    assert time.monotonic() - started < 5
