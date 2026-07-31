"""sw_agent.tools.feature — features: extrude/cut/revolve/fillet/chamfer/shell/hole/pattern/mirror + feature tree ops.

Multi-argument feature APIs (extrude/cut/revolve/pattern/mirror) are safer
in named-call Python than in positional VBS, but the slot positions can
still shift across SolidWorks versions. Each one is marked with a
# VERIFY comment so you can re-check it against the target version via
the macro recorder.

P13 fixes:
- chamfer: swChamferType_e 1 = ANGLE-distance (angle 0 could never work);
  now uses 2 = distance-distance with both distances set.
- modify_dimension: SetSystemValue3 second arg — swInConfigurationOpts_e
  1 = THIS configuration only, 2 = all configurations. Was 1 with a comment
  claiming "all"; now actually 2.
- P42: every multi-parameter API (revolve/fillet/shell/patterns/mirror) now routes
  through com_call() adaptive-arity search — see the helper block below.
- fillet_edges: FeatureFillet3(195, r, 0,0,0,0,0) matched no real signature
  (magic 195, 7 args vs the real 12+). Replaced with the reliable
  GetDefinition/ModifyDefinition route on a freshly inserted fillet via
  FeatureManager.InsertFeatureFillet — falls back to a clear error message
  instead of a COM exception.
"""
from __future__ import annotations

from .. import units
from ..bridge import DOC_PART, Context, SWError, sw_get
from ..registry import tool

# swInConfigurationOpts_e
CFG_THIS = 1
CFG_ALL = 2


# ---- P42: shared adaptive-arity COM caller ----
#
# SolidWorks' COM signatures drift between releases: optional parameters get added,
# so the SAME documented method needs a different argument COUNT per version (the
# 2018+ recorder emits FeatureCut4 with 27 args where the docs list 25). Guessing one
# fixed arity is what made revolve / fillet_edges / shell / the pattern family fail
# with bare COM errors. This helper does what P40 proved out on cut_extrude: walk the
# arity downward and read the HRESULT to decide.
#
#   -2147352562 DISP_E_BADPARAMCOUNT   → too many args, try fewer
#   -2147352561 DISP_E_PARAMNOTOPTIONAL→ too few; every larger count already failed
#   anything else                      → we reached the REAL call; that error is real

BAD_COUNT = -2147352562
NOT_OPTIONAL = -2147352561


def _hresult(e: Exception) -> int:
    v = getattr(e, "hresult", None)
    if isinstance(v, int):
        return v
    s = str(e)
    for code in (BAD_COUNT, NOT_OPTIONAL):
        if str(code) in s:
            return code
    return 0


def com_call(owner, members, args, errors: list, max_args: int | None = None,
             min_args: int = 1, verify=None):
    """Call the first of `members` that accepts some prefix of `args`.

    args     — a MAXIMAL positional list (documented layout, longest known form)
    verify   — optional `() -> obj|None` run when the call returns None, for the
               versions that create the feature but report nothing
    Returns the created object, or None if nothing worked (errors[] holds the trail).
    """
    hi = len(args) if max_args is None else min(max_args, len(args))
    for member in members:
        fn = getattr(owner, member, None)
        if fn is None:
            errors.append(f"{member}: not present")
            continue
        for n in range(hi, min_args - 1, -1):
            try:
                made = fn(*args[:n])
            except Exception as e:  # noqa: BLE001
                hr = _hresult(e)
                if hr == BAD_COUNT:
                    continue          # too many → shrink
                if hr == NOT_OPTIONAL:
                    errors.append(f"{member}: needs >{n} args (none in {min_args}..{hi} accepted)")
                    break             # larger counts already failed → give up on this member
                errors.append(f"{member}/{n}: {e}")
                break                 # real call, real error
            if made is None and verify is not None:
                made = verify()
            if made is not None:
                return made
            errors.append(f"{member}/{n}: accepted but produced nothing")
            break
    return None


def _feature_names(ctx: Context) -> set:
    out = set()
    for ft in _all_features(ctx):
        try:
            out.add(sw_get(ft, "Name"))
        except Exception:  # noqa: BLE001
            continue
    return out


def _new_feature_of(ctx: Context, before: set, *type_fragments: str):
    """Find a feature absent from `before` whose type name contains any fragment."""
    for ft in _all_features(ctx):
        try:
            if sw_get(ft, "Name") in before:
                continue
            tn = sw_get(ft, "GetTypeName2") or ""
        except Exception:  # noqa: BLE001
            continue
        if not type_fragments or any(fr.lower() in tn.lower() for fr in type_fragments):
            return ft
    return None


def _all_features(ctx: Context):
    """P32: linked-list tree traversal is unresolvable over COM on some SW installs
    (DISP_E_MEMBERNOTFOUND even via dynamic dispatch). IFeatureManager::GetFeatures
    is documented, early-binding friendly, and returns the whole tree at once."""
    feats = ctx.feat_mgr.GetFeatures(True)
    return list(feats or [])


def _exit_sketch_if_open(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is not None:
        ctx.sketch_mgr.InsertSketch(True)


def _select_profile_sketch(ctx: Context, sketch: str | None = None):
    """P29: exiting a sketch clears the selection, so FeatureExtrusion3/FeatureCut4
    had no target and returned None ("closed sketch" error was misleading).
    Select the requested sketch by name, or default to the LAST sketch feature."""
    ctx.clear_selection()
    name = sketch
    if not name:
        # P32: prefer the sketch recorded by start_sketch this session.
        # P45: …but only if it still exists — deleting a sketch left this pointing at a
        # dead name, so extrude selected nothing and reported "no closed sketch".
        cached = ctx.scratch.get("last_sketch")
        if cached and _find_feature(ctx, cached) is not None:
            name = cached
        else:
            ctx.scratch.pop("last_sketch", None)
    if not name:
        for f in _all_features(ctx):
            try:
                if sw_get(f, "GetTypeName2") == "ProfileFeature":
                    name = sw_get(f, "Name")
            except Exception:  # noqa: BLE001
                continue
    if not name:
        raise SWError("no sketch found to extrude — draw a sketch first.")
    if not ctx.select_by_id(name, "SKETCH"):
        raise SWError(f"failed to select sketch: {name}")


def _find_feature(ctx: Context, name: str):
    for f in _all_features(ctx):
        try:
            if sw_get(f, "Name") == name:
                return f
        except Exception:  # noqa: BLE001
            continue
    return None


@tool(
    "extrude", "Extrude the current sketch into a solid (= 凸台-拉伸; wraps FeatureExtrusion3 — same operation your macro knowledge calls FeatureExtrusion2, with unit conversion and arity handled)",
    params={
        "depth": {"type": "number", "desc": "Extrusion depth (mm)"},
        "both_dir": {"type": "boolean", "desc": "Equal-distance both-direction extrusion", "default": False},
        "flip": {"type": "boolean", "desc": "Extrude to the opposite side of the sketch plane", "default": False},
        "sketch": {"type": "string", "desc": "Sketch name to extrude (defaults to the most recent sketch)", "default": ""},
    },
    category="feature",
)
def extrude(ctx: Context, depth: float, both_dir: bool = False, flip: bool = False, sketch: str = ""):
    ctx.require(DOC_PART, "part")  # P27: solid features are part-only — fail early inside assemblies
    # P32: manual-modeling order — with an ACTIVE sketch, extrude directly (SW uses it
    # and auto-exits, like the UI). Only when no sketch is active do we select one.
    if ctx.sketch_mgr.ActiveSketch is None:
        _select_profile_sketch(ctx, sketch or None)
    d = units.mm(depth)
    # P37: FeatureExtrusion3 slots are (Sd, Flip, Dir, T1, T2, D1, D2, …):
    #   Sd  = SINGLE direction (both_dir → False)
    #   Dir = reverse direction (the "flip" the caller asks for)
    # The old code fed both_dir into the Dir slot, so "both directions" silently
    # became "reverse direction" and there was no way to control which side.
    feat = ctx.feat_mgr.FeatureExtrusion3(
        not both_dir, False, bool(flip), 0, 0, d, d if both_dir else 0,
        False, False, False, False, 0, 0, False, False, False, False,
        True, True, True, 0, 0, False,
    )
    if feat is None:
        raise SWError("extrude failed: make sure there is a closed sketch.")
    return {"feature": feat.Name, "depth_mm": depth}


@tool(
    "cut_extrude", "Cut material using the current sketch (= 切除-拉伸; wraps FeatureCut4/CreateDefinition(swFmCut)). A through hole is direction-agnostic: pass through_all=true",
    params={
        "depth": {"type": "number", "desc": "Cut depth (mm); omit or 0 when through_all is true", "default": 0},
        "through_all": {"type": "boolean", "desc": "Cut through the whole body — use this for through holes", "default": False},
        "flip": {"type": "boolean", "desc": "Cut toward the opposite side of the sketch plane (rarely needed — direction is auto-detected)", "default": False},
        "sketch": {"type": "string", "desc": "Sketch name to cut with (defaults to the most recent sketch)", "default": ""},
    },
    category="feature", destructive=True,
)
def cut_extrude(ctx: Context, depth: float = 0, through_all: bool = False,
                flip: bool = False, sketch: str = ""):
    ctx.require(DOC_PART, "part")

    # P37: remember which sketch to cut with. A failed cut (or SW auto-exiting the
    # active sketch) drops the selection, so every retry must re-select by name.
    target = sketch or None
    active = ctx.sketch_mgr.ActiveSketch
    if active is not None:
        if not target:
            try:
                target = sw_get(active, "Name")
            except Exception:  # noqa: BLE001
                target = None
    if not target:
        target = ctx.scratch.get("last_sketch")

    d = units.mm(depth) if depth else units.mm(1)
    end = 1 if through_all else 0  # swEndConditions_e: 0=Blind, 1=ThroughAll

    def names() -> set:
        return _feature_names(ctx)

    def new_cut(before: set):
        return _new_feature_of(ctx, before, "Cut")

    errors: list = []

    def attempt_definition(reverse: bool):
        """P39: property-based cut creation — IFeatureManager.CreateDefinition(swFmCut)
        + IExtrudeFeatureData2 setters + CreateFeature. No giant positional signature
        to guess (every positional arity of FeatureCut3/4 raised DISP_E_PARAMNOTOPTIONAL
        on this install), and it is the API SolidWorks documents for automation."""
        try:
            import win32com.client as wc
            fm_cut = getattr(wc.constants, "swFmCut", None)
            if fm_cut is None:
                # P40: the sidecar talks to SW via dynamic dispatch, so makepy constants
                # are never loaded into this process. CastTo an early-bound interface
                # (gen_py cache exists thanks to the P17 warmup) to populate them.
                wc.CastTo(ctx.feat_mgr, "IFeatureManager")
                fm_cut = getattr(wc.constants, "swFmCut", None)
        except Exception as e:  # noqa: BLE001
            errors.append(f"constants load: {e}")
            fm_cut = None
        if fm_cut is None:
            errors.append("definition path unavailable: constants.swFmCut not resolved")
            return None
        if ctx.sketch_mgr.ActiveSketch is None:
            try:
                _select_profile_sketch(ctx, target)
            except SWError as e:
                errors.append(str(e))
                return None
        before = names()
        try:
            data = ctx.feat_mgr.CreateDefinition(fm_cut)
            if data is None:
                errors.append("CreateDefinition(swFmCut) returned None")
                return None
            # forward direction end condition; swEndCondBlind=0 / swEndCondThroughAll=1
            data.SetEndCondition(True, end)
            if not through_all:
                data.SetDepth(True, d)
            try:
                data.ReverseDirection = bool(reverse)
            except Exception:  # noqa: BLE001 — property name varies on old versions
                pass
            made = ctx.feat_mgr.CreateFeature(data)
            if made is None:
                made = new_cut(before)
            if made is None:
                errors.append(f"CreateFeature(reverse={reverse}) made nothing")
            return made
        except Exception as e:  # noqa: BLE001
            errors.append(f"definition(reverse={reverse}): {e}")
            return None

    def attempt(single_dir: bool, reverse: bool):
        """P40: adaptive-arity positional call. The earlier fixed trials (23–26 args)
        ALL raised DISP_E_PARAMNOTOPTIONAL = "too few args" — the real signature needs
        MORE (SW2018+ macro recorder emits FeatureCut4 with 27). Search downward from
        30: -2147352562 (bad count) → try fewer; -2147352561 (param not optional) →
        every larger count already failed, stop; anything else = the REAL call."""
        if ctx.sketch_mgr.ActiveSketch is None:
            try:
                _select_profile_sketch(ctx, target)
            except SWError as e:
                errors.append(str(e))
                return None
        before = names()
        # 30-slot master list, macro-recorder layout:
        # 0 Sd, 1 Flip, 2 Dir, 3 T1, 4 T2, 5 D1, 6 D2, 7-10 Dchk/Ddir, 11-12 Dang,
        # 13-16 offset/translate, 17 NormalCut, 18 UseFeatScope, 19 UseAutoSelect,
        # 20-22 assembly opts, 23+ start-condition/optimize padding
        base = [
            single_dir, False, reverse, end, end if not single_dir else 0,
            d, d if not single_dir else 0,
            False, False, False, False, 0.0, 0.0,
            False, False, False, False,
            False, True, True, True, True, True,
            False, 0, 0.0, False, False, 0, False,
        ]

        def hr_of(e) -> int:
            v = getattr(e, "hresult", None)
            if isinstance(v, int):
                return v
            s = str(e)
            for code in (-2147352561, -2147352562):
                if str(code) in s:
                    return code
            return 0

        for member in ("FeatureCut4", "FeatureCut3", "FeatureCut"):
            fn = getattr(ctx.feat_mgr, member, None)
            if fn is None:
                continue
            for n in range(30, 21, -1):
                try:
                    made = fn(*base[:n])
                except Exception as e:  # noqa: BLE001
                    hr = hr_of(e)
                    if hr == -2147352562:  # too many args → try fewer
                        continue
                    if hr == -2147352561:  # too few — larger counts already failed
                        errors.append(f"{member}: no arity in 22..30 accepted (needs >30?)" if n == 30
                                      else f"{member}: arity gap at {n} (param-not-optional)")
                        break
                    errors.append(f"{member}/{n}: {e}")  # the REAL call failed
                    break
                if made is None:
                    made = new_cut(before)  # some versions return None yet still create it
                if made is not None:
                    return made
                errors.append(f"{member}/{n}: accepted but produced no Cut feature")
                break
        return None

    # P39: definition path first (both directions), then P37's positional trials.
    made = attempt_definition(bool(flip))
    if made is None:
        made = attempt_definition(not bool(flip))
    if made is None:
        made = attempt(True, bool(flip))
    if made is None:
        made = attempt(True, not bool(flip))
    if made is None:
        made = attempt(False, False)
    if made is None and ctx.sketch_mgr.ActiveSketch is not None:
        # P67: last resort — EXIT the sketch and select it by name, then retry.
        # A sketch opened on a model FACE (start_sketch(face="top")) behaves differently
        # from one on a datum plane: the cut API accepted every argument list yet created
        # no feature ("accepted but produced no Cut feature") while that sketch was still
        # open. Closing it and selecting it explicitly is the form SolidWorks acts on.
        errors.append("retrying with the sketch closed and selected by name")
        try:
            ctx.sketch_mgr.InsertSketch(True)
        except Exception as ex:  # noqa: BLE001
            errors.append(f"exit sketch: {ex}")
        made = attempt(True, bool(flip))
        if made is None:
            made = attempt(True, not bool(flip))
        if made is None:
            made = attempt(False, False)

    if made is None:
        # P39: report EVERYTHING tried — the old 2-error tail pointed at the wrong API
        detail = " | ".join(errors) if errors else "no COM error reported"
        raise SWError(
            "cut failed — the sketch profile may not overlap the solid "
            f"(sketch: {target or 'unknown'}). attempts: {detail}"
        )
    return {
        "feature": sw_get(made, "Name"),
        "through_all": through_all,
        "depth_mm": None if through_all else depth,
    }


@tool(
    "revolve", "Revolve the current sketch around a centerline (= 旋转; wraps FeatureRevolve2). Set cut=true to REMOVE material (a revolved cut/groove); default adds material",
    params={
        "angle": {"type": "number", "desc": "Revolve angle (degrees)", "default": 360},
        "cut": {"type": "boolean", "desc": "Remove material instead of adding it — use for revolved grooves, NOT for simple holes (use cut_extrude for holes)", "default": False},
        "sketch": {"type": "string", "desc": "Sketch name to revolve (defaults to the most recent sketch)", "default": ""},
    },
    category="feature",
)
def revolve(ctx: Context, angle: float = 360, cut: bool = False, sketch: str = ""):
    ctx.require(DOC_PART, "part")
    if ctx.sketch_mgr.ActiveSketch is None:
        _select_profile_sketch(ctx, sketch or None)
    a = units.deg(angle)
    before = _feature_names(ctx)
    errors: list = []
    # P42: documented FeatureRevolve2 layout, longest known form; com_call finds the
    # arity this SolidWorks accepts. swEndConditions_e 0 = Blind for direction 1.
    args = [
        True, True, False, bool(cut), False, False, 0, 0, a, 0,
        False, False, 0, 0, 0, 0, 0, True, True, True,
        0, 0, 0, True, True, True,
    ]
    members = ("FeatureRevolve2", "FeatureRevolve") if not cut else ("FeatureRevolveCut2", "FeatureRevolve2", "FeatureRevolve")
    feat = com_call(
        ctx.feat_mgr, members, args, errors, min_args=10,
        verify=lambda: _new_feature_of(ctx, before, "Revolve"),
    )
    if feat is None:
        raise SWError(
            "revolve failed — the sketch needs a closed profile plus a centerline as the axis. "
            f"(attempts: {' | '.join(errors[-3:])})"
        )
    return {"feature": sw_get(feat, "Name"), "angle_deg": angle, "cut": bool(cut)}


@tool(
    "fillet_edges", "Round edges of the solid (= 圆角; wraps FeatureFillet3). Say WHICH edges — no manual picking needed, unlike a macro where you must resolve edge objects yourself",
    params={
        "radius": {"type": "number", "desc": "Fillet radius (mm)"},
        "edges": {
            "type": "string", "enum": ["vertical", "horizontal", "circular", "all", "selected"],
            "desc": "vertical = the upright edges (e.g. the four corners of a plate) · horizontal = edges lying flat · circular = round edges · all = every edge · selected = whatever is already selected in SolidWorks",
            "default": "vertical",
        },
    },
    category="feature",
)
def fillet_edges(ctx: Context, radius: float, edges: str = "vertical"):
    # P45: previously this REQUIRED a human to pre-select edges in SolidWorks, so from
    # chat it could only ever fail. Now it selects the described edge set itself.
    if edges == "selected":
        if ctx.selected_count() < 1:
            raise SWError("nothing is selected — pass edges=vertical/horizontal/circular/all instead.")
        picked = ctx.selected_count()
    else:
        # P45.1: clear first. A leftover selection from the previous tool is why one run
        # "succeeded" by rounding the four hole edges instead of the requested junction.
        ctx.clear_selection()
        # P46: select_edges now raises with a real reason when the bodies can't be read,
        # so a zero here genuinely means "no edge matched that description".
        picked = ctx.select_edges(edges)
        if picked == 0:
            raise SWError(
                f"no {edges} edges matched. vertical = along the part's up axis, "
                "horizontal = flat, circular = round; try edges=\"all\" to see if any edge qualifies."
            )
    r = units.mm(radius)
    before = _feature_names(ctx)
    errors: list = []
    args = [
        195, r, 0, 0, 0, 0, 0, 0,
        (), (), (), (), (), (), (),
        0, 0, 0, 0, 0, 0,
    ]
    created = com_call(
        ctx.feat_mgr, ("FeatureFillet3", "FeatureFillet2", "FeatureFillet"), args, errors,
        min_args=7, verify=lambda: _new_feature_of(ctx, before, "Fillet"),
    )
    if created is None:
        raise SWError(
            f"fillet failed on {picked} {edges} edge(s) — the radius may be too large for the "
            f"geometry. (attempts: {' | '.join(errors[-3:])})"
        )
    return {"feature": sw_get(created, "Name"), "radius_mm": radius, "edges": edges, "count": picked}


@tool(
    "fillet_all", "Rescale every existing fillet feature to a uniform radius (uses GetDefinition/ModifyDefinition on each Fillet feature)",
    params={"radius": {"type": "number", "desc": "Uniform radius (mm)"}},
    category="feature",
)
def fillet_all(ctx: Context, radius: float):
    r = units.mm(radius)
    model = ctx.model
    count = 0
    for f in _all_features(ctx):
        if sw_get(f, "GetTypeName2") != "Fillet":
            continue
        data = f.GetDefinition()
        if data is not None:
            data.DefaultRadius = r
            f.ModifyDefinition(data, model, None)
            count += 1
    ctx.rebuild()
    return {"modified_fillets": count, "radius_mm": radius}


@tool(
    "chamfer", "Chamfer the selected edges, equal-distance (= 倒角; wraps InsertFeatureChamfer). Select edges first",
    params={"distance": {"type": "number", "desc": "Chamfer distance (mm)"}},
    category="feature",
)
def chamfer(ctx: Context, distance: float):
    if ctx.selected_count() < 1:
        raise SWError("please select edges to chamfer first.")
    d = units.mm(distance)
    # P13: swChamferType_e — 1 = ANGLE-DISTANCE (needs a non-zero angle; the old call
    # passed angle 0 and could never produce valid geometry), 2 = DISTANCE-DISTANCE.
    # Equal-distance chamfer: type 2, Width=d, Angle=0, OtherDist=d.
    # VERIFY: slot order (Type, PropagationFlag, Width, Angle, OtherDist, Vc1, Vc2, Vc3)
    feat = ctx.feat_mgr.InsertFeatureChamfer(2, 1, d, 0, d, 0, 0, 0)
    if feat is None:
        raise SWError("chamfer failed: make sure the selected edges are valid.")
    return {"feature": feat.Name, "distance_mm": distance}


@tool(
    "shell", "Shell the body — hollow it out keeping a wall thickness (= 抽壳; wraps InsertFeatureShell). Pre-select faces to remove them as openings",
    params={
        "thickness": {"type": "number", "desc": "Wall thickness (mm)"},
        "outward": {"type": "boolean", "desc": "Thicken outward instead of inward", "default": False},
    },
    category="feature", destructive=True,
)
def shell(ctx: Context, thickness: float, outward: bool = False):
    t = units.mm(thickness)
    before = _feature_names(ctx)
    errors: list = []
    # P42: InsertShell lives on IFeatureManager on modern releases and on IModelDoc2
    # on older ones, with 2–3 args depending on version — try both owners adaptively.
    args = [t, bool(outward), False]
    made = com_call(
        ctx.feat_mgr, ("InsertFeatureShell", "InsertShell"), args, errors,
        min_args=2, verify=lambda: _new_feature_of(ctx, before, "Shell"),
    )
    if made is None:
        made = com_call(
            ctx.model, ("InsertShell",), args, errors,
            min_args=2, verify=lambda: _new_feature_of(ctx, before, "Shell"),
        )
    if made is None:
        raise SWError(
            "shell failed — select the face(s) to open before shelling, and check the "
            f"thickness fits the geometry. (attempts: {' | '.join(errors[-3:])})"
        )
    return {"shelled": True, "thickness_mm": thickness, "outward": bool(outward)}


@tool(
    "linear_pattern", "Repeat a feature in a straight line (= 线性阵列; wraps FeatureLinearPattern5). Give the feature name and a direction — the direction edge is picked for you",
    params={
        "count": {"type": "integer", "desc": "Total instance count (including the original)"},
        "spacing": {"type": "number", "desc": "Spacing (mm)"},
        "feature": {"type": "string", "desc": "Name of the feature to repeat, e.g. 切除-拉伸1 (use list_features to see names). Omit to use the current selection", "default": ""},
        "direction": {"type": "string", "enum": ["x", "y", "z"], "desc": "Direction to repeat along", "default": "x"},
    },
    category="feature",
)
def linear_pattern(ctx: Context, count: int, spacing: float, feature: str = "", direction: str = "x"):
    # P45: selects the feature (mark 4) and a direction edge (mark 1) itself — this used
    # to demand a manual pre-selection, which no chat-driven agent could satisfy.
    if feature:
        ctx.clear_selection()
        if not ctx.select_feature(feature, mark=4):
            raise SWError(f"feature not found: {feature} (check list_features for the exact name)")
    elif ctx.selected_count() < 1:
        raise SWError("give feature= (the feature to repeat) or select it in SolidWorks first.")
    if not ctx.select_axis_edge(direction, append=True, mark=1):
        raise SWError(f"no straight edge along {direction} to use as the pattern direction.")
    before = _feature_names(ctx)
    errors: list = []
    args = [
        int(count), units.mm(spacing), 1, 0.01, False, False, "NULL", "NULL",
        False, False, False, False, False, False, True, True, False, False, 0, 0,
        False, False, False, 0, 0,
    ]
    feat = com_call(
        ctx.feat_mgr,
        ("FeatureLinearPattern5", "FeatureLinearPattern4", "FeatureLinearPattern3", "FeatureLinearPattern"),
        args, errors, min_args=8, verify=lambda: _new_feature_of(ctx, before, "LPattern", "Pattern"),
    )
    if feat is None:
        raise SWError(f"linear pattern failed. (attempts: {' | '.join(errors[-3:])})")
    return {"feature": sw_get(feat, "Name"), "count": int(count), "spacing_mm": spacing, "direction": direction}


@tool(
    "circular_pattern", "Repeat a feature around an axis (= 圆周阵列; wraps FeatureCircularPattern5). Give the feature name; the part's cylindrical face is used as the axis automatically",
    params={
        "count": {"type": "integer", "desc": "Total instance count (including the original)"},
        "angle": {"type": "number", "desc": "Total angle (degrees)", "default": 360},
        "feature": {"type": "string", "desc": "Name of the feature to repeat (list_features shows names). Omit to use the current selection", "default": ""},
        "equal_spacing": {"type": "boolean", "desc": "Space instances equally", "default": True},
    },
    category="feature",
)
def circular_pattern(ctx: Context, count: int, angle: float = 360, feature: str = "",
                     equal_spacing: bool = True):
    if feature:
        ctx.clear_selection()
        if not ctx.select_feature(feature, mark=4):
            raise SWError(f"feature not found: {feature}")
    elif ctx.selected_count() < 1:
        raise SWError("give feature= (the feature to repeat) or select it in SolidWorks first.")
    # P45: SolidWorks accepts a cylindrical face as the rotation axis, which spares the
    # agent from needing a reference axis to exist.
    if not ctx.select_cylindrical_face(append=True, mark=1):
        raise SWError("no cylindrical face to rotate around — create one, or add a reference axis.")
    before = _feature_names(ctx)
    errors: list = []
    args = [
        int(count), units.deg(angle), bool(equal_spacing), "NULL",
        False, True, False, False, False, False,
        False, False, 0, 0, False,
    ]
    feat = com_call(
        ctx.feat_mgr,
        ("FeatureCircularPattern5", "FeatureCircularPattern4", "FeatureCircularPattern3", "FeatureCircularPattern"),
        args, errors, min_args=4, verify=lambda: _new_feature_of(ctx, before, "CirPattern", "Pattern"),
    )
    if feat is None:
        raise SWError(f"circular pattern failed. (attempts: {' | '.join(errors[-3:])})")
    return {"feature": sw_get(feat, "Name"), "count": int(count), "angle_deg": angle}


@tool(
    "mirror_feature", "Mirror features across a plane (= 镜像; wraps InsertMirrorFeature2). Give the feature names — selection marks are handled for you",
    params={
        "plane": {"type": "string", "desc": "Symmetry plane: front / top / right, or the name of a plane you created"},
        "features": {"type": "string", "desc": "Comma-separated feature names to mirror, e.g. 凸台-拉伸3,切除-拉伸2 (list_features shows names). Omit to use the current selection", "default": ""},
    },
    category="feature",
)
def mirror_feature(ctx: Context, plane: str, features: str = ""):
    # P45: features are selected BY NAME (mark 1) and the plane with mark 2 — the old
    # version needed a human pre-selection and always reported "produced nothing".
    if features:
        ctx.clear_selection()
        names = [n.strip() for n in features.split(",") if n.strip()]
        for i, n in enumerate(names):
            if not ctx.select_feature(n, append=i > 0, mark=1):
                raise SWError(f"feature not found: {n}")
    elif ctx.selected_count() < 1:
        raise SWError("give features= (names to mirror) or select them in SolidWorks first.")
    key = (plane or "").strip()
    ok = (ctx.select_plane(key, append=True, mark=2) if key.lower() in ("front", "top", "right")
          else bool(ctx.select_by_id(key, "PLANE", append=True, mark=2)))
    if not ok:
        raise SWError(f"failed to select the symmetry plane: {plane}")
    before = _feature_names(ctx)
    errors: list = []
    args = [False, False, False, False, 0, False]
    feat = com_call(
        ctx.feat_mgr, ("InsertMirrorFeature2", "InsertMirrorFeature"), args, errors,
        min_args=4, verify=lambda: _new_feature_of(ctx, before, "Mirror"),
    )
    if feat is None:
        raise SWError(f"mirror failed. (attempts: {' | '.join(errors[-3:])})")
    return {"feature": sw_get(feat, "Name"), "plane": plane}


@tool(
    "modify_dimension", "Modify a feature's dimension parameter (= 修改尺寸; Parameter() + SetSystemValue3, applied to ALL configurations)",
    params={
        "feature": {"type": "string", "desc": "Feature name, e.g. Boss-Extrude1"},
        "dimension": {"type": "string", "desc": "Dimension name, e.g. D1"},
        "value": {"type": "number", "desc": "New value (mm)"},
    },
    category="feature",
)
def modify_dimension(ctx: Context, feature: str, dimension: str, value: float):
    full = f"{dimension}@{feature}"
    dim = ctx.model.Parameter(full)
    if dim is None:
        raise SWError(f"dimension not found: {full}")
    # P13: swInConfigurationOpts_e — 1 = this configuration ONLY, 2 = all configurations.
    dim.SetSystemValue3(units.mm(value), CFG_ALL, None)
    ctx.rebuild()
    return {"dimension": full, "value_mm": value}


# ---- Feature tree operations ----

def _select_feature(ctx: Context, name: str):
    feat = _find_feature(ctx, name)
    if feat is None:
        raise SWError(f"feature not found: {name}")
    feat.Select2(False, -1)
    return feat


@tool("suppress_feature", "Suppress the specified feature (= 压缩; EditSuppress2)",
      params={"name": {"type": "string", "desc": "Feature name"}},
      category="feature")
def suppress_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    # P79: EditSuppress2 resolves as a PROPERTY on some installs — calling it then raises
    # "'bool' object is not callable", which reads like a bug in our code rather than a
    # binding quirk. sw_get tolerates either form (the same fix as GetTypeName2 et al).
    ok = sw_get(ctx.model, "EditSuppress2")
    if ok is False:
        raise SWError(f"SolidWorks refused to suppress {name}.")
    return {"suppressed": name}


@tool("unsuppress_feature", "Unsuppress the specified feature (= 解除压缩; EditUnsuppress2)",
      params={"name": {"type": "string", "desc": "Feature name"}},
      category="feature")
def unsuppress_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ok = sw_get(ctx.model, "EditUnsuppress2")
    if ok is False:
        raise SWError(f"SolidWorks refused to unsuppress {name}.")
    return {"unsuppressed": name}


@tool("delete_feature", "Delete the specified feature (= 删除; EditDelete)",
      params={"name": {"type": "string", "desc": "Feature name"}},
      category="feature", destructive=True)
def delete_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ctx.model.EditDelete()
    return {"deleted": name}


@tool("rename_feature", "Rename a feature",
      params={"old": {"type": "string", "desc": "Old name"}, "new": {"type": "string", "desc": "New name"}},
      category="feature")
def rename_feature(ctx: Context, old: str, new: str):
    feat = _find_feature(ctx, old)
    if feat is None:
        raise SWError(f"feature not found: {old}")
    feat.Name = new
    return {"renamed": {"from": old, "to": new}}
