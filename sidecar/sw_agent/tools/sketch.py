"""sw_agent.tools.sketch — sketch: enter/exit + entities + relations/dimensions.

All coordinate / dimension inputs are in mm; internally units.mm() converts
to meters. Most entity methods (CreateCornerRectangle / CreateCircle /
CreateLine / CreateArc / CreatePolygon) are stable across SolidWorks
versions with well-defined signatures.
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError
from .. import units


def _require_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is None:
        raise SWError("not currently editing a sketch; call start_sketch first.")


@tool(
    "start_sketch", "Start a new sketch on the specified reference plane and enter edit mode",
    params={"plane": {"type": "string", "enum": ["front", "top", "right"], "desc": "Reference plane"}},
    category="sketch",
)
def start_sketch(ctx: Context, plane: str):
    ctx.clear_selection()
    if not ctx.select_plane(plane):
        raise SWError(f"failed to select reference plane: {plane}")
    ctx.sketch_mgr.InsertSketch(True)
    return {"sketch_on": plane}


@tool("exit_sketch", "Exit the current sketch", params={}, category="sketch")
def exit_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is not None:
        ctx.sketch_mgr.InsertSketch(True)
    return {"exited": True}


@tool(
    "sketch_rectangle", "Draw a rectangle (lower-left corner + width/height)",
    params={
        "x": {"type": "number", "desc": "Lower-left X (mm)", "default": 0},
        "y": {"type": "number", "desc": "Lower-left Y (mm)", "default": 0},
        "width": {"type": "number", "desc": "Width (mm)"},
        "height": {"type": "number", "desc": "Height (mm)"},
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
    "sketch_circle", "Draw a circle (center + radius)",
    params={
        "x": {"type": "number", "desc": "Center X (mm)", "default": 0},
        "y": {"type": "number", "desc": "Center Y (mm)", "default": 0},
        "radius": {"type": "number", "desc": "Radius (mm)"},
    },
    category="sketch",
)
def sketch_circle(ctx: Context, radius: float, x: float = 0, y: float = 0):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCircle(units.mm(x), units.mm(y), 0, units.mm(x + radius), units.mm(y), 0)
    return {"circle": {"x": x, "y": y, "r": radius}}


@tool(
    "sketch_line", "Draw a line segment",
    params={
        "x1": {"type": "number", "desc": "Start X (mm)"}, "y1": {"type": "number", "desc": "Start Y (mm)"},
        "x2": {"type": "number", "desc": "End X (mm)"}, "y2": {"type": "number", "desc": "End Y (mm)"},
    },
    category="sketch",
)
def sketch_line(ctx: Context, x1: float, y1: float, x2: float, y2: float):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateLine(units.mm(x1), units.mm(y1), 0, units.mm(x2), units.mm(y2), 0)
    return {"line": [x1, y1, x2, y2]}


@tool(
    "sketch_centerline", "Draw a centerline (used for revolve/mirror)",
    params={
        "x1": {"type": "number", "desc": "Start X (mm)"}, "y1": {"type": "number", "desc": "Start Y (mm)"},
        "x2": {"type": "number", "desc": "End X (mm)"}, "y2": {"type": "number", "desc": "End Y (mm)"},
    },
    category="sketch",
)
def sketch_centerline(ctx: Context, x1: float, y1: float, x2: float, y2: float):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCenterLine(units.mm(x1), units.mm(y1), 0, units.mm(x2), units.mm(y2), 0)
    return {"centerline": [x1, y1, x2, y2]}


@tool(
    "sketch_arc_center", "Draw a center-arc (center + start + end + direction)",
    params={
        "cx": {"type": "number", "desc": "Center X (mm)"}, "cy": {"type": "number", "desc": "Center Y (mm)"},
        "sx": {"type": "number", "desc": "Start X (mm)"}, "sy": {"type": "number", "desc": "Start Y (mm)"},
        "ex": {"type": "number", "desc": "End X (mm)"}, "ey": {"type": "number", "desc": "End Y (mm)"},
        "direction": {"type": "number", "desc": "1 = counter-clockwise / -1 = clockwise", "default": 1},
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
    "sketch_polygon", "Draw a regular polygon",
    params={
        "cx": {"type": "number", "desc": "Center X (mm)", "default": 0},
        "cy": {"type": "number", "desc": "Center Y (mm)", "default": 0},
        "radius": {"type": "number", "desc": "Circumradius or inradius (mm)"},
        "sides": {"type": "number", "desc": "Number of sides"},
        "inscribed": {"type": "boolean", "desc": "True = inscribed / False = circumscribed", "default": True},
    },
    category="sketch",
)
def sketch_polygon(ctx, radius, sides, cx=0, cy=0, inscribed=True):
    _require_sketch(ctx)
    # CreatePolygon(cx, cy, cz, xp, yp, zp, sides, inscribed)
    ctx.sketch_mgr.CreatePolygon(
        units.mm(cx), units.mm(cy), 0,
        units.mm(cx + radius), units.mm(cy), 0, int(sides), bool(inscribed),
    )
    return {"polygon": {"center": [cx, cy], "r": radius, "sides": int(sides)}}


@tool(
    "sketch_fillet", "Fillet two selected sketch segments in the active sketch (select two segments in SolidWorks first)",
    params={"radius": {"type": "number", "desc": "Fillet radius (mm)"}},
    category="sketch",
)
def sketch_fillet(ctx: Context, radius: float):
    _require_sketch(ctx)
    if ctx.selected_count() < 1:
        raise SWError("please select two sketch segments to fillet first.")
    # CreateFillet(radius, constrainCorners) — 2 = swConstrainCorners_Keep
    ctx.sketch_mgr.CreateFillet(units.mm(radius), 2)
    return {"sketch_fillet_r": radius}


@tool(
    "add_sketch_relation", "Add a geometric relation to the selected sketch entities",
    params={"relation": {"type": "string",
                        "enum": ["horizontal", "vertical", "coincident", "parallel",
                                 "perpendicular", "tangent", "equal", "concentric", "symmetric"],
                        "desc": "Relation type"}},
    category="sketch",
)
def add_sketch_relation(ctx: Context, relation: str):
    if ctx.selected_count() < 1:
        raise SWError("please select sketch entities to add the relation to first.")
    key = {
        "horizontal": "sgHORIZONTAL2D", "vertical": "sgVERTICAL2D",
        "coincident": "sgCOINCIDENT", "parallel": "sgPARALLEL",
        "perpendicular": "sgPERPENDICULAR", "tangent": "sgTANGENT",
        "equal": "sgEQUAL", "concentric": "sgCONCENTRIC", "symmetric": "sgSYMMETRIC",
    }.get(relation)
    if not key:
        raise SWError(f"unknown relation: {relation}")
    ctx.model.SketchAddConstraints(key)
    return {"relation": relation}


@tool(
    "add_dimension", "Add a driving dimension at the given location for the selected entities",
    params={
        "x": {"type": "number", "desc": "Dimension placement X (mm)"},
        "y": {"type": "number", "desc": "Dimension placement Y (mm)"},
        "value": {"type": "number", "desc": "Dimension value (mm); omit to use the current geometric value", "default": 0},
    },
    category="sketch",
)
def add_dimension(ctx: Context, x: float, y: float, value: float = 0):
    if ctx.selected_count() < 1:
        raise SWError("please select entities to dimension first.")
    disp = ctx.model.AddDimension2(units.mm(x), units.mm(y), 0)
    if disp is None:
        raise SWError("failed to add dimension.")
    if value:
        d = disp.GetDimension2(0) if hasattr(disp, "GetDimension2") else disp.GetDimension()
        d.SetSystemValue3(units.mm(value), 1, None)  # 1 = apply to all configurations
        ctx.rebuild()
    return {"dimension_at": [x, y], "value_mm": value or None}
