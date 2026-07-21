"""sw_agent.tools.assembly — assembly: insert components, mates, suppress.

The swMateType_e values used by add_mate and the 15-argument signature of
AddMate5 have been cross-checked against the official API (see review notes).
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError, DOC_ASSEMBLY
from .. import units

# swMateType_e (verified)
_MATE = {
    "coincident": 0, "concentric": 1, "perpendicular": 2, "parallel": 3,
    "tangent": 4, "distance": 5, "angle": 6,
}


@tool(
    "insert_component", "Insert a component into the current assembly (origin by default)",
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
    "add_mate", "Add a mate (you must first select two entities in SolidWorks: face/edge/vertex/axis)",
    params={
        "type": {"type": "string", "enum": list(_MATE.keys()), "desc": "Mate type"},
        "distance": {"type": "number", "desc": "Distance value for distance mate (mm)", "default": 0},
        "angle": {"type": "number", "desc": "Angle value for angle mate (degrees)", "default": 0},
        "flip": {"type": "boolean", "desc": "Flip the alignment direction", "default": False},
    },
    category="assembly",
)
def add_mate(ctx: Context, type: str, distance: float = 0, angle: float = 0, flip: bool = False):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    mt = _MATE.get(type)
    if mt is None:
        raise SWError(f"unknown mate type: {type}")
    if ctx.selected_count() < 2:
        raise SWError("please select two entities to mate first.")
    d = units.mm(distance)
    a = units.deg(angle)
    # AddMate5(MateType, Align=1, Flip, Dist, DistUpper, DistLower, GearNum, GearDen,
    #          Angle, AngUpper, AngLower, ForPositioningOnly, LockRotation, WidthOption, ErrOut)
    res = asm.AddMate5(mt, 1, bool(flip), d, d, d, 0, 0, a, a, a, False, False, 0, 0)
    mate = res[0] if isinstance(res, tuple) else res
    if mate is None:
        raise SWError("mate add failed: check that the selected entities can be mated.")
    ctx.clear_selection()
    return {"mate": type, "distance_mm": distance or None, "angle_deg": angle or None}


def _get_component(ctx: Context, name: str):
    asm = ctx.require(DOC_ASSEMBLY, "assembly")
    for c in (asm.GetComponents(True) or []):
        if c.Name2 == name:
            return c
    raise SWError(f"component not found: {name}")


@tool("suppress_component", "Suppress the specified component",
      params={"name": {"type": "string", "desc": "Component name (Name2)"}},
      category="assembly", destructive=True)
def suppress_component(ctx: Context, name: str):
    comp = _get_component(ctx, name)
    comp.SetSuppression2(0)  # 0 = swComponentSuppressed
    return {"suppressed": name}


@tool("unsuppress_component", "Unsuppress the specified component",
      params={"name": {"type": "string", "desc": "Component name (Name2)"}},
      category="assembly")
def unsuppress_component(ctx: Context, name: str):
    comp = _get_component(ctx, name)
    comp.SetSuppression2(2)  # 2 = swComponentResolved
    return {"unsuppressed": name}
