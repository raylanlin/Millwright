"""sw_agent.refplane — datum-plane creation with verified positioning (P116).

The problem this module solves
------------------------------
`create_plane base=front offset=-50` built its plane at Z=+50 on top of the +50 plane.
Two blind fixes failed because they targeted non-existent enum values, and *nothing in
the pipeline ever read where the plane actually went* — the tool echoed back the offset
it was asked for, so a plane that never moved still reported offset_mm=-50.

Root causes of the two failed patches
--------------------------------------
P105  InsertRefPlane(15, …) — 15 is Parallel|Perpendicular|Coincident|Distance (1|2|4|8),
      not the Flip flag. SolidWorks satisfied the Distance part and built the default side.

P114  SelectByID2(…, SelectOption=16) — swSelectOption_e has only Default(0) and
      Extensive(1). 16 is not a valid value; the call silently ignored it.

The real Flip flag is swRefPlaneReferenceConstraint_OptionFlip = 256, in the
swRefPlaneReferenceConstraints_e bit-flag enum (Distance=8, so Distance|Flip=264).

Design
------
1. Create the plane with InsertRefPlane, passing Distance|Flip (264) for negative offsets.
2. Read the plane's actual world-space position via IRefPlane.Transform — the documented
   approach (see cadbooster.com "Understanding MathTransform", SolidWorks VBA example
   "Get the Normal and Origin of a Reference Plane Using Its Transform"). ArrayData[9:11]
   is the translation vector; the axis-aligned component gives the signed offset.
3. If position is wrong-side, flip the feature definition via IRefPlaneFeatureData, or
   recreate with the opposite flag — re-measuring after each step.
4. If it still won't land, DELETE the wrong plane and raise. A plane on the wrong side is
   worse than no plane: the next sketch goes on it and the extrude merges into the body
   already there (the verified_failed we chased).

pywin32 binding note
--------------------
Under dynamic COM dispatch (no gen_py cache), GetSpecificFeature2() returns a generic
IDispatch wrapper that does not expose IRefPlane members. The fix is win32com.client.CastTo
— the same pattern bridge.py uses for IPartDoc.GetBodies2. FeatureByName gives a cleaner
IFeature reference than the raw InsertRefPlane return value.
"""
from __future__ import annotations

from sw_agent.bridge import SWError, sw_get

# ---------------------------------------------------------------------------
# Constraint enum (swRefPlaneReferenceConstraints_e) — bit flags
# ---------------------------------------------------------------------------
# Source: rimptec.com mirror of swconst + SolidWorks VBA macro recorder output.
# The values are stable across all releases we support (2017–2026).

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

# Live-typelib constant names (used when a gen_py cache exists)
_CONST_NAMES = {
    "distance": "swRefPlaneReferenceConstraint_Distance",
    "flip":     "swRefPlaneReferenceConstraint_OptionFlip",
}

# World-axis index each standard plane's normal runs along. SolidWorks is Y-up:
#   Front = XY (normal Z=2), Top = XZ (normal Y=1), Right = YZ (normal X=0).
NORMAL_AXIS = {"front": 2, "top": 1, "right": 0}


def constraint_mask(kind: str) -> int:
    """Bit-flag value for InsertRefPlane. Prefers live typelib constants when a gen_py
    cache exists, otherwise the table above — same pattern as typelib.feature_id()."""
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
# Position reading — two clean routes, not a bag of fallbacks
# ---------------------------------------------------------------------------

def read_position(ctx, name: str, base: str) -> float | None:
    """Signed offset (metres) of the named datum plane along `base`'s normal.

    Returns None only when the plane's position is genuinely unreadable — never raises.

    Route A  IRefPlane.Transform (the documented approach)
             FeatureByName → GetSpecificFeature2 → CastTo("IRefPlane") → Transform →
             ArrayData[9 + axis]. CastTo is needed because pywin32 dynamic dispatch
             returns a generic wrapper that doesn't expose IRefPlane members.

    Route B  IRefPlaneFeatureData (definition readback)
             FeatureByName → GetDefinition → Distance + ReverseDirection → signed offset.
             Reads HOW the plane was defined, not its world position, but for offset planes
             from standard planes the two are identical.
    """
    axis = NORMAL_AXIS[base]

    # -- Route A: IRefPlane.Transform ------------------------------------------
    feat = _feature_by_name(ctx, name)
    if feat is not None:
        pos = _read_transform(feat, axis)
        if pos is not None:
            return pos

    # -- Route B: IRefPlaneFeatureData -----------------------------------------
    if feat is not None:
        pos = _read_definition(feat)
        if pos is not None:
            return pos

    return None


def _feature_by_name(ctx, name: str):
    """Get a feature by name — more reliable than holding the InsertRefPlane return."""
    try:
        return ctx.model.FeatureByName(name)
    except Exception:  # noqa: BLE001
        return None


def _read_transform(feat, axis: int) -> float | None:
    """Route A: IRefPlane.Transform → ArrayData[9 + axis].

    cadbooster.com: "the reference plane's transform is the transform that takes a
    reference plane from its canonical position/orientation to its actual position."
    IMathTransform.ArrayData is 16 doubles: [0:8] rotation, [9:11] translation, [12] scale.
    """
    import win32com.client as wc

    spec = None
    try:
        spec = sw_get(feat, "GetSpecificFeature2")
    except Exception:  # noqa: BLE001
        pass
    if spec is None:
        return None

    # Try CastTo("IRefPlane") — solves the dynamic-dispatch member resolution issue.
    for iface in ("IRefPlane", "RefPlane"):
        try:
            rp = wc.CastTo(spec, iface)
            xf = sw_get(rp, "Transform")
            arr = list(sw_get(xf, "ArrayData") or [])
            if len(arr) >= 12:
                return float(arr[9 + axis])
        except Exception:  # noqa: BLE001
            continue

    # Last resort: try without CastTo (works when early binding is already active)
    try:
        xf = sw_get(spec, "Transform")
        arr = list(sw_get(xf, "ArrayData") or [])
        if len(arr) >= 12:
            return float(arr[9 + axis])
    except Exception:  # noqa: BLE001
        pass

    return None


def _read_definition(feat) -> float | None:
    """Route B: IRefPlaneFeatureData.Distance + ReverseDirection.

    IRefPlaneFeatureData.Distance is documented as "distance to offset the reference
    plane" (despite the docs saying "in radians" — that's a doc bug for distance planes;
    the value is in metres). ReverseDirection / ReversedReferenceDirection gives the sign.
    """
    try:
        data = sw_get(feat, "GetDefinition")
        if data is None:
            return None
    except Exception:  # noqa: BLE001
        return None

    dist_m = None
    for attr in ("Distance", "Distance2"):
        try:
            raw = getattr(data, attr, None)
            if raw is None:
                continue
            # Distance might be a Dimension object with .SystemValue, or a plain float
            v = float(raw.SystemValue if hasattr(raw, "SystemValue") else raw)
            if abs(v) > 1e-12:
                dist_m = abs(v)
                break
        except Exception:  # noqa: BLE001
            continue

    if dist_m is None:
        return None

    # Read the direction flag
    flipped = False
    for prop in ("ReverseDirection", "ReversedReferenceDirection", "Reverse", "FlipDirection"):
        try:
            val = getattr(data, prop, None)
            if val is not None:
                flipped = bool(val)
                break
        except Exception:  # noqa: BLE001
            continue

    return -dist_m if flipped else dist_m


# ---------------------------------------------------------------------------
# Feature definition editing (flip direction)
# ---------------------------------------------------------------------------

def flip_definition(ctx, feat_or_name, value: bool) -> str | None:
    """Toggle the plane's direction via IRefPlaneFeatureData.

    Follows the documented pattern (cadbooster.com part 10):
      1. GetDefinition → IRefPlaneFeatureData
      2. AccessSelections
      3. Set ReverseDirection / ReversedReferenceDirection
      4. ModifyDefinition to commit, or ReleaseSelectionAccess to discard

    Returns the property name that accepted the write, or None on failure. Never raises.
    """
    feat = feat_or_name if not isinstance(feat_or_name, str) else _feature_by_name(ctx, feat_or_name)
    if feat is None:
        return None

    model = ctx.model
    try:
        data = sw_get(feat, "GetDefinition")
        if data is None:
            return None
    except Exception:  # noqa: BLE001
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
