"""sw_agent.refplane — datum-plane creation with verified positioning (P120).

History — four rounds on one bug, three of them blind
----------------------------------------------------
P105  InsertRefPlane(15, …) as "Flip": 15 is Parallel|Perpendicular|Coincident|Distance.
P114  SelectByID2(…, SelectOption=16) as "reverse": swSelectOption_e has only 0 and 1.
P116  Correct enums at last (Flip=256, Distance|Flip=264) plus two documented read
      routes — but every helper swallowed its exception, so the real machine could only
      report "position unreadable".
P119  Added tracing and a third route. The trace immediately paid for itself: all three
      routes failed with the SAME error, DISP_E_MEMBERNOTFOUND (-2147352573,
      '找不到成员'), on their very first member access — GetSpecificFeature2,
      GetDefinition, ModelToSketchTransform.

P120 — what that trace actually meant
-------------------------------------
Not "IRefPlane is broken on SW 2025". bridge connects through gencache.EnsureDispatch
(EARLY BINDING), so each object is bound to ONE interface and members outside it simply
do not exist. P46 already documented this exact wall on IPartDoc.GetBodies2 and solved
it with CastTo + a plain-IDispatch fallback.

P116-P119 applied that ladder to the wrong object: the CastTo went on
GetSpecificFeature2's RETURN VALUE, while the member that was failing was
GetSpecificFeature2 itself, on the feature. Same mistake in route C — the sketch was
never re-bound before reading ModelToSketchTransform.

So the fix is not a fourth mechanism. Re-binding now happens on the SOURCE object at
every hop, through one shared helper (bridge.try_member → bridge.as_iface), so this
class of failure is handled once for the whole codebase instead of being rediscovered
per call site.

Design
------
1. InsertRefPlane with Distance (8), plus Flip (256) for negative offsets.
2. Read the plane's real position — three routes, each hop re-bound and traced.
3. Wrong side → flip the feature definition, else recreate with the opposite flag.
4. Still wrong → delete the plane and raise. A plane on the wrong side is worse than no
   plane: the next sketch lands on it and the extrude merges into the solid already
   there — the verified_failed this whole chain has been chasing.
"""
from __future__ import annotations

from sw_agent.bridge import SWError, try_member

# ---------------------------------------------------------------------------
# Constraint enum (swRefPlaneReferenceConstraints_e) — bit flags
# ---------------------------------------------------------------------------
CONSTRAINT = {
    "parallel":              1,
    "perpendicular":         2,
    "coincident":            4,
    "distance":              8,      # swRefPlaneReferenceConstraint_Distance
    "angle":                16,
    "tangent":              32,
    "project":              64,
    "midplane":            128,
    "flip":                256,      # swRefPlaneReferenceConstraint_OptionFlip
    "origin_on_curve":     512,
    "project_nearest":    1024,
    "project_sketch_normal": 2048,
    "parallel_to_screen":  4096,
    "reference_flip":      8192,     # swRefPlaneReferenceConstraint_OptionReferenceFlip
}

_CONST_NAMES = {
    "distance": "swRefPlaneReferenceConstraint_Distance",
    "flip":     "swRefPlaneReferenceConstraint_OptionFlip",
}

# World-axis index each standard plane's normal runs along. SolidWorks is Y-up:
#   Front = XY (normal Z=2), Top = XZ (normal Y=1), Right = YZ (normal X=0).
NORMAL_AXIS = {"front": 2, "top": 1, "right": 0}


def constraint_mask(kind: str) -> int:
    """Bit-flag value for InsertRefPlane. Prefers live typelib constants when a gen_py
    cache exists, otherwise the table above."""
    try:
        import win32com.client as wc
        name = _CONST_NAMES.get(kind)
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


# ---------------------------------------------------------------------------
# Position reading — three routes, each one reports WHY it failed
# ---------------------------------------------------------------------------

def read_position(ctx, name: str, base: str):
    """Signed offset (metres) of the named datum plane along `base`'s normal.

    Returns (value, trace) — value is None only when all three routes genuinely
    failed; trace is a list of "routeX: what happened" strings, always populated,
    so a failure on the real machine can be diagnosed instead of guessed at again.
    """
    axis = NORMAL_AXIS[base]
    trace: list[str] = []

    feat, err = _feature_by_name(ctx, name)
    if feat is None:
        trace.append(f"FeatureByName: {err}")
        # Routes A/B need the feature; only C (works off the plane selection, not
        # the feature object) can still proceed.
        v, note = _read_via_sketch(ctx, name, axis)
        trace.append(f"routeC(sketch): {note}")
        return (v, trace)

    v, note = _read_transform(feat, axis)
    trace.append(f"routeA(transform): {note}")
    if v is not None:
        return (v, trace)

    v, note = _read_definition(feat)
    trace.append(f"routeB(definition): {note}")
    if v is not None:
        return (v, trace)

    v, note = _read_via_sketch(ctx, name, axis)
    trace.append(f"routeC(sketch): {note}")
    return (v, trace)


def _feature_by_name(ctx, name: str):
    try:
        f = ctx.model.FeatureByName(name)
        return (f, "ok") if f is not None else (None, "returned None")
    except Exception as e:  # noqa: BLE001
        return None, f"raised {e!r}"

def _read_transform(feat, axis: int):
    """Route A: IRefPlane.Transform → ArrayData[9 + axis].

    IMathTransform.ArrayData is 16 doubles — [0:8] rotation, [9:11] translation,
    [12] scale — so the translation component along the base plane's normal IS the
    signed offset (SolidWorks VBA sample "Get the Normal and Origin of a Reference
    Plane Using Its Transform"; cadbooster.com "Understanding MathTransform").

    Each hop re-binds the SOURCE object, which is what P116-P119 got wrong: the
    CastTo went on GetSpecificFeature2's return value while the failing member was
    GetSpecificFeature2 itself, on the feature.
    """
    spec, note = try_member(feat, "GetSpecificFeature2", "IFeature", "Feature")
    if spec is None:
        return None, f"GetSpecificFeature2 {note}"
    xf, note_x = try_member(spec, "Transform", "IRefPlane", "RefPlane")
    if xf is None:
        return None, f"GetSpecificFeature2 {note}; Transform {note_x}"
    arr, note_a = try_member(xf, "ArrayData", "IMathTransform", "MathTransform")
    if arr is None:
        return None, f"Transform {note_x}; ArrayData {note_a}"
    arr = list(arr or [])
    if len(arr) < 12:
        return None, f"ArrayData {note_a} but len={len(arr)}"
    return float(arr[9 + axis]), f"ok (feature {note}, transform {note_x}, array {note_a})"


def _read_definition(feat):
    """Route B: IRefPlaneFeatureData.Distance + ReverseDirection."""
    data, note = try_member(feat, "GetDefinition", "IFeature", "Feature")
    if data is None:
        return None, f"GetDefinition {note}"

    dist_m = None
    dist_notes = []
    for attr in ("Distance", "Distance2"):
        try:
            raw = getattr(data, attr, None)
            if raw is None:
                dist_notes.append(f"{attr}=None")
                continue
            v = float(raw.SystemValue if hasattr(raw, "SystemValue") else raw)
            dist_notes.append(f"{attr}={v}")
            if abs(v) > 1e-12:
                dist_m = abs(v)
                break
        except Exception as e:  # noqa: BLE001
            dist_notes.append(f"{attr} raised {e!r}")

    if dist_m is None:
        return None, "; ".join(dist_notes) or "no Distance/Distance2 attribute"

    flipped = False
    flip_note = "no direction property found"
    for prop in ("ReverseDirection", "ReversedReferenceDirection", "Reverse", "FlipDirection"):
        try:
            val = getattr(data, prop, None)
            if val is not None:
                flipped = bool(val)
                flip_note = f"{prop}={flipped}"
                break
        except Exception as e:  # noqa: BLE001
            flip_note = f"{prop} raised {e!r}"
            continue

    return (-dist_m if flipped else dist_m), f"dist_m={dist_m} {flip_note}"


def _read_via_sketch(ctx, name: str, axis: int):
    """Route C: temporary sketch on the plane, read via ISketch.ModelToSketchTransform.

    Deliberately a DIFFERENT interface than IRefPlane/IRefPlaneFeatureData. ISketch is
    proven to resolve fine on this codebase's target installs (verify.py's snapshot()
    reads sketch_mgr.ActiveSketch.GetSketchSegments() successfully elsewhere) — if
    IRefPlane specifically is the piece that doesn't resolve under dynamic dispatch on
    a given machine, this is a structurally different bet, not a retry of the same one.

    A sketch's local origin, mapped back to model space, sits on the plane at its
    canonical (0,0) point — for an offset plane parallel to a standard plane, that is
    exactly the signed offset along the normal axis.
    """
    sm = ctx.sketch_mgr
    entered = False
    try:
        ctx.clear_selection()
        if not ctx.select_by_id(name, "PLANE"):
            return None, "select_by_id(PLANE) failed"
        sm.InsertSketch(True)
        entered = True
        act = sm.ActiveSketch
        if act is None:
            return None, "no ActiveSketch after InsertSketch(True)"

        xf, note = try_member(act, "ModelToSketchTransform", "ISketch", "Sketch")
        if xf is None:
            return None, f"ModelToSketchTransform {note}"

        inv, note_i = try_member(xf, "Inverse", "IMathTransform", "MathTransform")
        if inv is None:
            inv, note_i = try_member(xf, "IInverse", "IMathTransform", "MathTransform")
        if inv is None:
            return None, f"ModelToSketchTransform {note}; Inverse {note_i}"

        arr, note_a = try_member(inv, "ArrayData", "IMathTransform", "MathTransform")
        arr = list(arr or [])
        if len(arr) < 12:
            return None, f"inverse ArrayData {note_a} len={len(arr)}"
        return float(arr[9 + axis]), f"ok (sketch {note}, inverse {note_i})"
    except Exception as e:  # noqa: BLE001
        return None, f"exception {e!r}"
    finally:
        if entered:
            try:
                sm.InsertSketch(True)  # exit
            except Exception:  # noqa: BLE001
                pass
        try:
            ctx.clear_selection()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Feature definition editing (flip direction)
# ---------------------------------------------------------------------------

def flip_definition(ctx, feat_or_name, value: bool) -> str | None:
    """Toggle the plane's direction via IRefPlaneFeatureData.

      1. GetDefinition → IRefPlaneFeatureData
      2. AccessSelections
      3. Set ReverseDirection / ReversedReferenceDirection
      4. ModifyDefinition to commit, or ReleaseSelectionAccess to discard

    Returns the property name that accepted the write, or None on failure. Never raises.
    """
    feat = feat_or_name
    if isinstance(feat_or_name, str):
        feat, _ = _feature_by_name(ctx, feat_or_name)
    if feat is None:
        return None

    model = ctx.model
    data, _ = try_member(feat, "GetDefinition", "IFeature", "Feature")
    if data is None:
        return None

    try:
        try:
            data.AccessSelections(model, None)
        except Exception:  # noqa: BLE001 — some installs skip this for datums
            pass

        used = None
        for prop in ("ReverseDirection", "ReversedReferenceDirection", "Reverse", "FlipDirection"):
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


# ---------------------------------------------------------------------------
# Deletion
# ---------------------------------------------------------------------------

def delete(ctx, name: str) -> bool:
    """Delete a datum plane by name. Used to clean up a plane that landed on the wrong
    side — leaving it would let a later sketch pick it up by name or by 'last'."""
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


# ---------------------------------------------------------------------------
# Decision helper
# ---------------------------------------------------------------------------

def wrong_side(measured: float, target: float, tol: float) -> bool:
    """Is the measured offset NOT the requested one? Sign and magnitude in one test."""
    return abs(measured - target) > tol
