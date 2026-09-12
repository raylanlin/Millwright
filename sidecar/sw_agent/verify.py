"""sw_agent.verify —— 几何验证层（P95 起；P121 全局；P124 量化）。

  - 快照（snapshot）：特征名/抑制态、包围盒、实体数、草图段数、**体积/面积/质心**（P124）、
    **装配组件名与变换**（P124）
  - 验证（verify_step）：按工具类别对比快照，返回 {ok, checks}
  - 预检（precheck）：执行前静态检查（build_part 用）
  - 分类（classify）：每个工具属于且仅属于一个类别；tests/test_verify_coverage.py 是门禁

P124 把「有没有变」升级为「往哪个方向变了多少」：SolidPilot 用体积/面积/质心做几何指纹
（ΔV≤1% 判 verified），我们同样从 GetMassProperties2 一次读回。extrude 必须 ΔV>0，
cut 必须 ΔV<0（内部切除也能抓到——包围盒抓不到），shell ΔV<0，阵列/镜像 ΔV>0。
装配工具（insert_component / add_mate）从「不验证」搬进验证：组件数 +1、变换是否移动
（对标项目 pitfall #16/#17：AddComponent5 返回对象≠插入成功；AddMate5 接受了配合也可能
什么都没动）。delete/suppress/unsuppress 也搬进来：特征树名单与抑制态前后对比。

设计原则不变：验证是**证据**，不是门禁。
"""
from __future__ import annotations

from sw_agent.bridge import Context, sw_get

# ---- 工具分组 ----

_FEATURE_CREATORS = {
    "extrude", "cut_extrude", "revolve", "fillet_edges", "fillet_all",
    "chamfer", "shell", "linear_pattern", "circular_pattern", "mirror_feature",
    "cut_face_outline",  # P126 composite: sketch_on_face + SketchUseEdge3 + cut_extrude
}
_ADDS_VOLUME = {"extrude", "revolve", "linear_pattern", "circular_pattern", "mirror_feature"}
_REMOVES_VOLUME = {"cut_extrude", "shell", "cut_face_outline"}
_DRESS_UP = {"fillet_edges", "fillet_all", "chamfer"}  # 体积可增可减，实体数不变
_PART_GENERATORS = {"create_spur_gear", "create_stepped_shaft"}
_REF_GEOMETRY = {"create_plane", "create_axis", "create_reference_point"}
_SKETCH_ADDERS = {
    "sketch_rectangle", "sketch_circle", "sketch_line", "sketch_polyline",
    "sketch_polygon", "sketch_arc_center", "sketch_centerline", "sketch_fillet",
    "sketch_rounded_rectangle",
}
_SKETCH_OPS = {"add_sketch_relation", "add_dimension", "modify_dimension"}
_QUERY_ONLY = {
    "bounding_box", "list_features", "list_components", "list_drawing_views",
    "mass_properties", "measure_selection", "check_interference",
    "sw_diagnostics", "sw_status", "get_custom_properties", "gear_pair_geometry",
    "capture_view", "analyze_view",
    "list_faces", "list_edges", "get_selection",            # P123
    "feature_diagnostics", "edit_state",                    # P124
}
_DOC_OPS = {
    "new_part", "new_assembly", "new_drawing", "open_document", "save_document",
    "save_as", "rebuild_model", "activate_configuration",
    "diagnose_document",                                    # P124: rebuild + 诊断，不改几何
}
_SKIP = {
    "set_view_orientation", "rotate_view", "zoom_to_fit", "set_display_mode",
    "set_material", "set_custom_property", "add_equation", "add_drawing_note",
    "add_drawing_view", "add_section_view", "insert_bom",
    "insert_model_dimensions", "export_file", "export_stl",
    "create_drawing_of", "rename_feature", "suppress_component",
    "unsuppress_component", "create_configuration",
    "select_entities",
}
# P124: 从 _SKIP 搬出来验证的三组
_ASM_INSERT = {"insert_component"}
_ASM_MATE = {"add_mate"}
_TREE_REMOVE = {"delete_feature"}
_TREE_SUPPRESS = {"suppress_feature"}
_TREE_UNSUPPRESS = {"unsuppress_feature"}
_BATCH = {"build_part"}
_META = {"read_guidance", "search_files", "run_shell", "export_session"}  # P125

_KINDS = (
    ("solid", _FEATURE_CREATORS),
    ("generator", _PART_GENERATORS),
    ("ref", _REF_GEOMETRY),
    ("sketch_add", _SKETCH_ADDERS),
    ("sketch_op", _SKETCH_OPS),
    ("sketch_enter", frozenset({"start_sketch", "sketch_on_face"})),
    ("sketch_exit", frozenset({"exit_sketch"})),
    ("asm_insert", _ASM_INSERT),
    ("asm_mate", _ASM_MATE),
    ("tree_remove", _TREE_REMOVE),
    ("tree_suppress", _TREE_SUPPRESS),
    ("tree_unsuppress", _TREE_UNSUPPRESS),
    ("query", _QUERY_ONLY),
    ("doc", _DOC_OPS),
    ("display", _SKIP),
    ("batch", _BATCH),
    ("meta", _META),
)

MUTATING_KINDS = frozenset({
    "solid", "generator", "sketch_add", "sketch_op", "sketch_enter", "sketch_exit",
    "asm_insert", "asm_mate", "tree_remove", "tree_suppress", "tree_unsuppress",
})


def classify(name: str):
    for kind, names in _KINDS:
        if name in names:
            return kind
    return None


# ---- 快照 ----

def _mass_props(ctx: Context):
    """(volume_m3, area_m2, com[3]) 或 None。GetMassProperties2 的 status 是 byref out 参数：
    晚绑定下要传 VARIANT(VT_BYREF|VT_I4)，裸 0 会 DISP_E_TYPEMISMATCH。"""
    m = ctx.model
    for call in (
        lambda: m.Extension.GetMassProperties2(1, _byref_int(), False),
        lambda: m.GetMassProperties2(_byref_int()),
        lambda: m.Extension.GetMassProperties2(1, 0, False),
    ):
        try:
            props = call()
        except Exception:  # noqa: BLE001
            continue
        if props is None:
            continue
        if isinstance(props, tuple) and props and isinstance(props[0], (tuple, list)):
            props = props[0]  # (array, status) shape
        try:
            vals = [float(v) for v in props]
        except Exception:  # noqa: BLE001
            continue
        if len(vals) >= 5:
            return vals[3], vals[4], vals[0:3]
    return None


def _byref_int():
    try:
        import pythoncom
        from win32com.client import VARIANT
        return VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
    except Exception:  # noqa: BLE001
        return 0


def snapshot(ctx: Context) -> dict:
    """执行前/后各拍一张。失败降级为 None 字段 —— 快照是证据，不是门禁。"""
    s: dict = {"features": [], "suppressed": [], "box": None, "sketch_active": None, "sketch_segments": None,
               "bodies": None, "volume": None, "area": None, "com": None, "components": None, "transforms": None}
    feats = []
    try:
        feats = ctx.all_features() or []
        s["features"] = [sw_get(f, "Name") for f in feats]
    except Exception:  # noqa: BLE001
        pass
    try:
        sup = []
        for f in feats:
            try:
                if sw_get(f, "IsSuppressed"):
                    sup.append(sw_get(f, "Name"))
            except Exception:  # noqa: BLE001
                continue
        s["suppressed"] = sup
    except Exception:  # noqa: BLE001
        pass
    try:
        dt = sw_get(ctx.model, "GetType")
    except Exception:  # noqa: BLE001
        dt = None
    if dt == 1:  # part
        try:
            s["bodies"] = len(ctx.solid_bodies())
        except Exception:  # noqa: BLE001
            s["bodies"] = None
        try:
            box = ctx.model.GetPartBox(True)
            if box and len(box) >= 6:
                s["box"] = [round(float(v), 6) for v in box[:6]]
        except Exception:  # noqa: BLE001
            pass
        mp = _mass_props(ctx)
        if mp:
            s["volume"], s["area"], s["com"] = mp[0], mp[1], [round(v, 6) for v in mp[2]]
    elif dt == 2:  # assembly
        try:
            comps = list(ctx.model.GetComponents(True) or [])
            names, xfs = [], {}
            for c in comps:
                try:
                    n = sw_get(c, "Name2")
                    names.append(n)
                    xfs[n] = [round(float(v), 6) for v in c.Transform2.ArrayData[:12]]
                except Exception:  # noqa: BLE001
                    continue
            s["components"], s["transforms"] = names, xfs
        except Exception:  # noqa: BLE001
            pass
    try:
        sm = ctx.sketch_mgr
        act = sm.ActiveSketch
        s["sketch_active"] = act is not None
        if act is not None:
            segs = sw_get(act, "GetSketchSegments")
            s["sketch_segments"] = len(list(segs or []))
    except Exception:  # noqa: BLE001
        pass
    return s


def _box_changed(before, after) -> bool:
    return bool(before and after and before["box"] and after["box"] and before["box"] != after["box"])


def _dv(before, after):
    """体积变化 (ΔV m³, 相对变化) 或 (None, None)。"""
    b, a = before.get("volume"), after.get("volume")
    if b is None or a is None:
        return None, None
    rel = (a - b) / b if b else (1.0 if a else 0.0)
    return a - b, rel


def _fmt_mm3(v) -> str:
    return f"{v * 1e9:,.1f} mm³"


# ---- 每步验证 ----

def verify_step(name: str, params: dict, before: dict, after: dict) -> dict:
    """对比快照，返回 {ok, checks:[...]}。绝不抛异常。"""
    checks: list = []
    ok = True
    kind = classify(name)

    if kind in (None, "query", "doc", "display", "ref", "batch", "meta"):
        return {"ok": True, "checked": False, "checks": ["只读/文档/显示类操作，跳过几何验证"]}

    if kind == "generator":
        grew = len(after["features"]) > len(before["features"])
        checks.append(f"特征树新增 {len(after['features']) - len(before['features'])} 个特征" if grew
                      else "特征树没有新增特征 —— 生成器报告成功但零件没成型")
        ok = grew
        dv, _ = _dv(before, after)
        if dv is not None:
            checks.append(f"体积 {'+' if dv >= 0 else ''}{_fmt_mm3(dv)}")
            if dv <= 0:
                ok = False
        elif before["box"] and after["box"] and not _box_changed(before, after):
            checks.append("包围盒未变化 —— 没有实际生成几何")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "solid":
        added = len(after["features"]) > len(before["features"])
        checks.append(f"特征树新增 {len(after['features']) - len(before['features'])} 个特征" if added
                      else "特征树没有新增特征 —— 工具报告成功但什么都没建成")
        ok = added
        b_b, b_a = before.get("bodies"), after.get("bodies")
        dv, rel = _dv(before, after)
        if dv is not None:
            sign = "+" if dv >= 0 else ""
            checks.append(f"体积 {sign}{_fmt_mm3(dv)}（{sign}{rel * 100:.2f}%）")
            if name in _ADDS_VOLUME and dv <= 1e-15:
                checks.append("增料特征体积没有增加 —— 报告成功但没生成实体")
                ok = False
            elif name in _REMOVES_VOLUME and dv >= -1e-15:
                checks.append("切除/抽壳体积没有减少 —— 可能切在实体外或方向反了（试 flip）")
                ok = False
            elif name in _DRESS_UP and abs(dv) <= 1e-15:
                checks.append("圆角/倒角体积没有变化 —— 没有作用到任何边")
                ok = False
        elif b_b is not None and b_a is not None:
            if b_a > b_b:
                checks.append(f"实体数 {b_b} → {b_a}")
            elif name in _REMOVES_VOLUME or name in _DRESS_UP:
                checks.append("实体数不变（该类特征作用于已有实体，特征树已确认新增）")
            else:
                checks.append(f"实体数未增长（{b_b} → {b_a}）—— 报告成功但没生成实体")
                ok = False
        elif name not in ("fillet_all", "cut_extrude", "cut_face_outline") and before["box"] and after["box"] and not _box_changed(before, after):
            checks.append("包围盒未变化 —— 实体特征没有实际改变几何")
            ok = False
        if ok and after.get("com") and before.get("com") and name in _REMOVES_VOLUME:
            checks.append(f"质心 {[round(v * 1000, 2) for v in before['com']]} → {[round(v * 1000, 2) for v in after['com']]} mm")
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "sketch_add":
        b, a = before.get("sketch_segments"), after.get("sketch_segments")
        if b is not None and a is not None:
            if a > b:
                checks.append(f"草图实体 {b} → {a}")
            else:
                checks.append("草图实体数未增加 —— 工具报告成功但没画进去")
                ok = False
        elif not after.get("sketch_active"):
            checks.append("没有活跃草图 —— 草图实体工具必须在 start_sketch 之后调用")
            ok = False
        else:
            checks.append("草图实体数不可读，跳过")
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "sketch_op":
        if after.get("sketch_active"):
            checks.append("草图仍活跃")
        else:
            checks.append("没有活跃草图 —— 草图操作必须在 start_sketch 之后调用")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "sketch_enter":
        if after.get("sketch_active"):
            checks.append("草图已激活")
        else:
            checks.append(f"草图未激活 —— {name} 报告成功但没开草图")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "sketch_exit":
        if before.get("sketch_active") and not after.get("sketch_active"):
            checks.append("草图已退出")
        elif before.get("sketch_active") is False and after.get("sketch_active") is False:
            checks.append("本来就没有活跃草图（幂等）")
        else:
            checks.append("草图仍活跃 —— exit_sketch 报告成功但没退出")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "asm_insert":
        b, a = before.get("components"), after.get("components")
        if b is None or a is None:
            checks.append("组件列表不可读，跳过")
        elif len(a) > len(b):
            new = [n for n in a if n not in b]
            checks.append(f"组件 {len(b)} → {len(a)}，新增 {new}")
        else:
            checks.append("组件数没有增加 —— AddComponent5 返回了对象但没插入（零件未加载或没有实体）")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "asm_mate":
        bx, ax = before.get("transforms") or {}, after.get("transforms") or {}
        moved = [n for n in ax if n in bx and ax[n] != bx[n]]
        if not bx or not ax:
            checks.append("组件变换不可读，跳过")
        elif moved:
            checks.append(f"配合移动了组件 {moved}")
        else:
            checks.append("没有组件移动 —— 配合被接受但可能被忽略（若两实体本来就重合，这是正常的）")
        return {"ok": ok, "checked": True, "checks": checks}

    if kind == "tree_remove":
        want = (params or {}).get("name") or (params or {}).get("feature")
        gone = [n for n in before["features"] if n not in after["features"]]
        if gone and (not want or want in gone):
            checks.append(f"已删除 {gone}")
        else:
            checks.append(f"特征树没有减少{f'（{want} 仍在）' if want else ''} —— 报告删除但没删（是否在草图编辑态？）")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if kind in ("tree_suppress", "tree_unsuppress"):
        want = (params or {}).get("name") or (params or {}).get("feature")
        bs, as_ = set(before.get("suppressed") or []), set(after.get("suppressed") or [])
        changed = (as_ - bs) if kind == "tree_suppress" else (bs - as_)
        if changed and (not want or want in changed):
            checks.append(f"{'已抑制' if kind == 'tree_suppress' else '已解除抑制'} {sorted(changed)}")
        else:
            checks.append("抑制状态没有变化 —— 报告成功但特征状态未变")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    return {"ok": True, "checked": False, "checks": ["未知工具类别，跳过验证"]}


# ---- 预检（执行前，静态） ----

# 每个工具需要的前置状态（None = 不要求）
# P110: 画图工具需要「活跃草图」；特征工具（extrude/cut/revolve）只需要「已有
# 草图」——用户最常见的序列 start_sketch → 画 → exit_sketch → extrude 里，
# exit_sketch 后草图不再活跃，但 extrude 用的是已退出但存在的草图（last_sketch）。
# 把两者混在一起会让这条最基础的序列被预检误杀（"extrude 需要活跃草图"）。
_REQUIRES_SKETCH = _SKETCH_ADDERS | _SKETCH_OPS
_REQUIRES_DRAWN = {"extrude", "cut_extrude", "revolve"}
# 这些特征把草图用掉了（SolidWorks 会自动退出），之后草图不再存在
_CONSUMES_SKETCH = {"extrude", "cut_extrude", "revolve"}
# P97: extrude 和 revolve 不在这里 —— 它们创建的正是第一个实体。把它们列为
# 「需要已有实体」，等于拒绝掉 SolidWorks 里最基本的那条序列（start_sketch →
# 画轮廓 → extrude），而这恰恰是每个零件的第一步。实测中 build_part 因此连拒
# 两次完全正确的计划，模型只能退回单步调用 —— build_part 的意义被这一行抵消掉了。
# cut_extrude 留着是对的：没有实体就无从切除。
_REQUIRES_BODY = {"cut_extrude", "cut_face_outline", "sketch_on_face", "fillet_edges", "fillet_all",
                  "chamfer", "shell", "linear_pattern", "circular_pattern",
                  "mirror_feature"}

# 数值合理性：参数名 → 必须 > 0（except: 允许 0/负 的少数字段）
_POSITIVE_PARAMS = {
    "depth", "radius", "width", "height", "count", "spacing", "angle",
    "thickness", "distance", "sides",
}
# 这些工具的参数值允许为 0 或负（方向/位置语义）
_NON_POSITIVE_OK = {
    "sketch_line": {"x1", "y1", "x2", "y2"},
    "sketch_centerline": {"x1", "y1", "x2", "y2"},
    "sketch_circle": {"x", "y"},
    "sketch_rectangle": {"x", "y"},
    "sketch_arc_center": {"cx", "cy", "sx", "sy", "ex", "ey"},
    "sketch_polygon": {"cx", "cy"},
    "sketch_polyline": {"points"},
    "create_plane": {"offset"},
    "create_reference_point": {"x", "y", "z"},
    "add_mate": {"distance", "angle"},
    "extrude": {"flip", "both_dir"},
    "cut_extrude": {"through_all"},
    "revolve": {"cut"},
    "linear_pattern": {"direction"},
    # P96: 视图旋转角度天然可正可负（往回转），当成「必须 > 0」会拒掉正确的计划
    "rotate_view": {"angle", "x", "y", "z"},
    "chamfer": {"angle"},
    # P127: indices are 0-based — 0 is a legal face/edge index
    "sketch_on_face": {"face_index"},
    "cut_face_outline": {"face_index"},
    "select_entities": {"faces", "edges", "mark"},
    "list_faces": {"k", "near", "axis"},
    "list_edges": {"k", "near", "axis"},
}


def precheck(plan: list, existing_body: bool = False) -> list:
    """执行前静态检查。返回问题列表（空 = 没问题）。

    检查两类：
      1. 序列依赖 —— 草图工具前必须有活跃草图；实体工具前必须有实体
      2. 数值合理性 —— depth/radius/count 等必须 > 0

    与验证层不同：这里发现问题直接拒绝执行（模型的错，不该白跑），
    由 build_part 把问题转成错误返回。

    P112: `existing_body` 表示文档里**已经存在实体**（前一段 build_part 或
    单步工具建的）。第二段分段提交（例如「先建底板，再在顶面开孔」）里，
    precheck 不能只看 steps 列表内部状态——`start_sketch(face=...)` 和
    `cut_extrude` 需要知道文档本身已经有实体了。
    """
    issues: list = []
    has_sketch = False   # 上一步是 start_sketch 或草图工具 → 活跃草图
    has_drawn = False    # P110: 已经画过并退出/存在的草图（extrude/cut/revolve 用）
    has_body = existing_body  # P112: 已创建过实体特征（含文档已有）
    # P100: required-parameter check up front. The benchmark batch ran 10 steps, then
    # died at step 11 with "create_plane: missing required parameter 'base'" — ten
    # steps of real geometry work wasted because the plan itself was wrong. Registry
    # validation only fires at CALL time, per step; precheck should catch the same
    # thing for the WHOLE plan before the first tool runs. (absolute import, P110)
    from sw_agent.registry import TOOLS
    for i, (name, params) in enumerate(plan):
        spec = TOOLS.get(name)
        if spec is None:
            continue
        for pname, p in spec.params.items():
            if p.get("required", True) and "default" not in p and pname not in (params or {}):
                issues.append(f"step {i + 1} ({name}): missing required parameter '{pname}'")
    for i, (name, params) in enumerate(plan):
        step = i + 1

        # 序列依赖
        if name == "sketch_on_face":
            if not has_body:
                issues.append(f"step {step}: sketch_on_face 需要实体上已有面，但前面还没有任何实体特征")
            has_sketch = True
            has_drawn = True
            continue
        if name == "start_sketch":
            if params.get("face") and not has_body:
                issues.append(f"step {step}: start_sketch(face=...) 需要实体上已有面，但前面还没有任何实体特征")
            has_sketch = True
            has_drawn = True
            continue
        if name == "exit_sketch":
            if not has_sketch:
                issues.append(f"step {step}: exit_sketch 之前没有活跃草图")
            has_sketch = False
            # P110: 退出草图后它仍然存在，extrude/cut/revolve 可以用 —— 不清 has_drawn
            continue
        if name in _REQUIRES_SKETCH and not has_sketch:
            issues.append(f"step {step}: {name} 需要活跃草图，但前面没有 start_sketch")
        # P110: extrude/cut_extrude/revolve 用的是「已画好并退出的草图」（last_sketch），
        # 不需要草图处于活跃状态。检查 has_drawn 而不是 has_sketch。
        if name in _REQUIRES_DRAWN and not has_drawn:
            issues.append(f"step {step}: {name} 需要先画好一张草图（start_sketch → 画轮廓）")
        if name in _REQUIRES_BODY and not has_body and name not in _SKETCH_ADDERS and name not in _SKETCH_OPS:
            issues.append(f"step {step}: {name} 需要已有实体（前面至少一个拉伸/旋转/…特征）")

        # 状态推进
        if name in _FEATURE_CREATORS or name in _REF_GEOMETRY:
            has_body = True
        if name in _PART_GENERATORS:
            has_body = True
        # P96: 拉伸/切除/旋转会消耗掉草图，has_sketch 必须清掉。原来一直留 True，
        # 于是「extrude 之后忘了 start_sketch 又画圆」这种计划能通过预检、到运行时
        # 才炸 —— 而预检存在的意义正是不让它白跑一遍。
        if name in _CONSUMES_SKETCH:
            has_sketch = False
            has_drawn = False   # P110: 草图被特征消费，不再存在
        if name in _SKETCH_ADDERS or name in _SKETCH_OPS:
            has_sketch = True
            has_drawn = True

        # 数值合理性
        for pname, val in (params or {}).items():
            if pname not in _POSITIVE_PARAMS:
                continue
            if name in _NON_POSITIVE_OK and pname in _NON_POSITIVE_OK[name]:
                continue
            if isinstance(val, bool):
                continue
            try:
                if float(val) <= 0:
                    issues.append(f"step {step} ({name}): {pname}={val} 必须 > 0")
            except (TypeError, ValueError):
                pass  # 非数值（如方向字符串）跳过

    return issues
