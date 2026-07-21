"""sw_agent.tools.reference —— 参考几何：基准面 / 基准轴 / 参考点。"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError
from .. import units


@tool(
    "create_plane", "创建偏移基准面（相对标准面偏移一段距离）",
    params={
        "base": {"type": "string", "enum": ["front", "top", "right"], "desc": "基准面"},
        "offset": {"type": "number", "desc": "偏移距离(mm)"},
    },
    category="reference",
)
def create_plane(ctx: Context, base: str, offset: float):
    ctx.clear_selection()
    if not ctx.select_plane(base):
        raise SWError(f"选择基准面失败：{base}")
    # InsertRefPlane(firstConstraint, firstVal, second, secondVal, third, thirdVal)
    # 8 = swRefPlaneReferenceConstraint_Distance
    feat = ctx.feat_mgr.InsertRefPlane(8, units.mm(offset), 0, 0, 0, 0)
    if feat is None:
        raise SWError("创建基准面失败。")
    return {"plane": feat.Name, "base": base, "offset_mm": offset}


@tool(
    "create_axis", "用当前选中的参考（两平面 / 圆柱面 / 两点等）创建基准轴（需先在 SW 里选好参考）",
    params={},
    category="reference",
)
def create_axis(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError("请先选中创建基准轴所需的参考（如两个平面、或一个圆柱面）。")
    # InsertAxis2(True) 用当前选择创建
    ok = ctx.model.InsertAxis2(True)
    if not ok:
        raise SWError("创建基准轴失败，请检查所选参考是否有效。")
    return {"axis_created": True}


@tool(
    "create_reference_point", "在选中的顶点/边等参考上创建参考点（需先在 SW 里选好参考）",
    params={
        "point_type": {"type": "string",
                       "enum": ["arc_center", "end", "center_of_face", "intersection"],
                       "desc": "参考点类型", "default": "end"},
    },
    category="reference",
)
def create_reference_point(ctx: Context, point_type: str = "end"):
    if ctx.selected_count() < 1:
        raise SWError("请先选中创建参考点所需的参考实体。")
    # swRefPointType_e: arc_center=1, end=3, center_of_face=4, intersection=2
    t = {"arc_center": 1, "intersection": 2, "end": 3, "center_of_face": 4}.get(point_type, 3)
    feat = ctx.feat_mgr.InsertReferencePoint(t, 0, 0, 1)  # VERIFY: 参数跨版本可能不同
    if feat is None:
        raise SWError("创建参考点失败。")
    return {"point": feat.Name, "type": point_type}
