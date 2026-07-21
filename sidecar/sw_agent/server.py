"""sw_agent.server — stdio JSON-RPC loop.

Reads line-delimited JSON requests from stdin and writes line-delimited
JSON responses to stdout.
Methods: ping / list_tools / call.
Importing tools.* triggers @tool decorator registration.
"""
from __future__ import annotations
import json
import sys

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


def serve() -> None:
    ctx = Context()
    # Readiness signal (used by the Node side for handshake)
    _write({"id": None, "ok": True, "data": {"ready": True, "tool_count": len(registry.TOOLS)}})
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
