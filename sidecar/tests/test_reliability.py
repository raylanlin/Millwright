"""P125 — guard / error codes / session log, pure logic."""
from __future__ import annotations

import json
import os

import pytest

os.environ.setdefault("SW_AGENT_SESSION_LOG", "0")  # tests must not write to the user's session dir

from sw_agent import server, session_log
from sw_agent.bridge import SWError


def test_guard_idempotency_and_bump():
    g = server._Guard(cap=2)
    assert g.get(None) is None and g.get("x") is None
    g.put("a", {"r": 1}); g.put("b", {"r": 2}); g.put("c", {"r": 3})
    assert g.get("a") is None and g.get("c") == {"r": 3}  # LRU cap
    assert g.bump() == 1 and g.bump() == 2


def test_error_codes():
    assert server._error_code(SWError("Cannot connect to SolidWorks: x")) == "NO_CONNECTION"
    assert server._error_code(SWError("No document is open. Please ...")) == "NO_DOCUMENT"
    assert server._error_code(SWError("This operation requires a part document.")) == "WRONG_DOC_TYPE"
    assert server._error_code(SWError("tool x missing required parameter: depth")) == "BAD_ARGS"
    assert server._error_code(SWError("unknown tool: nope")) == "UNKNOWN_TOOL"
    assert server._error_code(SWError("fillet failed")) == "TOOL_FAILED"
    assert server._error_code(server.CodedError("STALE_STATE", "m")) == "STALE_STATE"

    class ComErr(Exception):
        hresult = -2147023174
    assert server._error_code(ComErr("rpc")) == "COM_ERROR"


def test_replay_steps_skip_queries_and_failures():
    rows = [
        {"tool": "new_part", "args": {}, "ok": True},
        {"tool": "list_faces", "args": {}, "ok": True},
        {"tool": "extrude", "args": {"depth": 10}, "ok": True, "verified": {"checked": True, "ok": False}},
        {"tool": "extrude", "args": {"depth": 10}, "ok": True, "verified": {"checked": True, "ok": True}},
        {"tool": "cut_extrude", "args": {"depth": 5}, "ok": False},
    ]
    steps = session_log.replay_steps(rows)
    assert [s["tool"] for s in steps] == ["new_part", "extrude"]
    assert len(session_log.replay_steps(rows, only_ok=False)) == 4


def test_python_template_is_valid_source():
    src = session_log.PY_TEMPLATE.format(when="now", steps=json.dumps([{"tool": "new_part", "args": {}}]))
    compile(src, "replay.py", "exec")


def test_stale_state_raises_coded_error():
    class Ctx:  # never reached: STALE_STATE is checked before any COM access
        pass
    server.GUARD.state_version = 5
    with pytest.raises(server.CodedError) as ei:
        server._call(Ctx(), "extrude", {}, op_id=None, expect_state=3)
    assert ei.value.code == "STALE_STATE"
    server.GUARD.state_version = 0
