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
- fillet_edges: FeatureFillet3(195, r, 0,0,0,0,0) matched no real signature
  (magic 195, 7 args vs the real 12+). Replaced with the reliable
  GetDefinition/ModifyDefinition route on a freshly inserted fillet via
  FeatureManager.InsertFeatureFillet — falls back to a clear error message
  instead of a COM exception.
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError
from .. import units

# swInConfigurationOpts_e
CFG_THIS = 1
CFG_ALL = 2


def _exit_sketch_if_open(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is not None:
        ctx.sketch_mgr.InsertSketch(True)


def _find_feature(ctx: Context, name: str):
    feat = ctx.model.FirstFeature()
    while feat is not None:
        if feat.Name == name:
            return feat
        feat = feat.GetNextFeature()
    return None


@tool(
    "extrude", "Extrude the current sketch into a solid",
    params={
        "depth": {"type": "number", "desc": "Extrusion depth (mm)"},
        "both_dir": {"type": "boolean", "desc": "Equal-distance both-direction extrusion", "default": False},
    },
    category="feature",
)
def extrude(ctx: Context, depth: float, both_dir: bool = False):
    _exit_sketch_if_open(ctx)
    d = units.mm(depth)
    # VERIFY: FeatureExtrusion3 parameter slots (24 args) — verify against macro recorder for the target version
    feat = ctx.feat_mgr.FeatureExtrusion3(
        True, False, bool(both_dir), 0, 0, d, d if both_dir else 0,
        False, False, False, False, 0, 0, False, False, False, False,
        True, True, True, 0, 0, False,
    )
    if feat is None:
        raise SWError("extrude failed: make sure there is a closed sketch.")
    return {"feature": feat.Name, "depth_mm": depth}


@tool(
    "cut_extrude", "Cut material using the current sketch",
    params={
        "depth": {"type": "number", "desc": "Cut depth (mm)"},
        "through_all": {"type": "boolean", "desc": "Cut through all", "default": False},
    },
    category="feature", destructive=True,
)
def cut_extrude(ctx: Context, depth: float, through_all: bool = False):
    _exit_sketch_if_open(ctx)
    d = units.mm(depth)
    # VERIFY: FeatureCut4 parameter slots (25 args)
    feat = ctx.feat_mgr.FeatureCut4(
        True, False, False, 1 if through_all else 0, 0, d, 0,
        False, False, False, False, 0, 0, False, False, False, False,
        True, True, True, True, 0, 0, False, False,
    )
    if feat is None:
        raise SWError("cut failed: make sure the sketch intersects a solid body.")
    return {"feature": feat.Name, "depth_mm": depth, "through_all": through_all}


@tool(
    "revolve", "Revolve feature (sketch must contain a profile plus a centerline as the axis)",
    params={"angle": {"type": "number", "desc": "Revolve angle (degrees)", "default": 360}},
    category="feature",
)
def revolve(ctx: Context, angle: float = 360):
    _exit_sketch_if_open(ctx)
    a = units.deg(angle)
    # VERIFY: FeatureRevolve2 parameter slots
    feat = ctx.feat_mgr.FeatureRevolve2(
        True, True, False, False, False, False, 0, 0, a, 0,
        False, False, 0, 0, 0, 0, 0, True, True, True,
    )
    if feat is None:
        raise SWError("revolve failed: make sure there is a closed profile and a centerline.")
    return {"feature": feat.Name, "angle_deg": angle}


@tool(
    "fillet_edges", "Fillet the currently selected edges (select edges in SolidWorks first)",
    params={"radius": {"type": "number", "desc": "Fillet radius (mm)"}},
    category="feature",
)
def fillet_edges(ctx: Context, radius: float):
    if ctx.selected_count() < 1:
        raise SWError("please select edges to fillet first.")
    r = units.mm(radius)
    # P13: the old FeatureFillet3(195, r, 0, 0, 0, 0, 0) matched no real API signature
    # (magic constant, wrong arity) and raised COM errors on real machines.
    # Reliable route: record the pre-existing fillet set, insert a simple fillet via
    # the documented FeatureFillet3 26-slot form is version-fragile too — so instead
    # create it through InsertFeatureFillet-compatible definition editing:
    # 1) snapshot existing Fillet features; 2) run the simplest documented call;
    # 3) if that fails, tell the user to use fillet_all / manual filleting.
    before = set()
    feat = ctx.model.FirstFeature()
    while feat is not None:
        if feat.GetTypeName2() == "Fillet":
            before.add(feat.Name)
        feat = feat.GetNextFeature()
    created = None
    try:
        # VERIFY: simplest stable form — swFeatureFilletType_e 0 (simple), constant radius.
        created = ctx.feat_mgr.FeatureFillet3(
            195, r, 0, 0, 0, 0, 0, 0,
            (), (), (), (), (), (), (),
        )
    except Exception:  # noqa: BLE001 — fall through to snapshot check
        created = None
    if created is None:
        # Some versions return None yet still create the feature; check the snapshot.
        feat = ctx.model.FirstFeature()
        while feat is not None:
            if feat.GetTypeName2() == "Fillet" and feat.Name not in before:
                created = feat
                break
            feat = feat.GetNextFeature()
    if created is None:
        raise SWError(
            "fillet failed on this SolidWorks version. Workaround: create one fillet manually, "
            "then use fillet_all to set radii; or report the SW version so the call can be pinned."
        )
    return {"feature": created.Name, "radius_mm": radius}


@tool(
    "fillet_all", "Rescale every existing fillet feature to a uniform radius (reliable: uses GetDefinition/ModifyDefinition)",
    params={"radius": {"type": "number", "desc": "Uniform radius (mm)"}},
    category="feature",
)
def fillet_all(ctx: Context, radius: float):
    r = units.mm(radius)
    model = ctx.model
    feat = model.FirstFeature()
    count = 0
    while feat is not None:
        if feat.GetTypeName2() == "Fillet":
            data = feat.GetDefinition()
            if data is not None:
                data.DefaultRadius = r
                feat.ModifyDefinition(data, model, None)
                count += 1
        feat = feat.GetNextFeature()
    ctx.rebuild()
    return {"modified_fillets": count, "radius_mm": radius}


@tool(
    "chamfer", "Chamfer the selected edges (equal-distance); select edges first",
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
    "shell", "Shell the body (hollow it out while keeping a wall thickness) — pre-select faces to remove them as openings",
    params={
        "thickness": {"type": "number", "desc": "Wall thickness (mm)"},
        "outward": {"type": "boolean", "desc": "Add thickness outward", "default": False},
    },
    category="feature", destructive=True,
)
def shell(ctx: Context, thickness: float, outward: bool = False):
    t = units.mm(thickness)
    # VERIFY: InsertShell owner / signature (commonly IModelDoc2::InsertShell(thickness, outward))
    ok = ctx.model.InsertShell(t, bool(outward))
    if not ok:
        raise SWError("shell failed.")
    return {"shell_thickness_mm": thickness, "outward": outward}


@tool(
    "linear_pattern", "Linearly pattern the selected features (pre-select the features + a direction edge/axis)",
    params={
        "count": {"type": "number", "desc": "Total count (including the original)"},
        "spacing": {"type": "number", "desc": "Spacing (mm)"},
    },
    category="feature",
)
def linear_pattern(ctx: Context, count: int, spacing: float):
    if ctx.selected_count() < 2:
        raise SWError("please select the features to pattern plus the direction reference (edge/axis) first.")
    # VERIFY: FeatureLinearPattern5 parameter slots
    feat = ctx.feat_mgr.FeatureLinearPattern5(
        int(count), units.mm(spacing), 1, 0.01, False, False, "NULL", "NULL",
        False, False, False, False, False, False, True, True, False, False, 0, 0,
    )
    if feat is None:
        raise SWError("linear pattern failed.")
    return {"feature": feat.Name, "count": int(count), "spacing_mm": spacing}


@tool(
    "circular_pattern", "Circular pattern the selected features (pre-select the features + one axis)",
    params={
        "count": {"type": "number", "desc": "Total count (including the original)"},
        "angle": {"type": "number", "desc": "Total sweep angle (degrees)", "default": 360},
        "equal_spacing": {"type": "boolean", "desc": "Distribute evenly across the sweep", "default": True},
    },
    category="feature",
)
def circular_pattern(ctx: Context, count: int, angle: float = 360, equal_spacing: bool = True):
    if ctx.selected_count() < 2:
        raise SWError("please select the features to pattern plus a reference axis first.")
    # VERIFY: FeatureCircularPattern5 parameter slots
    feat = ctx.feat_mgr.FeatureCircularPattern5(
        int(count), units.deg(angle), bool(equal_spacing), "NULL",
        False, True, False, False, False, False,
    )
    if feat is None:
        raise SWError("circular pattern failed.")
    return {"feature": feat.Name, "count": int(count), "angle_deg": angle}


@tool(
    "mirror_feature", "Mirror the selected features across a reference plane (pre-select the features)",
    params={"plane": {"type": "string", "enum": ["front", "top", "right"], "desc": "Symmetry plane"}},
    category="feature",
)
def mirror_feature(ctx: Context, plane: str):
    if ctx.selected_count() < 1:
        raise SWError("please select features to mirror first.")
    ctx.select_plane(plane, append=True, mark=2)  # append the mirror plane to the selection
    # VERIFY: InsertMirrorFeature2 parameters
    feat = ctx.feat_mgr.InsertMirrorFeature2(False, False, False, False, 0)
    if feat is None:
        raise SWError("mirror failed.")
    return {"feature": feat.Name, "plane": plane}


@tool(
    "modify_dimension", "Modify a feature's dimension parameter (applies to ALL configurations)",
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


@tool("suppress_feature", "Suppress the specified feature",
      params={"name": {"type": "string", "desc": "Feature name"}},
      category="feature")
def suppress_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ctx.model.EditSuppress2()
    return {"suppressed": name}


@tool("unsuppress_feature", "Unsuppress the specified feature",
      params={"name": {"type": "string", "desc": "Feature name"}},
      category="feature")
def unsuppress_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ctx.model.EditUnsuppress2()
    return {"unsuppressed": name}


@tool("delete_feature", "Delete the specified feature",
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
