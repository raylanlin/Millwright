"""sw_agent.tools.diagnose — report what this SolidWorks install actually supports.

Every hard bug in this project has been an API that is present on paper and missing in
practice: GetBodies2 declared on the wrong interface, ICurve unreachable, the type
library refusing to generate, edges hanging off loops rather than faces. Each one
surfaced as a misleading downstream error and cost a round of guessing to trace back.

This tool asks the questions directly, so the answer is one call instead of an
afternoon: is the early-binding cache there, can bodies/faces/edges be read, which
edge-selection strategy works here, which feature-creation route is available.
"""
from __future__ import annotations

from sw_agent.bridge import Context, sw_get
from sw_agent.registry import tool


@tool(
    "sw_diagnostics",
    "Report which SolidWorks APIs are actually reachable on this machine (type-library "
    "cache, body/face/edge access, edge-selection strategy, feature-creation route). "
    "Call this when a tool fails in a way that does not match the model — it turns a "
    "guessing game into one answer",
    params={},
    category="query",
)
def sw_diagnostics(ctx: Context):
    out: dict = {}

    # 1. Early-binding cache. Reporting only true/false was not enough — when it came
    #    back false there was no way to tell WHICH generation route failed or why.
    from sw_agent.typelib import feature_id, typelib_state
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
        out["geometry"] = {
            "faces": len(faces or []),
            "edges": len(edges or []),
            "route": trace[-2:] if trace else [],
        }
    except Exception as e:  # noqa: BLE001
        out["geometry"] = {"error": str(e)}

    # 3. Which edge-selection STRATEGY works here.
    #
    #    This replaces three earlier fields (edge_kinds / edge_kinds_by_faces /
    #    select_by_box) that each answered a fragment of the question and none of which
    #    said what to do next. Running the strategies for real and reporting the counts
    #    is the only report that settles it: a non-zero number means that strategy can
    #    pick those edges on this machine, today, on this model.
    try:
        from sw_agent.edge_select import probe
        out["edge_strategies"] = probe(ctx)
    except Exception as e:  # noqa: BLE001
        out["edge_strategies"] = {"error": str(e)}

    # 4. Which feature APIs exist at all
    try:
        fm = ctx.feat_mgr
        out["feature_api"] = {
            name: hasattr(fm, name)
            for name in ("CreateDefinition", "CreateFeature", "FeatureCut4",
                         "FeatureCut3", "FeatureExtrusion3", "FeatureFillet3")
        }
    except Exception as e:  # noqa: BLE001
        out["feature_api"] = {"error": str(e)}

    # 5. Document / sketch state — a stale active sketch explains a lot of odd failures
    try:
        active = ctx.sketch_mgr.ActiveSketch
        out["sketch"] = {
            "active": None if active is None else sw_get(active, "Name"),
            "last_recorded": ctx.scratch.get("last_sketch"),
            "last_feature": ctx.scratch.get("last_feature"),
        }
    except Exception as e:  # noqa: BLE001
        out["sketch"] = {"error": str(e)}

    return out
