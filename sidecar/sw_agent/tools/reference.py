"""sw_agent.tools.reference — reference geometry: reference planes / axes / points."""
from __future__ import annotations

from sw_agent import units
from sw_agent.bridge import Context, SWError, sw_get
from sw_agent.registry import tool
from sw_agent.tools.feature import com_call


@tool(
    "create_plane", "Create an offset reference plane (= 基准面; InsertRefPlane with a distance constraint). Prefer start_sketch(face=…) when you just need to sketch on the model",
    params={
        "base": {"type": "string", "enum": ["front", "top", "right"], "desc": "Base reference plane"},
        "offset": {"type": "number", "desc": "Offset distance (mm)"},
    },
    category="reference",
)
def create_plane(ctx: Context, base: str, offset: float):
    ctx.clear_selection()
    if not ctx.select_plane(base):
        raise SWError(f"failed to select reference plane: {base}")
    # InsertRefPlane(firstConstraint, firstVal, second, secondVal, third, thirdVal)
    # 8 = swRefPlaneReferenceConstraint_Distance; 15 = swRefPlaneReferenceConstraint_Flip
    # P105: a NEGATIVE distance silently produced a plane ON the base plane on this
    # install (offset=-45 landed at Z=0) — the negative sign was dropped in transit.
    # Flip is the documented way to reverse a distance constraint; use it instead.
    if offset >= 0:
        feat = ctx.feat_mgr.InsertRefPlane(8, units.mm(offset), 0, 0, 0, 0)
    else:
        feat = ctx.feat_mgr.InsertRefPlane(8, units.mm(-offset), 15, 0, 0, 0)
    if feat is None:
        raise SWError("failed to create reference plane.")
    name = sw_get(feat, "Name")
    # P100: pass the created plane's NAME through scratch so the next step can use
    # start_sketch(plane="last") instead of guessing "基准面1". The benchmark model
    # burned a list_features call precisely because it had to guess the name.
    ctx.scratch["last_plane"] = name
    return {"plane": name, "base": base, "offset_mm": offset}


@tool(
    "create_axis", "Create a reference axis from the current selection (= 基准轴; InsertAxis2) — two planes / a cylindrical face / two points",
    params={},
    category="reference",
)
def create_axis(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError("please first select the references needed to create the reference axis (e.g. two planes or a cylindrical face).")
    # InsertAxis2(True) creates an axis from the current selection
    ok = ctx.model.InsertAxis2(True)
    if not ok:
        raise SWError("failed to create reference axis; check that the selected references are valid.")
    return {"axis_created": True}


@tool(
    "create_reference_point",
    "Create a reference point on the selected vertices/edges/faces (= 参考点; InsertReferencePoint). "
    "Select the references in SolidWorks first",
    params={
        "point_type": {
            "type": "string",
            "enum": ["arc_center", "end", "center_of_face", "intersection", "along_curve"],
            "desc": "Which point to create on the selection",
            "default": "end",
        },
        "count": {
            "type": "integer",
            "desc": "For along_curve only: how many points to distribute along the selected edge",
            "default": 1,
        },
        "distance": {
            "type": "number",
            "desc": "For along_curve only: spacing in mm (0 = distribute evenly across the whole edge)",
            "default": 0,
        },
    },
    category="reference",
)
def create_reference_point(ctx: Context, point_type: str = "end",
                           count: int = 1, distance: float = 0):
    """P77: the arguments were placeholders, not values.

    The old call was InsertReferencePoint(t, 0, 0, 1) with a "# VERIFY" note. The real
    signature is (RefPointType, RefPointArcEnd, Distance, NumRefPoints): argument 2 is a
    swRefPointAlongCurveType_e, argument 3 a distance in METRES, argument 4 the number of
    points. Passing 0 for the along-curve type is not a neutral default — it is a distinct
    mode — and hard-coding NumRefPoints to 1 makes the count parameter unreachable.
    """
    if ctx.selected_count() < 1:
        raise SWError("please first select the reference entities needed to create the reference point.")

    # swRefPointType_e
    types = {"arc_center": 1, "intersection": 2, "end": 3,
             "center_of_face": 4, "along_curve": 5}
    t = types.get(point_type)
    if t is None:
        raise SWError(f"unknown point_type: {point_type}")

    # swRefPointAlongCurveType_e: 1 = distance, 2 = percentage, 3 = evenly distributed.
    # Only meaningful when t == 5; SolidWorks ignores it otherwise.
    along = 0
    n = max(1, int(count))
    if t == 5:
        along = 1 if distance else 3
        if not distance and n <= 1:
            raise SWError("along_curve needs either distance= or count= greater than 1.")

    errors: list = []
    feat = com_call(
        ctx.feat_mgr, ("InsertReferencePoint",),
        [t, along, units.mm(distance), n], errors, min_args=4,
    )
    if feat is None:
        raise SWError(
            "failed to create the reference point — check the selection suits this point type. "
            f"(attempts: {' | '.join(errors[-3:])})"
        )
    return {"point": sw_get(feat, "Name"), "type": point_type,
            "count": n if t == 5 else 1}
