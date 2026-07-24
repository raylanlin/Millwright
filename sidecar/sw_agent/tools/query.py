"""sw_agent.tools.query — observe/analyze: return SolidWorks state as structured JSON to the agent.

This is the hallmark of a "mature agent": no more MsgBox popups — return
structured data so the model can read the current feature tree / dimensions
/ mass / interferences, and plan and self-correct from there.

P16: no-arg SW getters (GetPathName / IsSuppressed / GetTypeName2 / Volume /
GetInterferences / ...) are propget under early binding on many SW versions —
calling them with () raised "'str'/'tuple'/'bool' object is not callable".
All such reads now go through bridge.sw_get(), and traversals are wrapped so
one finicky member can't abort the whole query. mass_properties falls back to
CreateMassProperty2 when CreateMassProperty is member-not-found.
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError, DOC_ASSEMBLY, DOC_PART, sw_get
from .. import units


@tool("mass_properties", "Get mass properties (mass / volume / surface area / center of mass)", params={}, category="query")
def mass_properties(ctx: Context):
    ext = ctx.model.Extension
    mp = None
    for maker in ("CreateMassProperty", "CreateMassProperty2"):
        try:
            fn = getattr(ext, maker, None)
            if fn is None:
                continue
            mp = fn() if callable(fn) else fn
            if mp is not None:
                break
        except Exception:  # noqa: BLE001 — try the next API name (version differences)
            continue
    if mp is None:
        raise SWError("unable to create mass property object (CreateMassProperty/2 unavailable).")
    cog = sw_get(mp, "CenterOfMass")  # [x,y,z] in meters
    return {
        "mass_kg": round(sw_get(mp, "Mass"), 6),
        "volume_mm3": round(units.m3_to_mm3(sw_get(mp, "Volume")), 3),
        "surface_area_mm2": round(sw_get(mp, "SurfaceArea") * 1.0e6, 3),
        "center_of_mass_mm": [round(units.m_to_mm(c), 3) for c in cog],
    }


@tool("bounding_box", "Get the part bounding-box dimensions (length x width x height, mm)", params={}, category="query")
def bounding_box(ctx: Context):
    part = ctx.require(DOC_PART, "part")
    box = part.GetPartBox(True)  # (x1,y1,z1,x2,y2,z2) in meters — takes an arg, real method
    if not box:
        raise SWError("unable to retrieve bounding box.")
    dx = units.m_to_mm(abs(box[3] - box[0]))
    dy = units.m_to_mm(abs(box[4] - box[1]))
    dz = units.m_to_mm(abs(box[5] - box[2]))
    return {"length_mm": round(dx, 3), "width_mm": round(dy, 3), "height_mm": round(dz, 3)}


@tool("list_features", "List the feature tree (name/type/suppressed) — helps you understand the model structure and plan next steps",
      params={"limit": {"type": "number", "desc": "Maximum number of items to return", "default": 100}},
      category="query")
def list_features(ctx: Context, limit: int = 100):
    # P32: IFeatureManager.GetFeatures instead of linked-list traversal
    # (the linked-list API is member-not-found over COM on some installs).
    out = []
    feats = list(ctx.model.FeatureManager.GetFeatures(True) or [])
    for feat in feats:
        if len(out) >= int(limit):
            break
        try:
            tn = sw_get(feat, "GetTypeName2")
        except Exception:  # noqa: BLE001
            try:
                tn = sw_get(feat, "GetTypeName")
            except Exception:  # noqa: BLE001
                tn = ""
        if tn in ("HistoryFolder", "SensorFolder", "DocsFolder", "DetailCabinet"):
            continue
        try:
            out.append({
                "name": sw_get(feat, "Name"),
                "type": tn,
                "suppressed": bool(sw_get(feat, "IsSuppressed")),
            })
        except Exception:  # noqa: BLE001 — skip a feature whose members won't read
            continue
    return {"count": len(out), "features": out}


@tool("list_components", "List assembly components (name/file/suppressed)",
      params={"limit": {"type": "number", "desc": "Maximum number of items to return", "default": 200}},
      category="query")
def list_components(ctx: Context, limit: int = 200):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    comps = asm.GetComponents(True)  # arg-taking → real method
    out = []
    for c in (comps or []):
        if len(out) >= int(limit):
            break
        try:
            path = sw_get(c, "GetPathName") or ""
            out.append({
                "name": sw_get(c, "Name2"),
                "file": path.split("\\")[-1] if path else "",
                "suppressed": bool(sw_get(c, "IsSuppressed")),
            })
        except Exception:  # noqa: BLE001 — skip an unreadable component rather than abort the whole list
            continue
    return {"count": len(out), "components": out}


@tool("check_interference", "Run interference check on the assembly; return interference pairs and volumes", params={}, category="query")
def check_interference(ctx: Context):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    mgr = asm.InterferenceDetectionManager
    try:
        mgr.TreatCoincidenceAsInterference = False
        mgr.IncludeMultibodyPartInterferences = True
    except Exception:  # noqa: BLE001 — setter differences across versions are non-fatal
        pass
    inters = sw_get(mgr, "GetInterferences")
    if not inters:
        return {"count": 0, "interferences": []}
    out = []
    for i, inter in enumerate(inters):
        if i >= 50:
            break
        try:
            comps = sw_get(inter, "Components") or []
            out.append({
                "pair": [sw_get(c, "Name2") for c in comps],
                "volume_mm3": round(units.m3_to_mm3(sw_get(inter, "Volume")), 3),
            })
        except Exception:  # noqa: BLE001
            continue
    return {"count": len(out), "interferences": out}


@tool("get_custom_properties", "Read the custom properties of the current document", params={}, category="query")
def get_custom_properties(ctx: Context):
    mgr = ctx.model.Extension.CustomPropertyManager("")
    names = sw_get(mgr, "GetNames") or []
    props = {}
    for n in names:
        r = mgr.Get5(n, False)  # arg-taking method; -> (valOut, resolvedOut, wasResolved, ...) depends on version
        val = ""
        if isinstance(r, tuple):
            val = (r[1] or r[0]) if len(r) > 1 else r[0]
        props[n] = val
    return {"count": len(props), "properties": props}


@tool("measure_selection", "Measure the currently selected entities (distance/length/area, etc.) — select entities in SolidWorks first",
      params={}, category="query")
def measure_selection(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError("please select entities to measure in SolidWorks first.")
    m = ctx.model.Extension.CreateMeasure()
    if m is None or not m.Calculate(None):
        raise SWError("measurement failed.")
    out = {}
    try:
        if sw_get(m, "Distance") >= 0:
            out["distance_mm"] = round(units.m_to_mm(sw_get(m, "Distance")), 3)
    except Exception:  # noqa: BLE001
        pass
    for attr, key, scale in (("Length", "length_mm", 1e3), ("Area", "area_mm2", 1e6),
                             ("TotalArea", "total_area_mm2", 1e6)):
        try:
            v = sw_get(m, attr)
            if v and v > 0:
                out[key] = round(v * scale, 3)
        except Exception:  # noqa: BLE001
            pass
    return out or {"note": "measured, but the current selection produced no readable values"}
