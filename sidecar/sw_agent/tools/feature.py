"""sw_agent.tools.feature —— 特征：拉伸/切除/旋转/圆角/倒角/抽壳/孔/阵列/镜像 + 特征树操作。

多参特征 API（拉伸/切除/旋转/阵列/镜像）用命名调用比 VBS 按位安全，但参数位仍可能跨版本
不同，逐个标了 # VERIFY —— 建议在目标 SolidWorks 版本用宏录制器核对一次。
chamfer 已修正原 VBS 版本的“距离塞进角度位、参数少两个”的 bug。
"""
from __future__ import annotations

from ..registry import tool
from ..bridge import Context, SWError
from .. import units


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
    "extrude", "把当前草图拉伸为实体",
    params={
        "depth": {"type": "number", "desc": "拉伸深度(mm)"},
        "both_dir": {"type": "boolean", "desc": "双向等距", "default": False},
    },
    category="feature",
)
def extrude(ctx: Context, depth: float, both_dir: bool = False):
    _exit_sketch_if_open(ctx)
    d = units.mm(depth)
    # VERIFY: FeatureExtrusion3 参数位（24 参）建议宏录制器核对
    feat = ctx.feat_mgr.FeatureExtrusion3(
        True, False, bool(both_dir), 0, 0, d, d if both_dir else 0,
        False, False, False, False, 0, 0, False, False, False, False,
        True, True, True, 0, 0, False,
    )
    if feat is None:
        raise SWError("拉伸失败：请确认存在闭合草图。")
    return {"feature": feat.Name, "depth_mm": depth}


@tool(
    "cut_extrude", "以当前草图切除料",
    params={
        "depth": {"type": "number", "desc": "切除深度(mm)"},
        "through_all": {"type": "boolean", "desc": "完全贯穿", "default": False},
    },
    category="feature", destructive=True,
)
def cut_extrude(ctx: Context, depth: float, through_all: bool = False):
    _exit_sketch_if_open(ctx)
    d = units.mm(depth)
    # VERIFY: FeatureCut4 参数位（25 参）
    feat = ctx.feat_mgr.FeatureCut4(
        True, False, False, 1 if through_all else 0, 0, d, 0,
        False, False, False, False, 0, 0, False, False, False, False,
        True, True, True, True, 0, 0, False, False,
    )
    if feat is None:
        raise SWError("切除失败：请确认草图与实体相交。")
    return {"feature": feat.Name, "depth_mm": depth, "through_all": through_all}


@tool(
    "revolve", "旋转特征（需草图含轮廓 + 一条中心线作轴）",
    params={"angle": {"type": "number", "desc": "旋转角度(度)", "default": 360}},
    category="feature",
)
def revolve(ctx: Context, angle: float = 360):
    _exit_sketch_if_open(ctx)
    a = units.deg(angle)
    # VERIFY: FeatureRevolve2 参数位
    feat = ctx.feat_mgr.FeatureRevolve2(
        True, True, False, False, False, False, 0, 0, a, 0,
        False, False, 0, 0, 0, 0, 0, True, True, True,
    )
    if feat is None:
        raise SWError("旋转失败：请确认有闭合轮廓和一条中心线。")
    return {"feature": feat.Name, "angle_deg": angle}


@tool(
    "fillet_edges", "对当前选中的边倒圆角（需先在 SW 里选边）",
    params={"radius": {"type": "number", "desc": "圆角半径(mm)"}},
    category="feature",
)
def fillet_edges(ctx: Context, radius: float):
    if ctx.selected_count() < 1:
        raise SWError("请先选中要倒圆角的边。")
    r = units.mm(radius)
    # VERIFY: FeatureFillet3 参数位（不同版本略异）
    feat = ctx.feat_mgr.FeatureFillet3(195, r, 0, 0, 0, 0, 0)
    if feat is None:
        raise SWError("倒圆角失败：请确认所选边有效。")
    return {"feature": feat.Name, "radius_mm": radius}


@tool(
    "fillet_all", "把模型里所有圆角特征改成统一半径（可靠：走 GetDefinition/ModifyDefinition）",
    params={"radius": {"type": "number", "desc": "统一半径(mm)"}},
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
    "chamfer", "对当前选中的边倒角（等距）——已修正旧版参数错位 bug（需先选边）",
    params={"distance": {"type": "number", "desc": "倒角距离(mm)"}},
    category="feature",
)
def chamfer(ctx: Context, distance: float):
    if ctx.selected_count() < 1:
        raise SWError("请先选中要倒角的边。")
    d = units.mm(distance)
    # 修正：正确的 8 参签名 (Type, PropagationFlag, Width, Angle, OtherDist, Vc1, Vc2, Vc3)。
    # 等距倒角：Width=距离, Angle=0。旧 VBS 版本把距离塞进了 Angle 位且只给 6 参 → 错。
    # VERIFY: Type 枚举(此处 1=距离-距离)建议宏录制器核对目标版本。
    feat = ctx.feat_mgr.InsertFeatureChamfer(1, 1, d, 0, 0, 0, 0, 0)
    if feat is None:
        raise SWError("倒角失败：请确认所选边有效。")
    return {"feature": feat.Name, "distance_mm": distance}


@tool(
    "shell", "抽壳（挖空实体，保留壁厚）——若要开口需先选中要移除的面",
    params={
        "thickness": {"type": "number", "desc": "壁厚(mm)"},
        "outward": {"type": "boolean", "desc": "向外加厚", "default": False},
    },
    category="feature", destructive=True,
)
def shell(ctx: Context, thickness: float, outward: bool = False):
    t = units.mm(thickness)
    # VERIFY: InsertShell 归属/签名（多为 IModelDoc2::InsertShell(thickness, outward)）
    ok = ctx.model.InsertShell(t, bool(outward))
    if not ok:
        raise SWError("抽壳失败。")
    return {"shell_thickness_mm": thickness, "outward": outward}


@tool(
    "linear_pattern", "线性阵列已选中的特征（需先选特征 + 方向边/轴）",
    params={
        "count": {"type": "number", "desc": "总数量（含原始）"},
        "spacing": {"type": "number", "desc": "间距(mm)"},
    },
    category="feature",
)
def linear_pattern(ctx: Context, count: int, spacing: float):
    if ctx.selected_count() < 2:
        raise SWError("请先选中要阵列的特征 + 方向参考（边/轴）。")
    # VERIFY: FeatureLinearPattern5 参数位
    feat = ctx.feat_mgr.FeatureLinearPattern5(
        int(count), units.mm(spacing), 1, 0.01, False, False, "NULL", "NULL",
        False, False, False, False, False, False, True, True, False, False, 0, 0,
    )
    if feat is None:
        raise SWError("线性阵列失败。")
    return {"feature": feat.Name, "count": int(count), "spacing_mm": spacing}


@tool(
    "circular_pattern", "圆周阵列已选中的特征（需先选特征 + 一条轴）",
    params={
        "count": {"type": "number", "desc": "总数量（含原始）"},
        "angle": {"type": "number", "desc": "总分布角度(度)", "default": 360},
        "equal_spacing": {"type": "boolean", "desc": "等间距铺满", "default": True},
    },
    category="feature",
)
def circular_pattern(ctx: Context, count: int, angle: float = 360, equal_spacing: bool = True):
    if ctx.selected_count() < 2:
        raise SWError("请先选中要阵列的特征 + 一条基准轴。")
    # VERIFY: FeatureCircularPattern5 参数位
    feat = ctx.feat_mgr.FeatureCircularPattern5(
        int(count), units.deg(angle), bool(equal_spacing), "NULL",
        False, True, False, False, False, False,
    )
    if feat is None:
        raise SWError("圆周阵列失败。")
    return {"feature": feat.Name, "count": int(count), "angle_deg": angle}


@tool(
    "mirror_feature", "以基准面镜像已选中的特征（需先选特征）",
    params={"plane": {"type": "string", "enum": ["front", "top", "right"], "desc": "对称面"}},
    category="feature",
)
def mirror_feature(ctx: Context, plane: str):
    if ctx.selected_count() < 1:
        raise SWError("请先选中要镜像的特征。")
    ctx.select_plane(plane, append=True, mark=2)  # 追加镜像面
    # VERIFY: InsertMirrorFeature2 参数
    feat = ctx.feat_mgr.InsertMirrorFeature2(False, False, False, False, 0)
    if feat is None:
        raise SWError("镜像失败。")
    return {"feature": feat.Name, "plane": plane}


@tool(
    "modify_dimension", "修改某特征的尺寸参数",
    params={
        "feature": {"type": "string", "desc": "特征名，如 Boss-Extrude1"},
        "dimension": {"type": "string", "desc": "尺寸名，如 D1"},
        "value": {"type": "number", "desc": "新值(mm)"},
    },
    category="feature",
)
def modify_dimension(ctx: Context, feature: str, dimension: str, value: float):
    full = f"{dimension}@{feature}"
    dim = ctx.model.Parameter(full)
    if dim is None:
        raise SWError(f"找不到尺寸：{full}")
    dim.SetSystemValue3(units.mm(value), 1, None)  # 1 = 所有配置
    ctx.rebuild()
    return {"dimension": full, "value_mm": value}


# ---- 特征树操作 ----

def _select_feature(ctx: Context, name: str):
    feat = _find_feature(ctx, name)
    if feat is None:
        raise SWError(f"找不到特征：{name}")
    feat.Select2(False, -1)
    return feat


@tool("suppress_feature", "压缩指定特征",
      params={"name": {"type": "string", "desc": "特征名"}},
      category="feature")
def suppress_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ctx.model.EditSuppress2()
    return {"suppressed": name}


@tool("unsuppress_feature", "解除压缩指定特征",
      params={"name": {"type": "string", "desc": "特征名"}},
      category="feature")
def unsuppress_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ctx.model.EditUnsuppress2()
    return {"unsuppressed": name}


@tool("delete_feature", "删除指定特征",
      params={"name": {"type": "string", "desc": "特征名"}},
      category="feature", destructive=True)
def delete_feature(ctx: Context, name: str):
    _select_feature(ctx, name)
    ctx.model.EditDelete()
    return {"deleted": name}


@tool("rename_feature", "重命名特征",
      params={"old": {"type": "string", "desc": "原名"}, "new": {"type": "string", "desc": "新名"}},
      category="feature")
def rename_feature(ctx: Context, old: str, new: str):
    feat = _find_feature(ctx, old)
    if feat is None:
        raise SWError(f"找不到特征：{old}")
    feat.Name = new
    return {"renamed": {"from": old, "to": new}}
