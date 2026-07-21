"""sw_agent.tools.query — observe/analyze: return SolidWorks state as structured JSON to the agent.

This is the hallmark of a "mature agent": no more MsgBox popups — return
structured data so the model can read the current feature tree / dimensions
/ mass / interferences, and plan and self-correct from there.
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError, DOC_ASSEMBLY, DOC_PART
from .. import units


@tool("mass_properties", "Get mass properties (mass / volume / surface area / center of mass)", params={}, category="query")
def mass_properties(ctx: Context):
    mp = ctx.model.Extension.CreateMassProperty()
    if mp is None:
        raise SWError("unable to create mass property object.")
    cog = mp.CenterOfMass  # [x,y,z] in meters
    return {
        "mass_kg": round(mp.Mass, 6),
        "volume_mm3": round(units.m3_to_mm3(mp.Volume), 3),
        "surface_area_mm2": round(mp.SurfaceArea * 1.0e6, 3),
        "center_of_mass_mm": [round(units.m_to_mm(c), 3) for c in cog],
    }


@tool("bounding_box", "Get the part bounding-box dimensions (length x width x height, mm)", params={}, category="query")
def bounding_box(ctx: Context):
    part = ctx.require(DOC_PART, "part")
    box = part.GetPartBox(True)  # (x1,y1,z1,x2,y2,z2) in meters
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
    out = []
    feat = ctx.model.FirstFeature()
    while feat is not None and len(out) < int(limit):
        tn = feat.GetTypeName2()
        if tn not in ("HistoryFolder", "SensorFolder", "DocsFolder", "DetailCabinet"):
            out.append({"name": feat.Name, "type": tn, "suppressed": bool(feat.IsSuppressed())})
        feat = feat.GetNextFeature()
    return {"count": len(out), "features": out}


@tool("list_components", "List assembly components (name/file/suppressed)",
      params={"limit": {"type": "number", "desc": "Maximum number of items to return", "default": 200}},
      category="query")
def list_components(ctx: Context, limit: int = 200):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    comps = asm.GetComponents(True)
    out = []
    for c in (comps or []):
        if len(out) >= int(limit):
            break
        path = c.GetPathName() or ""
        out.append({
            "name": c.Name2,
            "file": path.split("\\")[-1] if path else "",
            "suppressed": bool(c.IsSuppressed()),
        })
    return {"count": len(out), "components": out}


@tool("check_interference", "Run interference check on the assembly; return interference pairs and volumes", params={}, category="query")
def check_interference(ctx: Context):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    mgr = asm.InterferenceDetectionManager
    mgr.TreatCoincidenceAsInterference = False
    mgr.IncludeMultibodyPartInterferences = True
    inters = mgr.GetInterferences()
    if not inters:
        return {"count": 0, "interferences": []}
    out = []
    for i, inter in enumerate(inters):
        if i >= 50:
            break
        comps = inter.Components or []
        out.append({
            "pair": [c.Name2 for c in comps],
            "volume_mm3": round(units.m3_to_mm3(inter.Volume), 3),
        })
    return {"count": len(out), "interferences": out}


@tool("get_custom_properties", "Read the custom properties of the current document", params={}, category="query")
def get_custom_properties(ctx: Context):
    mgr = ctx.model.Extension.CustomPropertyManager("")
    names = mgr.GetNames() or []
    props = {}
    for n in names:
        r = mgr.Get5(n, False)  # -> (valOut, resolvedOut, wasResolved, ...) depends on version
        val = ""
        if isinstance(r, tuple):
            # Prefer the "resolved" value (usually index 1), falling back to the raw value
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
        if m.Distance >= 0:
            out["distance_mm"] = round(units.m_to_mm(m.Distance), 3)
    except Exception:  # noqa: BLE001
        pass
    for attr, key, scale in (("Length", "length_mm", 1e3), ("Area", "area_mm2", 1e6),
                             ("TotalArea", "total_area_mm2", 1e6)):
        try:
            v = getattr(m, attr)
            if v and v > 0:
                out[key] = round(v * scale, 3)
        except Exception:  # noqa: BLE001
            pass
    return out or {"note": "measured, but the current selection produced no readable values"}
