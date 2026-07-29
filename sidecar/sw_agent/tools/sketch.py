"""sw_agent.tools.sketch — sketch: enter/exit + entities + relations/dimensions.

All coordinate / dimension inputs are in mm; internally units.mm() converts
to meters. Most entity methods (CreateCornerRectangle / CreateCircle /
CreateLine / CreateArc / CreatePolygon) are stable across SolidWorks
versions with well-defined signatures.

P13: add_dimension's SetSystemValue3 config arg corrected — 1 = this
configuration ONLY (the comment claimed "all"); 2 = all configurations.
"""
from __future__ import annotations

try:
    from itertools import pairwise
except ImportError:  # Python 3.9 -- pairwise landed in 3.10
    def pairwise(it):
        seq = list(it)
        return zip(seq, seq[1:])

from .. import units
from ..bridge import Context, SWError, sw_get
from ..registry import tool

# swInConfigurationOpts_e
CFG_ALL = 2


def _require_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is None:
        raise SWError("not currently editing a sketch; call start_sketch first.")


@tool(
    "start_sketch",
    "Start a sketch and enter edit mode. Prefer face=\"top\" etc. to sketch directly ON the model "
    "(like clicking a face in SolidWorks) — no offset plane needed; use plane= only for the very "
    "first sketch or when you genuinely need a datum plane",
    params={
        "plane": {"type": "string", "desc": "front / top / right, or the name of a plane you created (e.g. 基准面1)", "default": ""},
        "face": {"type": "string", "enum": ["top", "bottom", "front", "back", "left", "right"], "desc": "Sketch on the solid's outermost planar face in this direction (e.g. top = the current top face of the part)", "default": ""},
    },
    category="sketch",
)
def start_sketch(ctx: Context, plane: str = "", face: str = ""):
    ctx.clear_selection()
    # P44: face= sketches straight onto the model, the way a person would click the
    # face. Only fall through to datum planes when no face was requested.
    if face:
        if not ctx.select_face(face):
            raise SWError(f"failed to select the {face} face of the solid.")
        ctx.sketch_mgr.InsertSketch(True)
        try:
            active = ctx.sketch_mgr.ActiveSketch
            if active is not None:
                ctx.scratch["last_sketch"] = sw_get(active, "Name")
        except Exception:  # noqa: BLE001
            pass
        return {"sketch_on": f"face:{face}"}

    if not plane:
        raise SWError("give either plane= (front/top/right or a datum plane name) or face= (top/bottom/front/back/left/right).")
    key = (plane or "").strip()
    ok = ctx.select_plane(key) if key.lower() in ("front", "top", "right") else False
    if not ok:
        # P37: sketch on ANY reference plane in the tree. Previously only the three
        # default planes worked, so a plane the agent had just created with
        # create_plane ("基准面1") failed with "unknown plane".
        ok = bool(ctx.select_by_id(key, "PLANE"))
    if not ok:
        raise SWError(
            f"failed to select plane: {plane} — use front/top/right, "
            "or an existing plane name (list_features shows RefPlane entries)"
        )
    ctx.sketch_mgr.InsertSketch(True)
    # P32: remember this sketch's feature name so extrude/cut can target it after
    # the sketch is exited, without relying on feature-tree traversal.
    try:
        active = ctx.sketch_mgr.ActiveSketch
        if active is not None:
            ctx.scratch["last_sketch"] = sw_get(active, "Name")
    except Exception:  # noqa: BLE001 — best-effort
        pass
    return {"sketch_on": plane}


@tool("exit_sketch", "Exit the current sketch (= 退出草图; InsertSketch(True))", params={}, category="sketch")
def exit_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is not None:
        ctx.sketch_mgr.InsertSketch(True)
    return {"exited": True}


@tool(
    "sketch_rectangle", "Draw a rectangle from its lower-left corner + width/height (= 边角矩形; wraps CreateCornerRectangle, mm in)",
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
    "sketch_circle", "Draw a circle from center + radius (= 圆; wraps CreateCircle, mm in)",
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
    "sketch_polyline",
    "Draw a CLOSED contour (triangle, trapezoid, any polygon) in one call — use this instead "
    "of several sketch_line calls, which leave the profile open and make extrude fail",
    params={
        "points": {
            "type": "string",
            "desc": "Corner coordinates in mm, e.g. \"30,15 30,50 55,15\" — the contour is closed back to the first point automatically",
        },
    },
    category="sketch",
)
def sketch_polyline(ctx: Context, points: str):
    """P45: three separate sketch_line calls did NOT weld their endpoints, so every
    triangular rib failed with "no closed sketch" no matter how the numbers were
    written. Drawing the whole loop in one call (and closing it explicitly) fixes it."""
    if ctx.sketch_mgr.ActiveSketch is None:
        raise SWError("start a sketch first (start_sketch).")
    pts = []
    for chunk in (points or "").replace(";", " ").split():
        parts = chunk.split(",")
        if len(parts) < 2:
            raise SWError(f'bad point "{chunk}" — use "x,y x,y x,y" in mm.')
        pts.append((units.mm(float(parts[0])), units.mm(float(parts[1]))))
    if len(pts) < 3:
        raise SWError("a closed contour needs at least 3 points.")
    loop = pts + [pts[0]]
    made = 0
    for (x1, y1), (x2, y2) in pairwise(loop):
        if ctx.sketch_mgr.CreateLine(x1, y1, 0.0, x2, y2, 0.0) is not None:
            made += 1
    if made < len(pts):
        raise SWError(f"only {made} of {len(pts)} segments were created.")
    return {"closed_contour": len(pts), "segments": made}


@tool(
    "sketch_line", "Draw a line segment (= 直线; wraps CreateLine, mm in)",
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
    "sketch_centerline", "Draw a centerline, the axis for revolve/mirror (= 中心线; wraps CreateCenterLine)",
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
    "sketch_arc_center", "Draw a center-arc from center + start + end + direction (= 圆心圆弧; wraps CreateArc)",
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
    "sketch_polygon", "Draw a regular polygon (= 多边形; wraps CreatePolygon)",
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
    "add_sketch_relation", "Add a geometric relation to the selected sketch entities (= 几何关系; SketchAddConstraints)",
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
    "add_dimension", "Add a driving dimension for the selected entities (= 智能尺寸; AddDimension2 + SetSystemValue3, ALL configurations)",
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
        # P13: swInConfigurationOpts_e — 2 = all configurations (1 = this config only)
        d.SetSystemValue3(units.mm(value), CFG_ALL, None)
        ctx.rebuild()
    return {"dimension_at": [x, y], "value_mm": value or None}
