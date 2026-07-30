"""sw_agent.tools.status — connection and document status, answered by the real engine.

Why this exists: the app had TWO independent ways of deciding whether SolidWorks was
reachable — this sidecar, and a separate cscript/VBS probe in sw-bridge.ts. They can
disagree, and when they did the UI believed the wrong one: the sidecar was modelling
happily while the status bar insisted the COM connection had been refused and blamed the
user's privilege levels.

A second opinion is only useful if it is better informed. This one is: the sidecar holds
the connection the tools actually run through, so if it can read ActiveDoc, the app IS
connected, whatever a separate probe concludes.

Deliberately never raises. A status call that throws is useless — "no document open" and
"not connected" are both normal states that the caller needs reported, not thrown.
"""
from __future__ import annotations

from ..bridge import Context, sw_get
from ..registry import tool

_DOC_TYPE = {1: "part", 2: "assembly", 3: "drawing"}


@tool(
    "sw_status",
    "Report whether SolidWorks is connected and what document is open (never fails — "
    "'not connected' and 'no document' are returned as data, not errors)",
    params={},
    category="query",
)
def sw_status(ctx: Context):
    try:
        app = ctx.sw
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "reason": str(e)}
    if app is None:
        return {"connected": False, "reason": "no application object"}

    out: dict = {"connected": True}
    try:
        out["version"] = sw_get(app, "RevisionNumber")
    except Exception:  # noqa: BLE001
        pass

    try:
        doc = app.ActiveDoc
    except Exception as e:  # noqa: BLE001
        # Connected but ActiveDoc unreadable — worth reporting rather than hiding, since
        # it usually means the apartment/threading state is wrong.
        return {**out, "hasDoc": False, "docError": str(e)}

    if doc is None:
        return {**out, "hasDoc": False}

    try:
        out["activeDocumentType"] = _DOC_TYPE.get(sw_get(doc, "GetType"))
        out["activeDocumentPath"] = sw_get(doc, "GetPathName") or ""
        out["activeDocumentTitle"] = sw_get(doc, "GetTitle") or ""
        out["hasDoc"] = True
    except Exception as e:  # noqa: BLE001
        out["hasDoc"] = True
        out["docError"] = str(e)
    return out
