"""sw_agent.tools.assembly —— 装配体：插入零部件、配合、压缩。

add_mate 的 swMateType_e 与 AddMate5 的 15 参签名已对照官方 API 核验（见审查报告）。
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError, DOC_ASSEMBLY
from .. import units

# swMateType_e（已核验）
_MATE = {
    "coincident": 0, "concentric": 1, "perpendicular": 2, "parallel": 3,
    "tangent": 4, "distance": 5, "angle": 6,
}


@tool(
    "insert_component", "在当前装配体插入零部件（默认放到原点）",
    params={
        "path": {"type": "string", "desc": "零件/子装配绝对路径"},
        "x": {"type": "number", "desc": "X(mm)", "default": 0},
        "y": {"type": "number", "desc": "Y(mm)", "default": 0},
        "z": {"type": "number", "desc": "Z(mm)", "default": 0},
    },
    category="assembly",
)
def insert_component(ctx: Context, path: str, x: float = 0, y: float = 0, z: float = 0):
    asm = ctx.require(DOC_ASSEMBLY, "装配体")
    # AddComponent5(CompName, ConfigOption, NewConfigName, UseConfigForPartRefs,
    #               ExistingConfigName, X, Y, Z)
    comp = asm.AddComponent5(path, 0, "", False, "", units.mm(x), units.mm(y), units.mm(z))
    if comp is None:
        raise SWError(f"插入失败（路径不存在或未加载？）：{path}")
    return {"inserted": comp.Name2 if hasattr(comp, "Name2") else path}


@tool(
    "add_mate", "添加配合（需先在 SW 里选好两个要配合的实体：面/边/点/轴）",
    params={
        "type": {"type": "string", "enum": list(_MATE.keys()), "desc": "配合类型"},
        "distance": {"type": "number", "desc": "距离配合的值(mm)", "default": 0},
        "angle": {"type": "number", "desc": "角度配合的值(度)", "default": 0},
        "flip": {"type": "boolean", "desc": "翻转方向", "default": False},
    },
    category="assembly",
)
def add_mate(ctx: Context, type: str, distance: float = 0, angle: float = 0, flip: bool = False):
    asm = ctx.require(DOC_ASSEMBLY, "装配体")
    mt = _MATE.get(type)
    if mt is None:
        raise SWError(f"未知配合类型：{type}")
    if ctx.selected_count() < 2:
        raise SWError("请先选中两个要配合的实体。")
    d = units.mm(distance)
    a = units.deg(angle)
    # AddMate5(MateType, Align=1, Flip, Dist, DistUpper, DistLower, GearNum, GearDen,
    #          Angle, AngUpper, AngLower, ForPositioningOnly, LockRotation, WidthOption, ErrOut)
    res = asm.AddMate5(mt, 1, bool(flip), d, d, d, 0, 0, a, a, a, False, False, 0, 0)
    mate = res[0] if isinstance(res, tuple) else res
    if mate is None:
        raise SWError("配合添加失败：请检查所选实体是否可配合。")
    ctx.clear_selection()
    return {"mate": type, "distance_mm": distance or None, "angle_deg": angle or None}


def _get_component(ctx: Context, name: str):
    asm = ctx.require(DOC_ASSEMBLY, "装配体")
    for c in (asm.GetComponents(True) or []):
        if c.Name2 == name:
            return c
    raise SWError(f"找不到零部件：{name}")


@tool("suppress_component", "压缩指定零部件",
      params={"name": {"type": "string", "desc": "零部件名(Name2)"}},
      category="assembly", destructive=True)
def suppress_component(ctx: Context, name: str):
    comp = _get_component(ctx, name)
    comp.SetSuppression2(0)  # 0 = swComponentSuppressed
    return {"suppressed": name}


@tool("unsuppress_component", "解除压缩指定零部件",
      params={"name": {"type": "string", "desc": "零部件名(Name2)"}},
      category="assembly")
def unsuppress_component(ctx: Context, name: str):
    comp = _get_component(ctx, name)
    comp.SetSuppression2(2)  # 2 = swComponentResolved
    return {"unsuppressed": name}
