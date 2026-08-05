"""sw_agent.refplane — datum-plane creation with verified positioning (P119).

History
-------
P105/P114 guessed wrong enum values (Flip=15, SelectOption=16 — neither exists).
P116/P118 replaced that with two documented COM routes (IRefPlane.Transform via
CastTo, and IRefPlaneFeatureData.Distance) — correct on paper, but BOTH still
returned "position unreadable" on the real test machine (SW 2025 v31.0.1). Every
internal helper caught its exception with a bare `except: pass`, so there was no
way to tell WHICH step failed — CastTo itself? Transform after a successful cast?
GetDefinition? Guessing a fourth mechanism blind would repeat the same mistake a
third time.

P119 changes two things:
  1. Every route now returns (value, trace) — the exception text from each
     attempted step, so a failure is diagnosable instead of a dead end.
  2. Added Route C: a temporary sketch on the plane, read via
     ISketch.ModelToSketchTransform. This is a DIFFERENT interface than
     IRefPlane/IRefPlaneFeatureData, and one already proven to resolve fine on
     this exact install — verify.py's snapshot() successfully calls
     `sketch_mgr.ActiveSketch.GetSketchSegments()` elsewhere in this codebase.
     If IRefPlane specifically fails to resolve under dynamic dispatch on this
     machine, ISketch is a load-bearing member that already works, so it is a
     structurally different bet, not a variation on the same one.

Design (unchanged from P118)
-----------------------------
1. Create the plane with InsertRefPlane, passing Distance|Flip (264) for negative
   offsets (swRefPlaneReferenceConstraint_OptionFlip = 256, Distance = 8).
2. Read the plane's actual position (three routes now, see below).
3. Wrong side → flip the feature definition, else recreate with the opposite flag.
4. Still wrong → delete the plane and raise. A plane on the wrong side is worse
   than no plane — the next sketch lands on it and the extrude merges into the
   solid already there (the verified_failed this whole chain chases).
"""
from __future__ import annotations

from sw_agent.bridge import SWError, sw_get

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

    FeatureByName → GetSpecificFeature2 → CastTo("IRefPlane") → Transform.
    CastTo is needed because pywin32 dynamic dispatch returns a generic wrapper
    that does not expose IRefPlane members without it.
    """
    import win32com.client as wc

    try:
        spec = sw_get(feat, "GetSpecificFeature2")
    except Exception as e:  # noqa: BLE001
        return None, f"GetSpecificFeature2 raised {e!r}"
    if spec is None:
        return None, "GetSpecificFeature2 returned None"

    attempts = []
    for iface in ("IRefPlane", "RefPlane"):
        try:
            rp = wc.CastTo(spec, iface)
            if rp is None or rp is False:
                attempts.append(f"CastTo({iface}) returned {rp!r}")
                continue
            xf = sw_get(rp, "Transform")
            arr = list(sw_get(xf, "ArrayData") or [])
            if len(arr) >= 12:
                return float(arr[9 + axis]), f"ok via CastTo({iface})"
            attempts.append(f"CastTo({iface}): ArrayData len={len(arr)}")
        except Exception as e:  # noqa: BLE001
            attempts.append(f"CastTo({iface}) raised {e!r}")

    try:
        xf = sw_get(spec, "Transform")
        arr = list(sw_get(xf, "ArrayData") or [])
        if len(arr) >= 12:
            return float(arr[9 + axis]), "ok via direct .Transform (no CastTo needed)"
        attempts.append(f"direct .Transform: ArrayData len={len(arr)}")
    except Exception as e:  # noqa: BLE001
        attempts.append(f"direct .Transform raised {e!r}")

    return None, "; ".join(attempts)


def _read_definition(feat):
    """Route B: IRefPlaneFeatureData.Distance + ReverseDirection."""
    try:
        data = sw_get(feat, "GetDefinition")
    except Exception as e:  # noqa: BLE001
        return None, f"GetDefinition raised {e!r}"
    if data is None:
        return None, "GetDefinition returned None"

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

        xf = None
        try:
            xf = sw_get(act, "ModelToSketchTransform")
        except Exception as e:  # noqa: BLE001
            return None, f"ModelToSketchTransform raised {e!r}"
        if xf is None:
            return None, "ModelToSketchTransform returned None"

        inv = None
        inv_notes = []
        for m in ("IInverse", "Inverse"):
            try:
                fn = getattr(xf, m, None)
                if fn is None:
                    continue
                inv = fn() if callable(fn) else fn
                if inv is not None:
                    break
            except Exception as e:  # noqa: BLE001
                inv_notes.append(f"{m} raised {e!r}")
        if inv is None:
            return None, "; ".join(inv_notes) or "no Inverse/IInverse method"

        arr = list(sw_get(inv, "ArrayData") or [])
        if len(arr) < 12:
            return None, f"inverse ArrayData len={len(arr)}"
        return float(arr[9 + axis]), "ok"
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
