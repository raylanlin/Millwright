"""sw_agent.server — stdio JSON-RPC loop.

Reads line-delimited JSON requests from stdin and writes line-delimited
JSON responses to stdout.
Methods: ping / list_tools / call.
Importing tools.* triggers @tool decorator registration.

P17: after emitting the ready handshake, warm up the COM early-binding cache
in a BACKGROUND thread (the first EnsureDispatch builds the SolidWorks typelib
makepy cache, tens of seconds).

P23 fix: the warmup thread must NOT share its COM object with the RPC thread.
COM objects are apartment-threaded — the P17 version cached the warm
connection into the shared Context, and every later access from the main
thread (ctx.model → ActiveDoc) failed with a cryptic com_error
("SldWorks.Application.ActiveDoc"). The warmup now runs CoInitialize in its
own thread, makes a THROWAWAY connection purely to trigger makepy generation
(the slow, disk-persisted part), and discards it. The main thread's first
real call re-connects quickly against the warmed cache.
"""
from __future__ import annotations
import json
import sys
import threading

from . import registry
from .bridge import Context

# Trigger tool registration (the import order also defines category display order)
from .tools import (  # noqa: F401  E402
    view,
    document,
    sketch,
    feature,
    reference,
    assembly,
    export,
    query,
)


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _warm_up() -> None:
    """Best-effort makepy warmup on a throwaway, thread-local connection.

    Never touches the shared Context: COM objects must not cross threads.
    """
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:  # noqa: BLE001
        return
    try:
        Context().sw  # throwaway connect: GetActiveObject + EnsureDispatch → builds gen_py cache
    except Exception:  # noqa: BLE001 — SW may not be running; the real call path will report properly
        pass
    finally:
        try:
            import pythoncom
            pythoncom.CoUninitialize()
        except Exception:  # noqa: BLE001
            pass


def serve() -> None:
    ctx = Context()
    # Readiness signal (used by the Node side for handshake) — emit FIRST so warmup never delays it
    _write({"id": None, "ok": True, "data": {"ready": True, "tool_count": len(registry.TOOLS)}})
    # P17/P23: warm the makepy cache on a throwaway thread-local connection
    threading.Thread(target=_warm_up, daemon=True).start()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            _write({"id": None, "ok": False, "error": "invalid JSON"})
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
                data = registry.call(ctx, params.get("name"), params.get("args") or {})
            elif method == "reconnect":
                ctx.reconnect()
                data = {"reconnected": True}
            else:
                raise ValueError(f"unknown method: {method}")
            _write({"id": rid, "ok": True, "data": data})
        except Exception as e:  # noqa: BLE001 — normalize any tool exception into a structured error for the agent
            _write({"id": rid, "ok": False, "error": str(e)})
