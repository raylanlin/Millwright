"""sw_agent.tools.query —— 观测/分析：把 SolidWorks 状态以结构化 JSON 返回给 agent。

这是“成熟 agent”的关键：不再弹 MsgBox，而是返回结构化数据，
让模型能读到当前特征树/尺寸/质量/干涉，从而规划与自我纠错。
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError, DOC_ASSEMBLY, DOC_PART
from .. import units


@tool("mass_properties", "获取质量属性（质量/体积/表面积/重心）", params={}, category="query")
def mass_properties(ctx: Context):
    mp = ctx.model.Extension.CreateMassProperty()
    if mp is None:
        raise SWError("无法创建质量属性对象。")
    cog = mp.CenterOfMass  # [x,y,z] 米
    return {
        "mass_kg": round(mp.Mass, 6),
        "volume_mm3": round(units.m3_to_mm3(mp.Volume), 3),
        "surface_area_mm2": round(mp.SurfaceArea * 1.0e6, 3),
        "center_of_mass_mm": [round(units.m_to_mm(c), 3) for c in cog],
    }


@tool("bounding_box", "获取零件包络尺寸（长×宽×高，mm）", params={}, category="query")
def bounding_box(ctx: Context):
    part = ctx.require(DOC_PART, "零件")
    box = part.GetPartBox(True)  # (x1,y1,z1,x2,y2,z2) 米
    if not box:
        raise SWError("无法获取包络盒。")
    dx = units.m_to_mm(abs(box[3] - box[0]))
    dy = units.m_to_mm(abs(box[4] - box[1]))
    dz = units.m_to_mm(abs(box[5] - box[2]))
    return {"length_mm": round(dx, 3), "width_mm": round(dy, 3), "height_mm": round(dz, 3)}


@tool("list_features", "列出特征树（名称/类型/是否压缩）——供你了解模型结构、规划下一步",
      params={"limit": {"type": "number", "desc": "最多返回条数", "default": 100}},
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


@tool("list_components", "列出装配体零部件（名称/文件/是否压缩）",
      params={"limit": {"type": "number", "desc": "最多返回条数", "default": 200}},
      category="query")
def list_components(ctx: Context, limit: int = 200):
    asm = ctx.require(DOC_ASSEMBLY, "装配体")
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


@tool("check_interference", "装配体干涉检查，返回干涉对与体积", params={}, category="query")
def check_interference(ctx: Context):
    asm = ctx.require(DOC_ASSEMBLY, "装配体")
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


@tool("get_custom_properties", "读取当前文档的自定义属性", params={}, category="query")
def get_custom_properties(ctx: Context):
    mgr = ctx.model.Extension.CustomPropertyManager("")
    names = mgr.GetNames() or []
    props = {}
    for n in names:
        r = mgr.Get5(n, False)  # -> (valOut, resolvedOut, wasResolved, ...) 视版本
        val = ""
        if isinstance(r, tuple):
            # 取“解析后”的值（一般第 2 个），退回原始值
            val = (r[1] or r[0]) if len(r) > 1 else r[0]
        props[n] = val
    return {"count": len(props), "properties": props}


@tool("measure_selection", "测量当前选中实体（距离/长度/面积等）——需先在 SW 里选好",
      params={}, category="query")
def measure_selection(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError("请先在 SolidWorks 里选中要测量的实体。")
    m = ctx.model.Extension.CreateMeasure()
    if m is None or not m.Calculate(None):
        raise SWError("测量失败。")
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
    return out or {"note": "已测量，但当前选择无可读数值"}
