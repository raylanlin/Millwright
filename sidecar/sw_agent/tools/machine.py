"""sw_agent.tools.machine — parametric machine-element generators.

Why these exist: a general modelling agent can draw any shape, but it cannot INVENT
the geometry of a standard machine element. An involute gear tooth is a specific
mathematical curve — asked to "make a gear", a model will draw a circle with
trapezoidal notches, which meshes with nothing and is not a gear. The same is true of
a stepped shaft's shoulder sequence: individually trivial, tediously error-prone when
issued as thirty separate tool calls.

So these tools own the mathematics and emit correct geometry in one call. Everything is
standard metric spur-gear practice (ISO 53 basic rack profile):

    pitch diameter      d  = m·z
    base diameter       db = d·cos(α)
    addendum            ha = m           → tip diameter  da = d + 2m
    dedendum            hf = 1.25·m      → root diameter df = d − 2.5m
    involute            x = r_b(cos t + t·sin t), y = r_b(sin t − t·cos t)

The tooth flank is generated as a polyline of involute points, mirrored about the tooth
centreline, closed across the tip, and then circular-patterned z times — which is how a
gear is actually built, and why the result meshes.
"""
from __future__ import annotations

import math

from .. import units
from ..bridge import DOC_PART, Context, SWError, sw_get
from ..registry import tool
from .feature import _feature_names, _new_feature_of, com_call

_INVOLUTE_STEPS = 12


def _involute_flank(m: float, z: int, alpha_deg: float, steps: int = _INVOLUTE_STEPS):
    """One tooth's flank points (mm), in the gear's own polar frame.

    Returns (left_flank, right_flank) as point lists. The right flank is the left one
    mirrored about the tooth centreline, so the tooth is symmetric — which is what makes
    the gear run in both directions.
    """
    alpha = math.radians(alpha_deg)
    r_pitch = m * z / 2.0
    r_base = r_pitch * math.cos(alpha)
    r_tip = r_pitch + m
    r_root = r_pitch - 1.25 * m
    if r_root <= 0:
        raise SWError(f"module {m} with {z} teeth gives a non-positive root radius — increase z or m.")

    # Parameter range: from the base circle out to the tip circle
    t_max = math.sqrt(max((r_tip / r_base) ** 2 - 1.0, 0.0))

    pts = []
    for i in range(steps + 1):
        t = t_max * i / steps
        x = r_base * (math.cos(t) + t * math.sin(t))
        y = r_base * (math.sin(t) - t * math.cos(t))
        pts.append((x, y))

    # Rotate so the tooth is centred on +X: the involute must be offset by half the
    # angular tooth width at the pitch circle, plus the involute function at alpha.
    inv_alpha = math.tan(alpha) - alpha
    half_tooth = math.pi / (2.0 * z) + inv_alpha
    c, s = math.cos(-half_tooth), math.sin(-half_tooth)
    left = [(x * c - y * s, x * s + y * c) for x, y in pts]
    right = [(x, -y) for x, y in left]           # mirror about the X axis
    return left, right, r_root, r_tip


@tool(
    "create_spur_gear",
    "Generate a real involute spur gear as a new part — correct tooth form, so it actually "
    "meshes. Give module and tooth count (standard metric practice: pitch d = m·z, "
    "addendum m, dedendum 1.25m, ISO 53 profile). Do NOT try to draw gear teeth by hand",
    params={
        "module": {"type": "number", "desc": "Module m in mm (tooth size; 1–5 is typical for small gearboxes)"},
        "teeth": {"type": "integer", "desc": "Number of teeth z (17 or more avoids undercut at 20° pressure angle)"},
        "thickness": {"type": "number", "desc": "Face width — gear thickness (mm)"},
        "bore": {"type": "number", "desc": "Centre bore diameter (mm); 0 = solid", "default": 0},
        "pressure_angle": {"type": "number", "desc": "Pressure angle in degrees — 20 is the standard", "default": 20},
        "new_part": {"type": "boolean", "desc": "Create a new part document; false = build in the current part", "default": True},
    },
    category="machine",
)
def create_spur_gear(ctx: Context, module: float, teeth: int, thickness: float,
                     bore: float = 0, pressure_angle: float = 20, new_part: bool = True):
    if module <= 0 or teeth < 4 or thickness <= 0:
        raise SWError("need module > 0, teeth >= 4 and thickness > 0.")
    z = int(teeth)
    m = float(module)

    if new_part:
        from .document import new_part as _new_part
        _new_part(ctx)
    ctx.require(DOC_PART, "part")

    left, right, r_root, r_tip = _involute_flank(m, z, pressure_angle)
    r_pitch = m * z / 2.0

    sk = ctx.sketch_mgr
    ctx.clear_selection()
    # Gear body on the top plane: the axis then runs along Y (SolidWorks is Y-up), so the
    # gear lies flat like a real gear blank on a table.
    if not ctx.select_plane("top"):
        raise SWError("failed to select the top plane.")
    sk.InsertSketch(True)

    # 1. Root circle — the gear blank the teeth stand on
    sk.CreateCircle(0, 0, 0, units.mm(r_root), 0, 0)
    ctx.sketch_mgr.InsertSketch(True)
    root_sketch = None
    try:
        root_sketch = ctx.scratch.get("last_sketch")
    except Exception:  # noqa: BLE001
        pass

    ctx.clear_selection()
    if not ctx.select_plane("top"):
        raise SWError("failed to re-select the top plane for the tooth sketch.")
    sk.InsertSketch(True)

    # 2. ONE tooth: left flank out, across the tip, right flank back, closed at the root.
    #    Drawn as a single connected polyline so the profile is closed — separate
    #    CreateLine calls do not weld their endpoints (the P45 lesson).
    loop = left + list(reversed(right))
    for (x1, y1), (x2, y2) in zip(loop, loop[1:]):
        sk.CreateLine(units.mm(x1), units.mm(y1), 0.0, units.mm(x2), units.mm(y2), 0.0)
    # close back to the start across the root
    (x0, y0), (xn, yn) = loop[0], loop[-1]
    sk.CreateLine(units.mm(xn), units.mm(yn), 0.0, units.mm(x0), units.mm(y0), 0.0)
    tooth_sketch = None
    try:
        active = sk.ActiveSketch
        if active is not None:
            tooth_sketch = sw_get(active, "Name")
            ctx.scratch["last_sketch"] = tooth_sketch
    except Exception:  # noqa: BLE001
        pass
    sk.InsertSketch(True)

    from .feature import extrude

    # 3. Extrude the blank, then the tooth, then pattern the tooth around the axis.
    if root_sketch:
        extrude(ctx, depth=thickness, sketch=root_sketch)
    tooth_feat = extrude(ctx, depth=thickness, sketch=tooth_sketch or "")
    tooth_name = tooth_feat.get("feature") if isinstance(tooth_feat, dict) else None

    before = _feature_names(ctx)
    errors: list = []
    ctx.clear_selection()
    if tooth_name and not ctx.select_feature(tooth_name, mark=4):
        raise SWError(f"could not select the tooth feature {tooth_name} to pattern it.")
    if not ctx.select_cylindrical_face(append=True, mark=1):
        raise SWError("no cylindrical face to use as the gear axis — the blank extrude may have failed.")
    pattern = com_call(
        ctx.feat_mgr,
        ("FeatureCircularPattern5", "FeatureCircularPattern4", "FeatureCircularPattern3"),
        [z, units.deg(360), True, "NULL", False, True, False, False, False, False,
         False, False, 0, 0, False],
        errors, min_args=4, verify=lambda: _new_feature_of(ctx, before, "CirPattern", "Pattern"),
    )
    if pattern is None:
        raise SWError(
            f"the tooth was created but patterning {z} times failed — the gear has one tooth. "
            f"(attempts: {' | '.join(errors[-3:])})"
        )

    # 4. Centre bore
    if bore and bore > 0:
        ctx.clear_selection()
        if not ctx.select_plane("top"):
            raise SWError("failed to select the top plane for the bore.")
        sk.InsertSketch(True)
        sk.CreateCircle(0, 0, 0, units.mm(bore / 2.0), 0, 0)
        bore_sketch = None
        try:
            active = sk.ActiveSketch
            if active is not None:
                bore_sketch = sw_get(active, "Name")
        except Exception:  # noqa: BLE001
            pass
        sk.InsertSketch(True)
        from .feature import cut_extrude
        cut_extrude(ctx, through_all=True, sketch=bore_sketch or "")

    ctx.rebuild()
    return {
        "gear": {
            "module": m,
            "teeth": z,
            "pressure_angle_deg": pressure_angle,
            "pitch_diameter_mm": round(2 * r_pitch, 3),
            "tip_diameter_mm": round(2 * r_tip, 3),
            "root_diameter_mm": round(2 * r_root, 3),
            "thickness_mm": thickness,
            "bore_mm": bore or None,
        },
        "note": "involute profile per ISO 53; mates with any gear of the same module and pressure angle",
    }


@tool(
    "gear_pair_geometry",
    "Work out the geometry of a meshing gear pair BEFORE modelling: centre distance, ratio, "
    "both pitch diameters. Call this first when designing a gearbox — the centre distance "
    "determines where the shaft bores go",
    params={
        "module": {"type": "number", "desc": "Module m in mm (both gears must share it to mesh)"},
        "teeth_1": {"type": "integer", "desc": "Tooth count of gear 1 (the pinion)"},
        "teeth_2": {"type": "integer", "desc": "Tooth count of gear 2"},
    },
    category="machine",
)
def gear_pair_geometry(ctx: Context, module: float, teeth_1: int, teeth_2: int):
    """Pure arithmetic — no COM. Kept as a tool because getting the centre distance
    wrong is the single most common way an agent-built gearbox ends up not meshing."""
    m, z1, z2 = float(module), int(teeth_1), int(teeth_2)
    if m <= 0 or z1 < 4 or z2 < 4:
        raise SWError("need module > 0 and both tooth counts >= 4.")
    d1, d2 = m * z1, m * z2
    return {
        "module": m,
        "pitch_diameter_1_mm": round(d1, 3),
        "pitch_diameter_2_mm": round(d2, 3),
        "centre_distance_mm": round((d1 + d2) / 2.0, 3),
        "ratio": round(z2 / z1, 4),
        "tip_diameter_1_mm": round(d1 + 2 * m, 3),
        "tip_diameter_2_mm": round(d2 + 2 * m, 3),
        "note": "place the two shaft bores exactly centre_distance apart, or the gears will not mesh",
    }


@tool(
    "create_stepped_shaft",
    "Generate a stepped shaft as a revolved part in one call — give the diameter/length of "
    "each step from one end. Far more reliable than issuing a separate extrude per step",
    params={
        "steps": {
            "type": "string",
            "desc": 'Steps as "diameter x length" pairs in mm, left to right, e.g. '
                    '"20x30 30x50 25x40" = Ø20 for 30mm, then Ø30 for 50mm, then Ø25 for 40mm',
        },
        "new_part": {"type": "boolean", "desc": "Create a new part document", "default": True},
    },
    category="machine",
)
def create_stepped_shaft(ctx: Context, steps: str, new_part: bool = True):
    """Built as a revolve of the shaft's half-profile — one sketch, one feature. Building
    it as a stack of extrudes needs a fresh offset plane per step, which is where
    hand-issued sequences drift and produce mis-aligned shoulders."""
    parsed = []
    for chunk in (steps or "").replace(",", " ").split():
        part = chunk.lower().replace("ø", "").replace("φ", "").split("x")
        if len(part) != 2:
            raise SWError(f'bad step "{chunk}" — use "diameter x length", e.g. 20x30.')
        d, ln = float(part[0]), float(part[1])
        if d <= 0 or ln <= 0:
            raise SWError(f'step "{chunk}" needs positive diameter and length.')
        parsed.append((d, ln))
    if not parsed:
        raise SWError('give at least one step, e.g. "20x30 30x50".')

    if new_part:
        from .document import new_part as _new_part
        _new_part(ctx)
    ctx.require(DOC_PART, "part")

    sk = ctx.sketch_mgr
    ctx.clear_selection()
    # Front plane: the revolve axis lies along X, so the shaft ends up lying down —
    # the orientation a shaft is normally drawn and machined in.
    if not ctx.select_plane("front"):
        raise SWError("failed to select the front plane.")
    sk.InsertSketch(True)

    # Half profile above the axis: walk along X, stepping the radius per section.
    x = 0.0
    profile = [(0.0, 0.0)]
    for d, ln in parsed:
        r = d / 2.0
        profile.append((x, r))          # step up (or down) to this radius
        x += ln
        profile.append((x, r))          # run along this section
    profile.append((x, 0.0))            # back down to the axis

    for (x1, y1), (x2, y2) in zip(profile, profile[1:]):
        sk.CreateLine(units.mm(x1), units.mm(y1), 0.0, units.mm(x2), units.mm(y2), 0.0)
    # close along the axis
    sk.CreateLine(units.mm(x), 0.0, 0.0, 0.0, 0.0, 0.0)
    # the centreline IS the axis of revolution
    sk.CreateCenterLine(0.0, 0.0, 0.0, units.mm(x), 0.0, 0.0)

    shaft_sketch = None
    try:
        active = sk.ActiveSketch
        if active is not None:
            shaft_sketch = sw_get(active, "Name")
            ctx.scratch["last_sketch"] = shaft_sketch
    except Exception:  # noqa: BLE001
        pass
    sk.InsertSketch(True)

    from .feature import revolve
    revolve(ctx, angle=360, sketch=shaft_sketch or "")
    ctx.rebuild()
    return {
        "shaft": {
            "steps": [{"diameter_mm": d, "length_mm": ln} for d, ln in parsed],
            "total_length_mm": round(x, 3),
            "max_diameter_mm": max(d for d, _ in parsed),
        },
    }
