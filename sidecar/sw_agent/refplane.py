"""sw_agent.refplane — datum-plane sidedness: set it, then MEASURE it (P116).

## The bug this module exists for

`create_plane base=front offset=-50` built its plane at Z=+50, on top of the plane a
previous `offset=50` had made. Two patches tried to fix it blind and both were reported
"no effect" from the real machine:

  P105  InsertRefPlane(15, mm(abs(offset)), …)
        15 is not the Flip flag. It is Parallel|Perpendicular|Coincident|Distance
        (1|2|4|8) — three constraints the call never meant to ask for. SolidWorks kept
        the part it could satisfy (Distance) and built the default side.

  P114  SelectByID2(…, SelectOption=16) — "reverse the selection"
        swSelectOption_e has no Reverse member (Default 0 / Extensive 1). 16 was not an
        ignored flag, it was not a value; the call selected the base plane normally and
        the plane landed at +50 again.

Both attempts share one failure mode, and it matters more than either enum mistake:
**nothing in the pipeline ever looked at where the plane actually went.** The tool
returned `{"offset_mm": -50}` because that is what it was asked for, and a later vision
pass then "confirmed" the negative offset worked. Two rounds of debugging were spent on
a plane that had never moved.

## What this module does instead

Sidedness is a property of the FEATURE, not of how its reference was selected, so:

  1. create the plane at the distance, asking for the flip flag when the caller wants
     the far side (`swRefPlaneReferenceConstraint_OptionFlip`, 256 — read from the live
     typelib constants when a gen_py cache exists, table below otherwise);
  2. `measure()` the plane's real signed position off its own transform;
  3. if the sign is wrong, correct it — flip the feature definition, else rebuild it
     with the opposite flag — re-measuring after each step;
  4. if it still will not land, DELETE the wrong plane and raise. A plane on the wrong
     side is worse than no plane: the next sketch goes on it and the extrude merges into
     the body that is already there (that is the verified_failed we chased).

No step trusts an enum value to have done anything. Measurement is the only authority,
which is exactly what was missing from P105 and P114.
"""
from __future__ import annotations

from sw_agent.bridge import SWError, sw_get

# swRefPlaneReferenceConstraints_e — bit flags, in swconst declaration order.
CONSTRAINT = {
    "parallel": 1,
    "perpendicular": 2,
    "coincident": 4,
    "distance": 8,
    "angle": 16,
    "tangent": 32,
    "project": 64,
    "midplane": 128,
    "flip": 256,                    # swRefPlaneReferenceConstraint_OptionFlip
    "origin_on_curve": 512,
    "project_nearest": 1024,
    "project_sketch_normal": 2048,
    "parallel_to_screen": 4096,
    "reference_flip": 8192,
}

_CONST_NAME = {
    "distance": "swRefPlaneReferenceConstraint_Distance",
    "flip": "swRefPlaneReferenceConstraint_OptionFlip",
    "midplane": "swRefPlaneReferenceConstraint_MidPlane",
    "reference_flip": "swRefPlaneReferenceConstraint_OptionReferenceFlip",
}

# World axis each standard plane's normal runs along. SolidWorks world space is Y-UP:
# Front is XY (normal Z), Top is XZ (normal Y), Right is YZ (normal X). Same convention
# as bridge.select_face — getting this wrong is how face="top" once found the front face.
NORMAL_AXIS = {"front": 2, "top": 1, "right": 0}


def constraint(kind: str) -> int:
    """Constraint flag for InsertRefPlane. Live typelib constants win when a gen_py
    cache happens to exist (typelib.py never builds one on the startup path), otherwise
    the table above — same arrangement as typelib.feature_id()."""
    try:
        import win32com.client as wc
        name = _CONST_NAME.get(kind)
        if name:
            v = getattr(wc.constants, name, None)
            if isinstance(v, int) and v > 0:
                return v
    except Exception:  # noqa: BLE001
        pass
    v = CONSTRAINT.get(kind)
    if v is None:
        raise SWError(f"unknown reference-plane constraint: {kind}")
    return v


def _translation(obj, axis: int):
    """Signed position (metres) of a datum plane along `axis`, off IRefPlane.Transform.

    IMathTransform.ArrayData is 16 doubles: [0:9] rotation, [9:12] translation, [12]
    scale. For a plane offset from a standard plane the translation lies along that
    plane's normal, so one component is the offset we are looking for.
    """
    xf = sw_get(obj, "Transform")
    arr = list(sw_get(xf, "ArrayData") or [])
    if len(arr) < 12:
        return None
    return float(arr[9 + axis])


def measure(ctx, feat, base: str, name: str | None = None):
    """Signed offset in METRES of `feat` from its base plane, or None if unreadable.

    Three routes, because a datum plane is one of the flakier things to read over COM on
    an arbitrary install, and an unreadable plane must not be mistaken for a wrong one.
    """
    axis = NORMAL_AXIS[base]

    # A — the feature's own IRefPlane
    try:
        rp = sw_get(feat, "GetSpecificFeature2")
        if rp is not None:
            v = _translation(rp, axis)
            if v is not None:
                return v
    except Exception:  # noqa: BLE001
        pass

    # B — select the plane by name and read the selected IRefPlane. Survives the case
    # where the feature wrapper went stale after ModifyDefinition rebuilt it.
    if name:
        try:
            ctx.clear_selection()
            if ctx.select_by_id(name, "PLANE"):
                obj = sw_get(ctx.sel_mgr, "GetSelectedObject6", 1, -1)
                if obj is not None:
                    v = _translation(obj, axis)
                    if v is not None:
                        return v
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                ctx.clear_selection()
            except Exception:  # noqa: BLE001
                pass

    # C — the datum's display box. A plane has no thickness, so its extent along the
    # normal collapses to its position.
    try:
        box = list(sw_get(feat, "GetBox") or [])
        if len(box) >= 6:
            return (float(box[axis]) + float(box[axis + 3])) / 2.0
    except Exception:  # noqa: BLE001
        pass
    return None


# Property that carries "which side" on IRefPlaneFeatureData. The member name is not
# worth betting the fix on (this is the third patch to be wrong about a name), so every
# plausible one is tried and the RESULT is measured either way.
_REVERSE_PROPS = ("ReverseDirection", "Reverse", "FlipDirection", "Flip")


def flip_definition(ctx, feat, value: bool) -> str | None:
    """Toggle the plane's direction through its feature definition.

    Returns the property name that took the write, or None if the definition could not
    be edited. Never raises — this is one rung of a ladder, not the answer.
    """
    model = ctx.model
    data = None
    try:
        data = sw_get(feat, "GetDefinition")
    except Exception:  # noqa: BLE001
        return None
    if data is None:
        return None
    try:
        try:
            data.AccessSelections(model, None)
        except Exception:  # noqa: BLE001 — some installs do not need it for datums
            pass
        used = None
        for prop in _REVERSE_PROPS:
            if not hasattr(data, prop):
                continue
            try:
                setattr(data, prop, bool(value))
                used = prop
                break
            except Exception:  # noqa: BLE001
                continue
        if used is None:
            _release(data)
            return None
        if bool(feat.ModifyDefinition(data, model, None)):
            return used
        _release(data)
        return None
    except Exception:  # noqa: BLE001
        _release(data)
        return None


def _release(data):
    try:
        data.ReleaseSelectionAccess()
    except Exception:  # noqa: BLE001
        pass


def delete(ctx, name: str) -> bool:
    """Delete a datum plane by name. Used to clean up a plane that landed wrong —
    leaving it behind would let a later sketch pick it up by name or by 'last'."""
    try:
        ctx.clear_selection()
        if not ctx.select_by_id(name, "PLANE"):
            return False
        ext = ctx.model.Extension
        fn = getattr(ext, "DeleteSelection2", None)
        if fn is not None:
            return bool(fn(0))   # 0 = swDelete_Absorbed
        return bool(ctx.model.EditDelete())
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            ctx.clear_selection()
        except Exception:  # noqa: BLE001
            pass


def wrong_side(measured: float, target: float, tol: float) -> bool:
    """Pure decision helper: is the measured offset NOT the requested one?

    Sign and magnitude in one test — a plane at +50 when -50 was asked for fails, and so
    does one at +5 when +50 was asked for. Kept free of COM so it can be reasoned about
    and tested without SolidWorks.
    """
    return abs(measured - target) > tol
