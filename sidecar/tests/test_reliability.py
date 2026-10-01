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
    g.put("a", {"r": 1})
    g.put("b", {"r": 2})
    g.put("c", {"r": 3})
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


def test_failed_call_is_cached_under_op_id():
    """P131: a TIMEOUT follow-up with the same op_id must get the failure back, not re-run."""
    from sw_agent import registry

    runs = []

    def flaky(ctx):
        runs.append(1)
        raise SWError("gear body built, then the hole failed")

    registry.TOOLS["_p131_flaky"] = registry.ToolSpec("_p131_flaky", "", {}, "", False, True, flaky)
    try:
        for _ in range(2):
            with pytest.raises(SWError):
                server._call(object(), "_p131_flaky", {}, op_id="p131-op", expect_state=None)
        assert len(runs) == 1
    finally:
        registry.TOOLS.pop("_p131_flaky", None)
        server.GUARD.done.pop("p131-op", None)


def test_heartbeat_survives_futures_timeout(monkeypatch):
    """P131: on Python < 3.11 Future.result(timeout) raises concurrent.futures.TimeoutError,
    which is not the builtin — the first heartbeat tick used to escape as TOOL_FAILED."""
    from concurrent.futures import Future
    from concurrent.futures import TimeoutError as FutureTimeout

    frames = []
    monkeypatch.setattr(server, "_write", frames.append)

    class SlowFuture(Future):
        ticks = 0

        def result(self, timeout=None):
            SlowFuture.ticks += 1
            if SlowFuture.ticks < 3:
                raise FutureTimeout()  # what 3.9 / 3.10 raise
            return {"ok": True}

    class Exec:
        def submit(self, fn):
            return SlowFuture()

    assert server._call_with_heartbeat(Exec(), None, 7, "slow", {}, None, None) == {"ok": True}
    assert [f["progress"] for f in frames] == [True, True]
    assert all(f["id"] == 7 for f in frames)


def test_parent_watchdog_uses_pid_not_stdin():
    """P131: the P129 watchdog peeked stdin from a second thread and stalled requests."""
    import inspect

    assert server._parent_alive(os.getppid()) is True
    if os.name != "nt":
        assert server._parent_alive(os.getppid() + 999_999) is False
    assert "peek(" not in inspect.getsource(server.serve)
