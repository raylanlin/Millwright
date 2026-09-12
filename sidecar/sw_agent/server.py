"""sw_agent.server — stdio JSON-RPC loop.

Methods: ping / list_tools / call / reconnect / health / state.

P122: all COM work on ONE STA thread (ComExecutor); warmup is the first queued job.
P121: mutating tools carry `_verified`; P94: every result carries `_state`.
P125 (this file):
  - **operation_id idempotency**: `params.op_id` — a repeated id returns the cached
    result with `_duplicate: true` instead of re-running the tool (stream/retry safety,
    SolidPilot OperationGuard).
  - **state_version**: increments after every successful MUTATING call; a caller may
    send `params.expect_state` and gets error code STALE_STATE if the document moved
    on (user edited in SW, another call landed) — the model must re-read, not guess.
  - **error codes**: errors are `{ok:false, error:<str>, code:<ENUM>}`. Codes:
    NO_CONNECTION · NO_DOCUMENT · WRONG_DOC_TYPE · UNKNOWN_TOOL · BAD_ARGS · STALE_STATE ·
    COM_ERROR · TOOL_FAILED. `error` stays a plain string for the existing UI.
  - **version advisory**: on SW releases outside SW_AGENT_VERIFIED_YEARS (default
    2024,2025) mutating results carry `_advisory` — the approval UI can require
    confirmation; nothing is blocked here (just1step gates high-risk workflows the same way).
  - **health**: read-only probe {connected, state_version, sw_year, tool_count}.
  - **session log**: every call is recorded (session_log.py) → export_session.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import OrderedDict

from sw_agent import registry, session_log, verify
from sw_agent.bridge import Context, SWError, hresult, is_dead_connection
from sw_agent.com_executor import ComExecutor
from sw_agent.tools import (  # noqa: F401  (import order = category display order)
    assembly,
    batch,
    diagnose,
    document,
    drawing,
    export,
    feature,
    guidance,
    health,
    machine,
    query,
    reference,
    search,
    session,
    shell,
    sketch,
    status,
    topology,
    view,
    workflows,  # P126
)

VERIFIED_YEARS = {int(y) for y in os.environ.get("SW_AGENT_VERIFIED_YEARS", "2024,2025").split(",") if y.strip().isdigit()}

_OUT_LOCK = threading.Lock()


def _write(obj: dict) -> None:
    # P130: heartbeat thread and the main stdin loop both write stdout — lock so JSON frames
    # never interleave (a partial frame on Node's readline side used to show up as a parse
    # error and silently drop the heartbeat).
    with _OUT_LOCK:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


class _Guard:
    """Idempotency cache + state version (single writer: the executor thread)."""

    def __init__(self, cap: int = 256) -> None:
        self.done: OrderedDict = OrderedDict()
        self.cap = cap
        self.state_version = 0

    def get(self, op_id):
        if op_id is None:
            return None
        return self.done.get(op_id)

    def put(self, op_id, result) -> None:
        if op_id is None:
            return
        self.done[op_id] = result
        while len(self.done) > self.cap:
            self.done.popitem(last=False)

    def bump(self) -> int:
        self.state_version += 1
        return self.state_version


GUARD = _Guard()


class CodedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _error_code(e: Exception) -> str:
    if isinstance(e, CodedError):
        return e.code
    s = str(e)
    if isinstance(e, SWError):
        if s.startswith("Cannot connect to SolidWorks"):
            return "NO_CONNECTION"
        if s.startswith("No document is open"):
            return "NO_DOCUMENT"
        if "requires a" in s and "document" in s:
            return "WRONG_DOC_TYPE"
        if s.startswith("unknown tool"):
            return "UNKNOWN_TOOL"
        if "missing required parameter" in s or "unknown parameter" in s:
            return "BAD_ARGS"
        return "TOOL_FAILED"
    if hresult(e) is not None:
        return "COM_ERROR"
    if isinstance(e, TypeError) and "argument" in s:
        return "BAD_ARGS"
    return "TOOL_FAILED"


def _call_verified(ctx: Context, name: str, args: dict):
    """P121: snapshot/verify around mutating tools. Evidence, never a gate."""
    kind = verify.classify(name)
    if kind not in verify.MUTATING_KINDS:
        return registry.call(ctx, name, args), False
    try:
        before = verify.snapshot(ctx)
    except Exception:  # noqa: BLE001
        before = None
    data = registry.call(ctx, name, args)
    if before is None or not isinstance(data, dict):
        return data, True
    try:
        after = verify.snapshot(ctx)
        check = verify.verify_step(name, args, before, after)
    except Exception:  # noqa: BLE001
        return data, True
    data = dict(data)
    data["_verified"] = check
    return data, True


def _advisory(ctx: Context) -> dict | None:
    y = ctx.scratch.get("sw_year")
    if y is None:
        y = ctx.sw_info().get("year")
        ctx.scratch["sw_year"] = y
    if not y or y in VERIFIED_YEARS:
        return None
    level = "experimental" if y > max(VERIFIED_YEARS, default=y) else "unverified"
    return {"sw_year": y, "support": level,
            "note": f"SolidWorks {y} 未在本项目真机验证过（已验证: {sorted(VERIFIED_YEARS)}）。"
                    "修改类操作建议逐步确认；结果以 _verified 为准。"}


def _call(ctx: Context, name: str, args: dict, op_id=None, expect_state=None):
    """One tool call on the COM thread. Dead connection → reconnect once and retry."""
    cached = GUARD.get(op_id)
    if cached is not None:
        dup = dict(cached) if isinstance(cached, dict) else {"result": cached}
        dup["_duplicate"] = True
        return dup
    if expect_state is not None and int(expect_state) != GUARD.state_version:
        raise CodedError("STALE_STATE",
                         f"document state moved on (expected {expect_state}, now {GUARD.state_version}) — "
                         "re-read (list_features / list_faces) before acting.")
    if registry.TOOLS.get(name) is None:
        raise CodedError("UNKNOWN_TOOL", f"unknown tool: {name}")

    def work():
        t0 = time.perf_counter()
        try:
            data, mutating = _call_verified(ctx, name, args)
        except Exception as e:
            session_log.record(name, args, False, (time.perf_counter() - t0) * 1000, error=str(e),
                               state_version=GUARD.state_version)
            raise
        if mutating:
            GUARD.bump()
        if isinstance(data, dict):
            data["_sv"] = GUARD.state_version
            try:
                data["_state"] = ctx.doc_state()
            except Exception:  # noqa: BLE001
                pass
            if mutating:
                adv = _advisory(ctx)
                if adv:
                    data["_advisory"] = adv
        session_log.record(name, args, True, (time.perf_counter() - t0) * 1000,
                           verified=(data.get("_verified") if isinstance(data, dict) else None),
                           state_version=GUARD.state_version)
        GUARD.put(op_id, data)
        return data

    try:
        return work()
    except Exception as e:
        if not is_dead_connection(e):
            raise
        ctx.reconnect()
        return work()


HEARTBEAT_S = 15.0


def _call_with_heartbeat(executor, ctx, rid, name, args, op_id, expect):
    """P130: while the executor works on this call, tell Node every HEARTBEAT_S seconds that
    SolidWorks is still busy. Node resets its deadline on each frame (idle timeout), so a long
    gear/batch/export never trips a flat 60 s timer while the work is genuinely progressing."""
    fut = executor.submit(lambda: _call(ctx, name, args, op_id, expect))
    t0 = time.perf_counter()
    while True:
        try:
            return fut.result(timeout=HEARTBEAT_S)
        except TimeoutError:
            _write({"id": rid, "progress": True, "tool": name,
                    "elapsed_ms": round((time.perf_counter() - t0) * 1000)})


def _health(ctx: Context) -> dict:
    info: dict = {"connected": False, "state_version": GUARD.state_version, "tool_count": len(registry.TOOLS),
                  "session_log": str(session_log.session_path()) if session_log._ENABLED else None}
    try:
        if ctx._app is not None:
            ctx.sw.ActiveDoc  # cheap liveness probe on the existing connection only
            info["connected"] = True
            info.update({k: v for k, v in ctx.sw_info().items() if k in ("year", "revision")})
            try:
                info["active_document"] = ctx.doc_state().get("doc")
            except Exception:  # noqa: BLE001
                pass
    except Exception as e:  # noqa: BLE001
        info["connected"] = False
        info["error"] = str(e)
        info["dead_connection"] = is_dead_connection(e)  # the next call reconnects automatically
    return info


def serve() -> None:
    ctx = Context()
    executor = ComExecutor("sw-com")
    executor.start()
    _write({"id": None, "ok": True, "data": {"ready": True, "tool_count": len(registry.TOOLS),
                                             "protocol": {"op_id": True, "state_version": True, "codes": True, "progress": True}}})
    # P130: no startup warm-up. Under the single executor thread (P122) a Dispatch() that
    # blocks while SolidWorks loads add-ins sits at the HEAD of the queue and delays every
    # probe behind it — that is how the first sw_status of the 16:15 session timed out.
    # Connecting lazily costs a few hundred ms on the first real call and blocks nothing.
    def _watchdog():
        # If the parent dies mid-COM-call the stdin loop never sees EOF. Poll the pipe from a
        # helper thread: once stdin is closed, give the current job 5 s and hard-exit.
        try:
            while not sys.stdin.closed:
                time.sleep(2)
                try:
                    if sys.stdin.buffer.peek(1) == b"":
                        break
                except Exception:  # noqa: BLE001 — peek on a closed stdin pipe is the trigger we care about
                    break
        except Exception:  # noqa: BLE001 — watchdog must never crash the sidecar itself
            pass
        time.sleep(5)
        os._exit(0)
    threading.Thread(target=_watchdog, name="stdin-watchdog", daemon=True).start()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            _write({"id": None, "ok": False, "error": "invalid JSON", "code": "BAD_ARGS"})
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        try:
            if method == "ping":
                data = "pong"
            elif method == "list_tools":
                data = registry.list_tools()
            elif method == "call":
                name, args = params.get("name"), params.get("args") or {}
                op_id, expect = params.get("op_id"), params.get("expect_state")
                data = _call_with_heartbeat(executor, ctx, rid, name, args, op_id, expect)
            elif method == "reconnect":
                executor.run(ctx.reconnect)
                data = {"reconnected": True}
            elif method == "health":
                data = executor.run(lambda: _health(ctx))
            elif method == "state":
                data = {"state_version": GUARD.state_version}
            else:
                raise CodedError("UNKNOWN_TOOL", f"unknown method: {method}")
            _write({"id": rid, "ok": True, "data": data})
        except Exception as e:  # noqa: BLE001
            _write({"id": rid, "ok": False, "error": str(e), "code": _error_code(e)})
    executor.stop()
    os._exit(0)



