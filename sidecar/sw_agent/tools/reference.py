"""sw_agent.tools.reference — reference geometry: reference planes / axes / points."""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError
from .. import units


@tool(
    "create_plane", "Create an offset reference plane (offset from a standard plane by a distance)",
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
    # 8 = swRefPlaneReferenceConstraint_Distance
    feat = ctx.feat_mgr.InsertRefPlane(8, units.mm(offset), 0, 0, 0, 0)
    if feat is None:
        raise SWError("failed to create reference plane.")
    return {"plane": feat.Name, "base": base, "offset_mm": offset}


@tool(
    "create_axis", "Create a reference axis from the current selection (two planes / cylindrical face / two points, etc.; select references in SolidWorks first)",
    params={},
    category="reference",
)
def create_axis(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError("please first select the references needed to create the reference axis (e.g. two planes or a cylindrical face).")
    # InsertAxis2(True) creates an axis using the current selection
    ok = ctx.model.InsertAxis2(True)
    if not ok:
        raise SWError("failed to create reference axis; check that the selected references are valid.")
    return {"axis_created": True}


@tool(
    "create_reference_point", "Create a reference point on selected vertices/edges (select references in SolidWorks first)",
    params={
        "point_type": {"type": "string",
                       "enum": ["arc_center", "end", "center_of_face", "intersection"],
                       "desc": "Reference point type", "default": "end"},
    },
    category="reference",
)
def create_reference_point(ctx: Context, point_type: str = "end"):
    if ctx.selected_count() < 1:
        raise SWError("please first select the reference entities needed to create the reference point.")
    # swRefPointType_e: arc_center=1, end=3, center_of_face=4, intersection=2
    t = {"arc_center": 1, "intersection": 2, "end": 3, "center_of_face": 4}.get(point_type, 3)
    feat = ctx.feat_mgr.InsertReferencePoint(t, 0, 0, 1)  # VERIFY: argument semantics may differ across SolidWorks versions
    if feat is None:
        raise SWError("failed to create reference point.")
    return {"point": feat.Name, "type": point_type}
