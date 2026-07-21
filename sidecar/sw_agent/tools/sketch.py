"""sw_agent.tools.sketch —— 草图：进入/退出 + 图元 + 关系/尺寸。

坐标/尺寸入参一律 mm，内部 units.mm() 转米。多数图元方法（CreateCornerRectangle /
CreateCircle / CreateLine / CreateArc / CreatePolygon）跨版本稳定，签名明确。
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError
from .. import units


def _require_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is None:
        raise SWError("当前不在草图中，请先 start_sketch。")


@tool(
    "start_sketch", "在指定基准面新建草图并进入编辑",
    params={"plane": {"type": "string", "enum": ["front", "top", "right"], "desc": "基准面"}},
    category="sketch",
)
def start_sketch(ctx: Context, plane: str):
    ctx.clear_selection()
    if not ctx.select_plane(plane):
        raise SWError(f"选择基准面失败：{plane}")
    ctx.sketch_mgr.InsertSketch(True)
    return {"sketch_on": plane}


@tool("exit_sketch", "退出当前草图", params={}, category="sketch")
def exit_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is not None:
        ctx.sketch_mgr.InsertSketch(True)
    return {"exited": True}


@tool(
    "sketch_rectangle", "画矩形（左下角 + 宽高）",
    params={
        "x": {"type": "number", "desc": "左下角X(mm)", "default": 0},
        "y": {"type": "number", "desc": "左下角Y(mm)", "default": 0},
        "width": {"type": "number", "desc": "宽(mm)"},
        "height": {"type": "number", "desc": "高(mm)"},
    },
    category="sketch",
)
def sketch_rectangle(ctx: Context, width: float, height: float, x: float = 0, y: float = 0):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCornerRectangle(
        units.mm(x), units.mm(y), 0, units.mm(x + width), units.mm(y + height), 0
    )
    return {"rectangle": {"x": x, "y": y, "w": width, "h": height}}


@tool(
    "sketch_circle", "画圆（圆心 + 半径）",
    params={
        "x": {"type": "number", "desc": "圆心X(mm)", "default": 0},
        "y": {"type": "number", "desc": "圆心Y(mm)", "default": 0},
        "radius": {"type": "number", "desc": "半径(mm)"},
    },
    category="sketch",
)
def sketch_circle(ctx: Context, radius: float, x: float = 0, y: float = 0):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCircle(units.mm(x), units.mm(y), 0, units.mm(x + radius), units.mm(y), 0)
    return {"circle": {"x": x, "y": y, "r": radius}}


@tool(
    "sketch_line", "画直线段",
    params={
        "x1": {"type": "number", "desc": "起点X(mm)"}, "y1": {"type": "number", "desc": "起点Y(mm)"},
        "x2": {"type": "number", "desc": "终点X(mm)"}, "y2": {"type": "number", "desc": "终点Y(mm)"},
    },
    category="sketch",
)
def sketch_line(ctx: Context, x1: float, y1: float, x2: float, y2: float):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateLine(units.mm(x1), units.mm(y1), 0, units.mm(x2), units.mm(y2), 0)
    return {"line": [x1, y1, x2, y2]}


@tool(
    "sketch_centerline", "画中心线（旋转/镜像用）",
    params={
        "x1": {"type": "number", "desc": "起点X(mm)"}, "y1": {"type": "number", "desc": "起点Y(mm)"},
        "x2": {"type": "number", "desc": "终点X(mm)"}, "y2": {"type": "number", "desc": "终点Y(mm)"},
    },
    category="sketch",
)
def sketch_centerline(ctx: Context, x1: float, y1: float, x2: float, y2: float):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCenterLine(units.mm(x1), units.mm(y1), 0, units.mm(x2), units.mm(y2), 0)
    return {"centerline": [x1, y1, x2, y2]}


@tool(
    "sketch_arc_center", "画圆心弧（圆心+起点+终点+方向）",
    params={
        "cx": {"type": "number", "desc": "圆心X(mm)"}, "cy": {"type": "number", "desc": "圆心Y(mm)"},
        "sx": {"type": "number", "desc": "起点X(mm)"}, "sy": {"type": "number", "desc": "起点Y(mm)"},
        "ex": {"type": "number", "desc": "终点X(mm)"}, "ey": {"type": "number", "desc": "终点Y(mm)"},
        "direction": {"type": "number", "desc": "1 逆时针 / -1 顺时针", "default": 1},
    },
    category="sketch",
)
def sketch_arc_center(ctx, cx, cy, sx, sy, ex, ey, direction=1):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateArc(
        units.mm(cx), units.mm(cy), 0,
        units.mm(sx), units.mm(sy), 0,
        units.mm(ex), units.mm(ey), 0, int(direction),
    )
    return {"arc_center": [cx, cy], "start": [sx, sy], "end": [ex, ey]}


@tool(
    "sketch_polygon", "画正多边形",
    params={
        "cx": {"type": "number", "desc": "中心X(mm)", "default": 0},
        "cy": {"type": "number", "desc": "中心Y(mm)", "default": 0},
        "radius": {"type": "number", "desc": "外接/内切半径(mm)"},
        "sides": {"type": "number", "desc": "边数"},
        "inscribed": {"type": "boolean", "desc": "True 内切 / False 外接", "default": True},
    },
    category="sketch",
)
def sketch_polygon(ctx, radius, sides, cx=0, cy=0, inscribed=True):
    _require_sketch(ctx)
    # CreatePolygon(cx,cy,cz, xp,yp,zp, sides, inscribed)
    ctx.sketch_mgr.CreatePolygon(
        units.mm(cx), units.mm(cy), 0,
        units.mm(cx + radius), units.mm(cy), 0, int(sides), bool(inscribed),
    )
    return {"polygon": {"center": [cx, cy], "r": radius, "sides": int(sides)}}


@tool(
    "sketch_fillet", "对当前草图中已选中的两条草图线段倒圆角（需先在 SW 里选中两段）",
    params={"radius": {"type": "number", "desc": "圆角半径(mm)"}},
    category="sketch",
)
def sketch_fillet(ctx: Context, radius: float):
    _require_sketch(ctx)
    if ctx.selected_count() < 1:
        raise SWError("请先选中要倒圆角的两条草图线段。")
    # CreateFillet(radius, constrainCorners) 2=swConstrainCorners_Keep
    ctx.sketch_mgr.CreateFillet(units.mm(radius), 2)
    return {"sketch_fillet_r": radius}


@tool(
    "add_sketch_relation", "给已选中的草图实体添加几何关系",
    params={"relation": {"type": "string",
                        "enum": ["horizontal", "vertical", "coincident", "parallel",
                                 "perpendicular", "tangent", "equal", "concentric", "symmetric"],
                        "desc": "关系类型"}},
    category="sketch",
)
def add_sketch_relation(ctx: Context, relation: str):
    if ctx.selected_count() < 1:
        raise SWError("请先选中要添加关系的草图实体。")
    key = {
        "horizontal": "sgHORIZONTAL2D", "vertical": "sgVERTICAL2D",
        "coincident": "sgCOINCIDENT", "parallel": "sgPARALLEL",
        "perpendicular": "sgPERPENDICULAR", "tangent": "sgTANGENT",
        "equal": "sgEQUAL", "concentric": "sgCONCENTRIC", "symmetric": "sgSYMMETRIC",
    }.get(relation)
    if not key:
        raise SWError(f"未知关系：{relation}")
    ctx.model.SketchAddConstraints(key)
    return {"relation": relation}


@tool(
    "add_dimension", "在指定位置为已选中的实体添加驱动尺寸",
    params={
        "x": {"type": "number", "desc": "标注放置X(mm)"},
        "y": {"type": "number", "desc": "标注放置Y(mm)"},
        "value": {"type": "number", "desc": "尺寸值(mm)，省略则用当前几何值", "default": 0},
    },
    category="sketch",
)
def add_dimension(ctx: Context, x: float, y: float, value: float = 0):
    if ctx.selected_count() < 1:
        raise SWError("请先选中要标注的实体。")
    disp = ctx.model.AddDimension2(units.mm(x), units.mm(y), 0)
    if disp is None:
        raise SWError("添加尺寸失败。")
    if value:
        d = disp.GetDimension2(0) if hasattr(disp, "GetDimension2") else disp.GetDimension()
        d.SetSystemValue3(units.mm(value), 1, None)  # 1 = 所有配置
        ctx.rebuild()
    return {"dimension_at": [x, y], "value_mm": value or None}
