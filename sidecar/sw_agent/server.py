"""sw_agent.server — stdio JSON-RPC loop.

Reads line-delimited JSON requests from stdin and writes line-delimited
JSON responses to stdout.
Methods: ping / list_tools / call.
Importing tools.* triggers @tool decorator registration.

P17: after emitting the ready handshake, warm the COM connection path in a BACKGROUND
thread, so the first real tool call does not pay for the initial connect.

P72: this warmup no longer generates the makepy type-library cache — that took long
enough to starve the app's own connection probe. See typelib.py.

P23 fix: the warmup thread must NOT share its COM object with the RPC thread.
COM objects are apartment-threaded — the P17 version cached the warm
connection into the shared Context, and every later access from the main
thread (ctx.model → ActiveDoc) failed with a cryptic com_error
("SldWorks.Application.ActiveDoc"). The warmup now runs CoInitialize in its
own thread, makes a THROWAWAY connection purely to trigger makepy generation
(the slow, disk-persisted part), and discards it. The main thread's first
real call re-connects quickly against the warmed cache.

P121: EVERY mutating tool call is now verified, not just build_part steps.
The whole family of "the tool reported success but nothing happened" bugs —
delete_feature claiming deletions it never made (P105), create_plane echoing
the requested offset while the plane never moved (P105→P120, five rounds),
fillet selecting 3 of 4 edges and reporting success (P92) — shares one root:
verification lived only inside build_part, while the agent mostly issues
single calls. Each bug got a bespoke in-tool check; the class was never
closed. Now the server snapshots the document before/after every call whose
verify.classify() kind is mutating and attaches the same `_verified` evidence
build_part steps carry. Evidence, not a gate: the tool's own result is never
altered or blocked, but a lying success now arrives with its own refutation.
"""
from __future__ import annotations

import json
import sys
import threading

from sw_agent import registry, verify
from sw_agent.bridge import Context

# Trigger tool registration (the import order also defines category display order)
from sw_agent.tools import (  # noqa: F401
    assembly,
    batch,
    diagnose,
    document,
    drawing,
    export,
    feature,
    guidance,
    machine,
    query,
    reference,
    search,
    shell,
    sketch,
    status,
    view,
)


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _call_verified(ctx: Context, name: str, args: dict):
    """P121: build_part's per-step snapshot/verify pattern, hoisted to the server.

    Only kinds in verify.MUTATING_KINDS pay for the two snapshots; queries, document
    ops, display ops and self-verifying tools (build_part runs this per step itself;
    create_plane measures its own plane position) go straight through. Verification
    must never fail the call: any exception in the evidence path degrades to the
    bare result, same principle as ctx.doc_state().
    """
    kind = verify.classify(name)
    if kind not in verify.MUTATING_KINDS:
        return registry.call(ctx, name, args)
    try:
        before = verify.snapshot(ctx)
    except Exception:  # noqa: BLE001 — evidence, not a gate
        before = None
    data = registry.call(ctx, name, args)
    if before is None or not isinstance(data, dict):
        return data
    try:
        after = verify.snapshot(ctx)
        check = verify.verify_step(name, args, before, after)
    except Exception:  # noqa: BLE001
        return data
    data = dict(data)
    data["_verified"] = check
    return data


def _warm_up() -> None:
    """Best-effort makepy warmup on a throwaway, thread-local connection.

    Never touches the shared Context: COM objects must not cross threads.
    """
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:  # noqa: BLE001
        return
    # P72: type-library generation is NO LONGER done here. P69 built the cache on this
    # thread, and makepy over sldworks.tlb saturates COM and disk for tens of seconds to
    # minutes — long enough that the separate cscript probe in sw-bridge.ts timed out and
    # the app reported "SolidWorks is running but COM refused, check privilege levels".
    # Nothing was misconfigured; the connection was starved by our own optimisation.
    # The enum values CreateDefinition needs come from the table in typelib.py, so
    # generating the cache buys nothing that is worth a risk to connectivity.
    try:
        Context().sw  # throwaway connect, purely to warm the connection path
    except Exception:  # noqa: BLE001 — SW may not be running; the real call path reports properly
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
                # P121: universal verification for mutating tools (see _call_verified)
                data = _call_verified(ctx, params.get("name"), params.get("args") or {})
                # P94: attach the lightweight document snapshot to every tool result so
                # the model never has to burn a list_features/analyze_view turn just to
                # locate itself. Failure to build the snapshot must not fail the tool.
                if isinstance(data, dict):
                    try:
                        data["_state"] = ctx.doc_state()
                    except Exception:  # noqa: BLE001 — state is a convenience
                        pass
            elif method == "reconnect":
                ctx.reconnect()
                data = {"reconnected": True}
            else:
                raise ValueError(f"unknown method: {method}")
            _write({"id": rid, "ok": True, "data": data})
        except Exception as e:  # noqa: BLE001 — normalize any tool exception into a structured error for the agent
            _write({"id": rid, "ok": False, "error": str(e)})
