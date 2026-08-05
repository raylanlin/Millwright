"""sw_agent.tools.reference — reference geometry: reference planes / axes / points."""
from __future__ import annotations

from sw_agent import refplane, units
from sw_agent.bridge import Context, SWError, sw_get
from sw_agent.registry import tool
from sw_agent.tools.feature import com_call


@tool(
    "create_plane",
    "Create an offset reference plane (= Plane; InsertRefPlane with a distance constraint). "
    "offset may be negative — the plane then goes on the other side of the base plane, and the "
    "tool verifies its actual position before reporting success. "
    "Prefer start_sketch(face=…) when you just need to sketch on the model",
    params={
        "base": {"type": "string", "enum": ["front", "top", "right"], "desc": "Base reference plane"},
        "offset": {"type": "number", "desc": "Offset distance (mm); negative = the other side of the base plane"},
    },
    category="reference",
)
def create_plane(ctx: Context, base: str, offset: float):
    """P116: create, measure via IRefPlane.Transform, correct if needed.

    Two previous patches failed because they set non-existent enum values and never
    read where the plane actually went. This version measures the real position through
    the documented IRefPlane.Transform path (ArrayData[9:11] translation vector) and
    either corrects a wrong-side plane or deletes it and raises.
    """
    if abs(float(offset)) < 1e-9:
        raise SWError("offset must be non-zero — to sketch on the base plane itself use start_sketch(plane=…).")

    target_m = units.mm(offset)            # metres, signed
    dist_m = abs(target_m)
    tol = max(2e-6, dist_m * 1e-3)        # 2µm floor, else 0.1% of the distance
    want_flip = offset < 0
    log: list[str] = []

    # -- Step 1: insert the plane ----------------------------------------------
    def insert(flip: bool):
        ctx.clear_selection()
        if not ctx.select_plane(base):
            raise SWError(f"failed to select reference plane: {base}")
        mask = refplane.constraint_mask("distance")
        if flip:
            mask |= refplane.constraint_mask("flip")
        feat = ctx.feat_mgr.InsertRefPlane(mask, dist_m, 0, 0, 0, 0)
        if feat is None:
            raise SWError(f"InsertRefPlane failed (mask={mask}, distance={dist_m} m).")
        return sw_get(feat, "Name"), mask

    name, mask = insert(want_flip)

    # -- Step 2: measure the actual position -----------------------------------
    def check(label: str) -> float | None:
        m, route_trace = refplane.read_position(ctx, name, base)
        log.extend(f"{label} {t}" for t in route_trace)
        if m is None:
            log.append(f"{label}: position unreadable")
            return None
        log.append(f"{label}: measured {m * 1000:+.3f} mm (wanted {offset:+.3f})")
        return m

    measured = check(f"insert(mask={mask})")

    # -- Unreadable: report honestly, don't pretend it worked ------------------
    if measured is None:
        ctx.scratch["last_plane"] = name
        return {
            "plane": name, "base": base, "offset_mm": offset,
            "verified": False,
            "warning": "could not read the plane's actual position — "
                       "verify with bounding_box before building on it",
            "attempts": log,
        }

    # -- Step 3: correct if wrong side -----------------------------------------
    if refplane.wrong_side(measured, target_m, tol):
        # Rung 1: flip the feature definition in place
        feat, _ = refplane._feature_by_name(ctx, name)
        if feat is not None:
            prop = refplane.flip_definition(ctx, feat, not want_flip)
            if prop:
                m2 = check(f"definition.{prop}={not want_flip}")
                if m2 is not None and not refplane.wrong_side(m2, target_m, tol):
                    measured = m2

    if measured is not None and refplane.wrong_side(measured, target_m, tol):
        # Rung 2: delete and recreate with the opposite flag
        refplane.delete(ctx, name)
        name, mask = insert(not want_flip)
        m3 = check(f"recreate(mask={mask})")
        if m3 is not None:
            measured = m3

    # -- Step 4: give up if still wrong ----------------------------------------
    if measured is None or refplane.wrong_side(measured, target_m, tol):
        refplane.delete(ctx, name)
        raise SWError(
            f"reference plane refused to land at {offset:+g} mm from {base} — deleted it "
            "rather than leave a plane on the wrong side. "
            f"attempts: {' | '.join(log)}"
        )

    ctx.scratch["last_plane"] = name
    return {
        "plane": name, "base": base, "offset_mm": offset,
        "measured_offset_mm": round(measured * 1000, 4),
        "verified": True,
        "attempts": log,
    }


@tool(
    "create_axis",
    "Create a reference axis from the current selection (= Reference Axis; InsertAxis2) "
    "— two planes / a cylindrical face / two points",
    params={},
    category="reference",
)
def create_axis(ctx: Context):
    if ctx.selected_count() < 1:
        raise SWError(
            "please first select the references needed to create the reference axis "
            "(e.g. two planes or a cylindrical face)."
        )
    ok = ctx.model.InsertAxis2(True)
    if not ok:
        raise SWError("failed to create reference axis; check that the selected references are valid.")
    return {"axis_created": True}


@tool(
    "create_reference_point",
    "Create a reference point on the selected vertices/edges/faces (= Reference Point; "
    "InsertReferencePoint). Select the references in SolidWorks first",
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
    if ctx.selected_count() < 1:
        raise SWError("please first select the reference entities needed to create the reference point.")

    types = {"arc_center": 1, "intersection": 2, "end": 3,
             "center_of_face": 4, "along_curve": 5}
    t = types.get(point_type)
    if t is None:
        raise SWError(f"unknown point_type: {point_type}")

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
