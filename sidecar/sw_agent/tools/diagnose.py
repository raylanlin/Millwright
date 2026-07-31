"""sw_agent.tools.diagnose — report what this SolidWorks install actually supports.

Every hard bug in this project has been an API that is present on paper and missing in
practice: GetBodies2 declared on the wrong interface, ICurve unreachable, the type
library refusing to generate. Each one surfaced as a misleading downstream error and
took a round of guessing to trace back.

This tool asks the questions directly, so the answer is one call instead of an
afternoon: is the early-binding cache there, can bodies/faces/edges be read, which
feature-creation route is available.
"""
from __future__ import annotations

from ..bridge import Context, sw_get
from ..registry import tool


@tool(
    "sw_diagnostics",
    "Report which SolidWorks APIs are actually reachable on this machine (type-library "
    "cache, body/face/edge access, feature-creation route). Call this when a tool fails "
    "in a way that does not match the model — it turns a guessing game into one answer",
    params={},
    category="query",
)
def sw_diagnostics(ctx: Context):
    out: dict = {}

    # 1. Early-binding cache. Reporting only true/false was not enough — when it came
    #    back false there was no way to tell WHICH of the three generation routes failed
    #    or why, so the trace is included now.
    from ..typelib import feature_id, typelib_state
    try:
        import win32com.client as wc
        dicts = getattr(wc.constants, "__dicts__", None)
        loaded = bool(dicts) and any(dicts)
    except Exception as e:  # noqa: BLE001
        loaded, dicts = False, None
        out["typelib_error"] = str(e)

    state = typelib_state()
    ids = {k: feature_id(k) for k in ("extrusion", "cut", "fillet", "revolve", "shell")}
    # The hard-coded enum table is what actually decides whether the clean creation route
    # is usable; the type library is only one way of obtaining those numbers.
    definition_ok = ids.get("cut") is not None
    out["typelib"] = {
        "constants_loaded": loaded,
        "enum_ids_available": definition_ok,
        "tried": state.get("tried", []),
        "note": (
            "ok — constants loaded from the type library" if loaded
            else "the type library is not generated, which is FINE: the built-in enum table "
                 "supplies the same values, so CreateDefinition is usable. Generation is "
                 "deliberately not attempted at startup (it starved the COM connection)" if definition_ok
            else "NEITHER the type library nor the enum table is available — cut/fillet "
                 "must fall back to argument-count search"
        ),
    }
    out["feature_ids"] = ids

    # 2. Geometry access
    try:
        faces, edges, trace = ctx.geometry()
        kinds: dict = {}
        for e in (edges or [])[:40]:
            kind, _info = ctx._edge_kind(e)
            kinds[kind or "unclassified"] = kinds.get(kind or "unclassified", 0) + 1
        out["geometry"] = {
            "faces": len(faces or []),
            "edges": len(edges or []),
            "edge_kinds": kinds,
            "route": trace[-2:] if trace else [],
        }
        # P82: face-membership classification runs in parallel — if this machine
        # answers but edge-geometry routes do not, edge_kinds_by_faces will say so.
        try:
            by_faces = ctx._classify_by_faces()
            out["geometry"]["edge_kinds_by_faces"] = {
                k: len(v) for k, v in by_faces.items() if v
            }
        except Exception as e:  # noqa: BLE001
            out["geometry"]["edge_kinds_by_faces_error"] = str(e)
    except Exception as e:  # noqa: BLE001
        out["geometry"] = {"error": str(e)}

    # 3. Which feature APIs exist at all
    try:
        fm = ctx.feat_mgr
        out["feature_api"] = {
            name: hasattr(fm, name)
            for name in ("CreateDefinition", "CreateFeature", "FeatureCut4",
                         "FeatureCut3", "FeatureExtrusion3", "FeatureFillet3")
        }
    except Exception as e:  # noqa: BLE001
        out["feature_api"] = {"error": str(e)}

    # 4. Document / sketch state — a stale active sketch explains a lot of odd failures
    try:
        active = ctx.sketch_mgr.ActiveSketch
        out["sketch"] = {
            "active": None if active is None else sw_get(active, "Name"),
            "last_recorded": ctx.scratch.get("last_sketch"),
        }
    except Exception as e:  # noqa: BLE001
        out["sketch"] = {"error": str(e)}

    return out
