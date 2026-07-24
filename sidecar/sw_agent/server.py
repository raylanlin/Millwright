"""sw_agent.server — stdio JSON-RPC loop.

Reads line-delimited JSON requests from stdin and writes line-delimited
JSON responses to stdout.
Methods: ping / list_tools / call.
Importing tools.* triggers @tool decorator registration.

P17: after emitting the ready handshake, warm up the COM early-binding cache
in a BACKGROUND thread. The first EnsureDispatch call builds the SolidWorks
typelib makepy cache (tens of seconds); doing it up-front, while the user is
still reading the greeting, means the cache is usually ready by the time they
send their first instruction — moving the one-time stall off the first tool
call into idle startup time. Warmup failures are swallowed (SW may be closed);
the real connection path stays the source of truth.
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


def _warm_up(ctx: Context) -> None:
    """Best-effort: trigger early-binding cache generation before the first tool call."""
    try:
        ctx.sw  # property access runs GetActiveObject + gencache.EnsureDispatch
    except Exception:  # noqa: BLE001 — SW may not be running yet; the real call path will report properly
        pass


def serve() -> None:
    ctx = Context()
    # Readiness signal (used by the Node side for handshake) — emit FIRST so warmup never delays it
    _write({"id": None, "ok": True, "data": {"ready": True, "tool_count": len(registry.TOOLS)}})
    # P17: warm the COM/makepy cache in the background so the first tool call isn't the one that pays for it
    threading.Thread(target=_warm_up, args=(ctx,), daemon=True).start()
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
