"""sw_agent.tools.assembly — assembly: insert components, mates, suppress."""
from __future__ import annotations

from .. import units
from ..bridge import DOC_ASSEMBLY, Context, SWError
from ..registry import tool
from .feature import com_call

# swMateType_e (verified against the API reference)
_MATE = {
    "coincident": 0, "concentric": 1, "perpendicular": 2, "parallel": 3,
    "tangent": 4, "distance": 5, "angle": 6,
}

# swMateAlign_e. P77: this was hard-coded to 1 = ANTI_ALIGNED, which silently mates
# faces pointing AWAY from each other — the mate succeeds and the parts end up back to
# back. CLOSEST lets SolidWorks pick the sensible side, which is what the UI does when
# you click two faces and accept the default.
_ALIGN = {"closest": 2, "aligned": 0, "anti_aligned": 1}


@tool(
    "insert_component", "Insert a component into the current assembly, at the origin by default (= 插入零部件; AddComponent5)",
    params={
        "path": {"type": "string", "desc": "Absolute path to the part or sub-assembly"},
        "x": {"type": "number", "desc": "X (mm)", "default": 0},
        "y": {"type": "number", "desc": "Y (mm)", "default": 0},
        "z": {"type": "number", "desc": "Z (mm)", "default": 0},
    },
    category="assembly",
)
def insert_component(ctx: Context, path: str, x: float = 0, y: float = 0, z: float = 0):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    # AddComponent5(CompName, ConfigOption, NewConfigName, UseConfigForPartRefs,
    #               ExistingConfigName, X, Y, Z)
    comp = asm.AddComponent5(path, 0, "", False, "", units.mm(x), units.mm(y), units.mm(z))
    if comp is None:
        raise SWError(f"insert failed (path missing or not loaded?): {path}")
    return {"inserted": comp.Name2 if hasattr(comp, "Name2") else path}


@tool(
    "add_mate", "Add a mate (= 配合; AddMate5). Select two entities first: face/edge/vertex/axis",
    params={
        "type": {"type": "string", "enum": list(_MATE.keys()), "desc": "Mate type"},
        "distance": {"type": "number", "desc": "Distance value for a distance mate (mm)", "default": 0},
        "angle": {"type": "number", "desc": "Angle value for an angle mate (degrees)", "default": 0},
        "align": {
            "type": "string",
            "enum": list(_ALIGN.keys()),
            "desc": "Face alignment: closest lets SolidWorks choose (what you want almost always); "
                    "aligned = normals same way; anti_aligned = normals opposed",
            "default": "closest",
        },
        "flip": {"type": "boolean", "desc": "Flip the alignment direction", "default": False},
    },
    category="assembly",
)
def add_mate(ctx: Context, type: str, distance: float = 0, angle: float = 0,
             align: str = "closest", flip: bool = False):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    mt = _MATE.get(type)
    if mt is None:
        raise SWError(f"unknown mate type: {type}")
    if ctx.selected_count() < 2:
        raise SWError("please select two entities to mate first.")
    al = _ALIGN.get(align, 2)
    d = units.mm(distance)
    a = units.deg(angle)
    errors: list = []
    # AddMate5(MateType, Align, Flip, Dist, DistAbsUpper, DistAbsLower, GearRatioNum,
    #          GearRatioDen, Angle, AngleAbsUpper, AngleAbsLower, ForPositioningOnly,
    #          LockRotation, WidthMateOption, ErrorStatus)
    # P77: routed through com_call so a release with a different argument count still
    # works — every other multi-arg API here already does this, AddMate5 was the exception.
    args = [mt, al, bool(flip), d, d, d, 0, 0, a, a, a, False, False, 0, 0]
    mate = com_call(asm, ("AddMate5", "AddMate4", "AddMate3"), args, errors, min_args=9)
    if mate is None:
        raise SWError(
            "mate add failed — check that the two selected entities can take this mate type. "
            f"(attempts: {' | '.join(errors[-3:])})"
        )
    ctx.clear_selection()
    return {"mate": type, "align": align,
            "distance_mm": distance or None, "angle_deg": angle or None}


def _get_component(ctx: Context, name: str):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    for c in (asm.GetComponents(True) or []):
        if c.Name2 == name:
            return c
    raise SWError(f"component not found: {name}")


@tool("suppress_component", "Suppress the specified component (SetSuppression2, swComponentSuppressed)",
      params={"name": {"type": "string", "desc": "Component name (Name2)"}},
      category="assembly", destructive=True)
def suppress_component(ctx: Context, name: str):
    comp = _get_component(ctx, name)
    comp.SetSuppression2(0)  # 0 = swComponentSuppressed
    return {"suppressed": name}


@tool("unsuppress_component", "Unsuppress the specified component (SetSuppression2, swComponentResolved)",
      params={"name": {"type": "string", "desc": "Component name (Name2)"}},
      category="assembly")
def unsuppress_component(ctx: Context, name: str):
    comp = _get_component(ctx, name)
    comp.SetSuppression2(2)  # 2 = swComponentResolved
    return {"unsuppressed": name}
