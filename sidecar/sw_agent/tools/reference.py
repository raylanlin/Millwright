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
    "tool measures where it actually landed before reporting success. "
    "Prefer start_sketch(face=…) when you just need to sketch on the model",
    params={
        "base": {"type": "string", "enum": ["front", "top", "right"], "desc": "Base reference plane"},
        "offset": {"type": "number", "desc": "Offset distance (mm); negative = the other side of the base plane"},
    },
    category="reference",
)
def create_plane(ctx: Context, base: str, offset: float):
    """P116: create, then MEASURE — see refplane.py for the two blind fixes before this.

    Short version: the flip flag P105 passed (15) was three unrelated constraints, and the
    "reverse selection" option P114 passed (16) is not a member of swSelectOption_e at all.
    Both were reported as no-ops from the machine because both were no-ops, and neither
    could be caught here: create_plane echoed back the offset it had been ASKED for, so a
    plane that never moved still reported offset_mm=-50 and the next step happily built on
    top of the existing solid. This version reads the plane's real position and either
    corrects it or fails loudly.
    """
    if abs(float(offset)) < 1e-9:
        raise SWError("offset must be non-zero — to sketch on the base plane itself use start_sketch(plane=…).")

    target = units.mm(offset)              # metres, signed
    dist = abs(target)
    tol = max(2e-6, dist * 1e-3)           # 2µm floor, else 0.1% of the distance
    want_flip = offset < 0
    log: list[str] = []

    def insert(flip: bool):
        ctx.clear_selection()
        if not ctx.select_plane(base):
            raise SWError(f"failed to select reference plane: {base}")
        mask = refplane.constraint("distance") | (refplane.constraint("flip") if flip else 0)
        feat = ctx.feat_mgr.InsertRefPlane(mask, dist, 0, 0, 0, 0)
        if feat is None:
            raise SWError(f"failed to create reference plane (constraint mask {mask}, distance {dist} m).")
        return feat, sw_get(feat, "Name"), mask

    def check(feat, name, how):
        m = refplane.measure(ctx, feat, base, name)
        if m is None:
            log.append(f"{how}: position unreadable")
            return None
        log.append(f"{how}: measured {m * 1000:+.3f} mm (wanted {offset:+.3f})")
        return m

    feat, name, mask = insert(want_flip)
    measured = check(feat, name, f"insert(mask={mask})")
    how = "flip" if want_flip else "distance"

    # Unreadable position — report the plane, but do NOT claim it was verified. Silent
    # success is what made this bug survive two patches; an honest "unverified" lets the
    # model decide to check with bounding_box / analyze_view.
    if measured is None:
        ctx.scratch["last_plane"] = name
        return {"plane": name, "base": base, "offset_mm": offset, "verified": False,
                "warning": "could not read the plane's actual position on this install — "
                           "verify the side before building on it", "attempts": log}

    if refplane.wrong_side(measured, target, tol):
        # Rung 1 — flip the feature definition in place.
        prop = refplane.flip_definition(ctx, feat, not want_flip)
        if prop:
            m2 = check(feat, name, f"definition.{prop}={not want_flip}")
            if m2 is not None and not refplane.wrong_side(m2, target, tol):
                measured, how = m2, f"definition.{prop}"
        else:
            log.append("definition: no writable direction property")

    if refplane.wrong_side(measured, target, tol):
        # Rung 2 — rebuild it with the opposite flag. Delete first: two coincident
        # planes is precisely the state that broke the test model.
        refplane.delete(ctx, name)
        feat, name, mask = insert(not want_flip)
        m3 = check(feat, name, f"recreate(mask={mask})")
        if m3 is not None:
            measured, how = m3, "recreate"

    if measured is None or refplane.wrong_side(measured, target, tol):
        refplane.delete(ctx, name)
        raise SWError(
            f"reference plane would not land at {offset:+g} mm from {base} — deleted it rather than "
            "leave a plane on the wrong side (a sketch on it would build into the existing solid). "
            f"attempts: {' | '.join(log)}"
        )

    # P100: pass the created plane's NAME through scratch so the next step can use
    # start_sketch(plane="last") instead of guessing "基准面1".
    ctx.scratch["last_plane"] = name
    return {"plane": name, "base": base, "offset_mm": offset,
            "measured_offset_mm": round(measured * 1000, 4),
            "verified": True, "how": how, "attempts": log}


@tool(
    "create_axis", "Create a reference axis from the current selection (= Reference Axis; InsertAxis2) — two planes / a cylindrical face / two points",
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
    "Create a reference point on the selected vertices/edges/faces (= Reference Point; InsertReferencePoint). "
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
