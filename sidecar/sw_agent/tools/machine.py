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

# P62: no circular pattern any more — the whole outline is one sketch, one extrude,
# so the pattern/axis-selection helpers are no longer needed here.

_INVOLUTE_STEPS = 10
_TIP_ARC_STEPS = 3
_ROOT_ARC_STEPS = 3


def _rot(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)


def _gear_profile(m: float, z: int, alpha_deg: float):
    """Full closed outline of a spur gear — every tooth, in one point list (mm).

    P62: the earlier version built ONE tooth and circular-patterned it, which needed a
    blank extrude, a tooth extrude and a cylindrical face to use as the pattern axis —
    three ways to fail, and it failed at the first. Emitting the whole outline needs a
    single sketch and a single extrude, so none of that machinery is involved.

    The tooth-profile offset is the part that must be exactly right, and it is easy to
    get backwards. The involute unwinds FORWARD: its polar angle inv(t) = t − atan(t)
    grows with radius. So to make a tooth that narrows outward (as a real tooth does),
    the involute must be rotated BACK by the half-tooth angle plus the involute function
    at the pressure angle:

        δ = −( π/(2z) + inv(α) ),   inv(α) = tan α − α

    Verified numerically for m=2, z=20, α=20°: tooth width 10.7° at the root, 9.00° at
    the pitch circle (exactly half the 18° pitch, which is the standard tooth), 3.6° at
    the tip — monotonically narrowing. With the sign flipped the tip comes out 14.4°
    wide, adjacent teeth touch, and the whole gear renders as a plain ring.
    """
    alpha = math.radians(alpha_deg)
    r_pitch = m * z / 2.0
    r_base = r_pitch * math.cos(alpha)
    r_tip = r_pitch + m
    r_root = r_pitch - 1.25 * m
    if r_root <= 0:
        raise SWError(f"module {m} with {z} teeth gives a non-positive root radius — increase z or m.")
    if r_base >= r_tip:
        raise SWError(f"module {m}, {z} teeth, {alpha_deg}° gives a base circle outside the tip circle.")

    inv_alpha = math.tan(alpha) - alpha
    delta = -(math.pi / (2.0 * z) + inv_alpha)
    t_max = math.sqrt((r_tip / r_base) ** 2 - 1.0)

    # One flank, root → tip. Below the base circle the involute does not exist, so the
    # flank starts with a radial segment from the root circle up to the base circle.
    flank = []
    for i in range(_INVOLUTE_STEPS + 1):
        t = t_max * i / _INVOLUTE_STEPS
        x = r_base * (math.cos(t) + t * math.sin(t))
        y = r_base * (math.sin(t) - t * math.cos(t))
        flank.append(_rot((x, y), delta))
    base_ang = math.atan2(flank[0][1], flank[0][0])
    left = [(r_root * math.cos(base_ang), r_root * math.sin(base_ang))] + flank
    # The other flank is this one mirrored about the tooth centreline (the X axis),
    # traversed tip → root so the outline stays continuous.
    right = [(x, -y) for x, y in reversed(left)]

    tip_a0 = math.atan2(left[-1][1], left[-1][0])
    tip_a1 = math.atan2(right[0][1], right[0][0])
    root_a_end = math.atan2(right[-1][1], right[-1][0])

    pts: list = []
    for k in range(z):
        a = 2.0 * math.pi * k / z
        pts.extend(_rot(p, a) for p in left)
        # tip arc across the top of the tooth
        for i in range(1, _TIP_ARC_STEPS):
            ang = a + tip_a0 + (tip_a1 - tip_a0) * i / _TIP_ARC_STEPS
            pts.append((r_tip * math.cos(ang), r_tip * math.sin(ang)))
        pts.extend(_rot(p, a) for p in right)
        # root arc across the gap to the next tooth
        gap_start = a + root_a_end
        gap_end = 2.0 * math.pi * (k + 1) / z + base_ang
        for i in range(1, _ROOT_ARC_STEPS):
            ang = gap_start + (gap_end - gap_start) * i / _ROOT_ARC_STEPS
            pts.append((r_root * math.cos(ang), r_root * math.sin(ang)))
    return pts, r_pitch, r_tip, r_root


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

    pts, r_pitch, r_tip, r_root = _gear_profile(m, z, pressure_angle)

    sk = ctx.sketch_mgr
    ctx.clear_selection()
    # Top plane: the gear axis then runs along Y (SolidWorks is Y-up), so the gear lies
    # flat like a real blank on a table.
    if not ctx.select_plane("top"):
        raise SWError("failed to select the top plane.")
    sk.InsertSketch(True)

    # One closed polyline for the entire gear outline. Consecutive CreateLine calls share
    # endpoints exactly, so SolidWorks welds them into a single closed contour.
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        sk.CreateLine(units.mm(x1), units.mm(y1), 0.0, units.mm(x2), units.mm(y2), 0.0)
    sk.CreateLine(units.mm(pts[-1][0]), units.mm(pts[-1][1]), 0.0,
                  units.mm(pts[0][0]), units.mm(pts[0][1]), 0.0)

    # P62: read the sketch's real name NOW and record it. The previous version read
    # ctx.scratch["last_sketch"] without ever writing it, so it picked up a stale name
    # from an earlier call and extruded the wrong sketch ("failed to select sketch: 草图2").
    gear_sketch = ""
    try:
        active = sk.ActiveSketch
        if active is not None:
            gear_sketch = sw_get(active, "Name") or ""
            ctx.scratch["last_sketch"] = gear_sketch
    except Exception:  # noqa: BLE001
        pass
    sk.InsertSketch(True)

    from .feature import extrude
    body = extrude(ctx, depth=thickness, sketch=gear_sketch)
    if not isinstance(body, dict) or not body.get("feature"):
        raise SWError("the gear outline was drawn but the extrude failed — check the sketch is closed.")

    if bore and bore > 0:
        if bore >= 2 * r_root:
            raise SWError(f"bore Ø{bore} is larger than the root circle Ø{2 * r_root:.1f} — reduce it.")
        ctx.clear_selection()
        if not ctx.select_plane("top"):
            raise SWError("failed to select the top plane for the bore.")
        sk.InsertSketch(True)
        sk.CreateCircle(0.0, 0.0, 0.0, units.mm(bore / 2.0), 0.0, 0.0)
        bore_sketch = ""
        try:
            active = sk.ActiveSketch
            if active is not None:
                bore_sketch = sw_get(active, "Name") or ""
                ctx.scratch["last_sketch"] = bore_sketch
        except Exception:  # noqa: BLE001
            pass
        sk.InsertSketch(True)
        from .feature import cut_extrude
        cut_extrude(ctx, through_all=True, sketch=bore_sketch)

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
        "feature": body.get("feature"),
        "note": "involute profile per ISO 53; meshes with any gear of the same module and pressure angle",
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

    shaft_sketch = ""
    try:
        active = sk.ActiveSketch
        if active is not None:
            shaft_sketch = sw_get(active, "Name") or ""
            ctx.scratch["last_sketch"] = shaft_sketch
    except Exception:  # noqa: BLE001
        pass
    sk.InsertSketch(True)

    from .feature import revolve
    revolve(ctx, angle=360, sketch=shaft_sketch)
    ctx.rebuild()
    return {
        "shaft": {
            "steps": [{"diameter_mm": d, "length_mm": ln} for d, ln in parsed],
            "total_length_mm": round(x, 3),
            "max_diameter_mm": max(d for d, _ in parsed),
        },
    }
