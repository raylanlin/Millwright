"""sw_agent.tools.query — observe/analyze: return SolidWorks state as structured JSON to the agent.

P16: no-arg SW getters are propget under early binding on many SW versions — all reads go
through bridge.sw_get(). P127: check_interference releases the InterferenceDetectionManager
(Done()) — upstream pitfall: without Done() the manager stays armed and the next call
returns stale/empty results; also reads counts via GetInterferenceCount when GetInterferences
comes back None (late-binding out-param shape).
"""
from __future__ import annotations

from sw_agent import units
from sw_agent.bridge import DOC_ASSEMBLY, DOC_PART, Context, SWError, sw_get
from sw_agent.registry import tool


@tool("mass_properties", "Get mass properties: mass / volume / surface area / center of mass (= Mass Properties; Extension.CreateMassProperty)", params={}, category="query")
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


@tool("bounding_box", "Get the part bounding-box dimensions in mm (GetPartBox)", params={}, category="query")
def bounding_box(ctx: Context):
    part = ctx.require(DOC_PART, "part")
    box = part.GetPartBox(True)  # (x1,y1,z1,x2,y2,z2) in meters — takes an arg, real method
    if not box:
        raise SWError("unable to retrieve bounding box.")
    dx = units.m_to_mm(abs(box[3] - box[0]))
    dy = units.m_to_mm(abs(box[4] - box[1]))
    dz = units.m_to_mm(abs(box[5] - box[2]))
    return {"length_mm": round(dx, 3), "width_mm": round(dy, 3), "height_mm": round(dz, 3)}


# P127: tree nodes that carry no design intent (SolidPilot's NoiseFeatureTypes idea)
_NOISE = {
    "HistoryFolder", "SensorFolder", "DocsFolder", "DetailCabinet", "MaterialFolder",
    "CommentsFolder", "SolidBodyFolder", "SurfaceBodyFolder", "EnvFolder", "FavoriteFolder",
    "SelectionSetFolder", "AmbientLight", "DirectionLight", "PointLight", "SpotLight",
    "LiveSectionFolder", "MarkupFolder", "EqnFolder", "BlockFolder", "NotesAreaFolder",
}


@tool("list_features", "List the feature tree: name/type/suppressed (FeatureManager.GetFeatures). Read this before renaming, patterning or mirroring — it gives you the EXACT feature names, which a macro would have to guess",
      params={"limit": {"type": "number", "desc": "Maximum number of items to return", "default": 100},
              "include_noise": {"type": "boolean", "desc": "Also list folders/lights/origin and other non-design nodes", "default": False}},
      category="query")
def list_features(ctx: Context, limit: int = 100, include_noise: bool = False):
    out = []
    feats = ctx.all_features()
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
        if not include_noise and tn in _NOISE:
            continue
        try:
            item = {"name": sw_get(feat, "Name"), "type": tn, "suppressed": bool(sw_get(feat, "IsSuppressed"))}
            try:
                code = int(feat.GetErrorCode2(True))
                if code:
                    item["error_code"] = code
            except Exception:  # noqa: BLE001
                pass
            out.append(item)
        except Exception:  # noqa: BLE001 — skip a feature whose members won't read
            continue
    return {"count": len(out), "features": out}


@tool("list_components", "List assembly components: name/file/suppressed (GetComponents). Gives the exact Name2 strings — never guess a component name",
      params={"limit": {"type": "number", "desc": "Maximum number of items to return", "default": 200}},
      category="query")
def list_components(ctx: Context, limit: int = 200):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    comps = asm.GetComponents(True)
    out = []
    for c in (comps or []):
        if len(out) >= int(limit):
            break
        try:
            path = sw_get(c, "GetPathName") or ""
            item = {
                "name": sw_get(c, "Name2"),
                "file": path.split("\\")[-1] if path else "",
                "suppressed": bool(sw_get(c, "IsSuppressed")),
            }
            # P127: position in assembly space (mm) — add_mate verification and the model both need it
            try:
                d = c.Transform2.ArrayData
                item["position_mm"] = [round(float(d[9]) * 1000, 3), round(float(d[10]) * 1000, 3), round(float(d[11]) * 1000, 3)]
            except Exception:  # noqa: BLE001
                pass
            out.append(item)
        except Exception:  # noqa: BLE001
            continue
    return {"count": len(out), "components": out}


@tool("check_interference", "Run interference detection on the assembly (= Interference Detection; InterferenceDetectionManager); returns pairs and volumes", params={}, category="query")
def check_interference(ctx: Context):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    mgr = asm.InterferenceDetectionManager
    try:
        mgr.TreatCoincidenceAsInterference = False
        mgr.IncludeMultibodyPartInterferences = True
    except Exception:  # noqa: BLE001 — setter differences across versions are non-fatal
        pass
    out = []
    try:
        inters = None
        try:
            inters = sw_get(mgr, "GetInterferences")
        except Exception:  # noqa: BLE001
            inters = None
        if not inters:
            # late binding: GetInterferences may hand back None while the count is real
            try:
                n = int(sw_get(mgr, "GetInterferenceCount"))
            except Exception:  # noqa: BLE001
                n = 0
            if n == 0:
                return {"count": 0, "interferences": []}
            return {"count": n, "interferences": [], "note": "count only — GetInterferences returned no objects on this install"}
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
    finally:
        # P127: release the manager — an armed IDM makes the NEXT detection return stale results
        try:
            mgr.Done()
        except Exception:  # noqa: BLE001
            pass
    return {"count": len(out), "interferences": out}


@tool("get_custom_properties", "Read the custom properties of the current document", params={}, category="query")
def get_custom_properties(ctx: Context):
    mgr = ctx.model.Extension.CustomPropertyManager("")
    names = sw_get(mgr, "GetNames") or []
    props = {}
    for n in names:
        r = mgr.Get5(n, False)
        val = ""
        if isinstance(r, tuple):
            val = (r[1] or r[0]) if len(r) > 1 else r[0]
        props[n] = val
    return {"count": len(props), "properties": props}


@tool("measure_selection", "Measure the currently selected entities (distance/length/area, etc.) — select entities in SolidWorks first (or use select_entities)",
      params={}, category="query")
def measure_selection(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError("please select entities to measure in SolidWorks first (or call select_entities).")
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
