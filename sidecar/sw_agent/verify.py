"""sw_agent.verify —— 几何验证层（P95 起；P121 升级为全局）。

原本只有 build_part 的每一步有「执行成功/失败」之外的「几何对不对」证据。
P121 把同一套 snapshot/verify_step 提升到 server 的 call 入口——单步工具调用
（agent 实际最常走的路径）同样带 _verified 证据。P105 delete_feature 谎报删除、
P105–P120 create_plane 五轮谎报偏移、P92 fillet 部分成功装全成功，都属于同一类
「工具说成功但没人对过账」；类内每个成员单独修一次，不如把账房搬到唯一入口。

  - 快照（snapshot）：执行前后各拍一张（特征名列表、包围盒、实体数、草图段数）
  - 验证（verify_step）：按工具类别对比快照，返回 {ok, checks}
  - 预检（precheck）：执行前静态检查序列依赖和数值合理性（build_part 用）
  - 分类（classify，P121）：每个工具属于且仅属于一个类别；tests/test_verify_coverage.py
    把「没人认领」变成 CI 失败——P96 的死代码分支和 P100 的漏登记不可能再发生

设计原则：验证是**证据**，不是门禁——验证失败意味着「工具报告成功但几何没变/
不对」，必须停下来说清楚，但验证本身绝不抛异常吞掉工具的真实结果。
"""
from __future__ import annotations

# P110: absolute imports everywhere — the bundled interpreter (embeddable Python +
# runpy.run_module("sw_agent", run_name="__main__")) is brittle about deeper
# relative hops; build_part died with "attempted relative import beyond top-level
# package" on some installs even though the module imports fine under a system
# Python. Absolute form resolves identically in every environment.
from sw_agent.bridge import Context, sw_get

# ---- 工具分组（按对模型状态的影响） ----

# 创建实体的特征：执行后特征树必须多一个名字，且通常改变包围盒
_FEATURE_CREATORS = {
    "extrude", "cut_extrude", "revolve", "fillet_edges", "fillet_all",
    "chamfer", "shell", "linear_pattern", "circular_pattern", "mirror_feature",
}
# 零件生成器：自建草图 + 拉伸，按实体特征验（P96：原本在 _SKIP 里，而它们最需要验）
_PART_GENERATORS = {"create_spur_gear", "create_stepped_shaft"}
# 参考几何：创建特征但不改变实体包围盒（box 验证跳过；create_plane 自带位置实测，P116-P120）
_REF_GEOMETRY = {"create_plane", "create_axis", "create_reference_point"}
# 草图实体：执行后草图段数应增加
_SKETCH_ADDERS = {
    "sketch_rectangle", "sketch_circle", "sketch_line", "sketch_polyline",
    "sketch_polygon", "sketch_arc_center", "sketch_centerline", "sketch_fillet",
    "sketch_rounded_rectangle",  # P100: P97 加了工具但这里漏了 → 批量里画没画进去无人验证
}
# 草图操作：不增加段数（关系/标注），但要求草图活跃
_SKETCH_OPS = {"add_sketch_relation", "add_dimension", "modify_dimension"}
# 纯查询：不验证（只读）
_QUERY_ONLY = {
    "bounding_box", "list_features", "list_components", "list_drawing_views",
    "mass_properties", "measure_selection", "check_interference",
    "sw_diagnostics", "sw_status", "get_custom_properties", "gear_pair_geometry",
    "capture_view", "analyze_view",
}
# 文档生命周期：切换/保存文档，不验证几何
_DOC_OPS = {
    "new_part", "new_assembly", "new_drawing", "open_document", "save_document",
    "save_as", "rebuild_model", "activate_configuration",
}
# 不验证的工具（视图/显示/装配组件操作等；delete_feature 等自带 P105 的删除后核对）
_SKIP = {
    "set_view_orientation", "rotate_view", "zoom_to_fit", "set_display_mode",
    "set_material", "set_custom_property", "add_equation", "add_drawing_note",
    "add_drawing_view", "add_section_view", "insert_bom", "insert_component",
    "insert_model_dimensions", "add_mate", "export_file", "export_stl",
    "create_drawing_of", "suppress_feature", "unsuppress_feature",
    "delete_feature", "rename_feature", "suppress_component",
    "unsuppress_component", "create_configuration",
}
# P96: 从 _SKIP 里搬走了四个 —— start_sketch / exit_sketch 的专门分支原本永远走不到
# （开头那个「命中 _SKIP 就跳过」的 return 先拦下了），而这两个检查（草图到底开没开）
# 恰恰是本模块最该抓的静默失败；两个零件生成器同理，见 _PART_GENERATORS。

# P121: 批处理与 agent 元工具。build_part 自带每步验证（本模块正是它在用），server
# 不再套一层；read_guidance / search_files / run_shell 完全不触碰 SolidWorks 文档。
# 单独成组是为了完备性门禁——「不验证」必须是一个显式决定，不是遗忘的默认值。
_BATCH = {"build_part"}
_META = {"read_guidance", "search_files", "run_shell"}

# ---- 分类（P121：server 级验证与 CI 完备性门禁共用同一张总表） ----

_KINDS = (
    ("solid", _FEATURE_CREATORS),
    ("generator", _PART_GENERATORS),
    ("ref", _REF_GEOMETRY),
    ("sketch_add", _SKETCH_ADDERS),
    ("sketch_op", _SKETCH_OPS),
    ("sketch_enter", frozenset({"start_sketch"})),
    ("sketch_exit", frozenset({"exit_sketch"})),
    ("query", _QUERY_ONLY),
    ("doc", _DOC_OPS),
    ("display", _SKIP),
    ("batch", _BATCH),
    ("meta", _META),
)

# server 只为这些类别付出两次快照的成本；其余类别 verify_step 本来就只会跳过
MUTATING_KINDS = frozenset(
    {"solid", "generator", "sketch_add", "sketch_op", "sketch_enter", "sketch_exit"}
)


def classify(name: str):
    """工具名 → 验证类别；None = 没有任何表认领它。

    P96（为 start_sketch 写的验证分支被 _SKIP 拦成死代码）和 P100（新工具
    sketch_rounded_rectangle 三个版本无人验证）都是「注册表和验证表是两张
    平行的人肉维护表」的产物。tests/test_verify_coverage.py 遍历注册表断言
    classify 永不返回 None——新工具不分类，CI 直接红。
    """
    for kind, names in _KINDS:
        if name in names:
            return kind
    return None


# ---- 快照 ----

def snapshot(ctx: Context) -> dict:
    """执行前/后各拍一张。失败降级为 None 字段 —— 快照是证据，不是门禁。"""
    s: dict = {"features": [], "box": None, "sketch_active": None, "sketch_segments": None, "bodies": None}
    try:
        s["features"] = [sw_get(f, "Name") for f in (ctx.all_features() or [])]
    except Exception:  # noqa: BLE001
        pass
    # P100: body count is the REAL "did geometry appear" signal. Feature count lies
    # here — every start_sketch adds a 草图N entry to the tree, so "feature tree
    # grew" is true even when an extrude silently built nothing. That is exactly how
    # the benchmark's build_part batch reported 10 steps ok with zero geometry on
    # screen. A solid feature must change the body count (or the box) too.
    try:
        bodies = ctx.solid_bodies()
        s["bodies"] = len(bodies)
    except Exception:  # noqa: BLE001
        s["bodies"] = None
    try:
        box = ctx.model.GetPartBox(True)  # x1,y1,z1,x2,y2,z2，单位米
        if box and len(box) >= 6:
            s["box"] = [round(float(v), 6) for v in box[:6]]
    except Exception:  # noqa: BLE001
        pass
    try:
        sm = ctx.sketch_mgr
        act = sm.ActiveSketch
        s["sketch_active"] = act is not None
        if act is not None:
            segs = act.GetSketchSegments()
            s["sketch_segments"] = len(list(segs or []))
    except Exception:  # noqa: BLE001
        pass
    return s


def _box_changed(before, after) -> bool:
    return bool(before and after and before["box"] and after["box"] and before["box"] != after["box"])


def _feat_added(before, after, want) -> bool:
    if not want:
        return len(after["features"]) > len(before["features"])
    return want in after["features"] and want not in before["features"]


# ---- 每步验证 ----

def verify_step(name: str, params: dict, before: dict, after: dict) -> dict:
    """对比快照，返回 {ok, checks:[...]}。绝不抛异常。"""
    checks: list = []
    ok = True

    if (
        name in _QUERY_ONLY or name in _DOC_OPS or name in _SKIP
        or name in _REF_GEOMETRY or name in _BATCH or name in _META
    ):
        return {"ok": True, "checked": False, "checks": ["只读/文档/显示类操作，跳过几何验证"]}

    if name in _PART_GENERATORS:
        # P96: 这两个生成器原来被跳过，可它们恰恰最该验 —— 齿轮「报告成功但零件
        # 没成型」我们追过好几轮。它们自建草图并拉伸，所以按实体特征验。
        grew = len(after["features"]) > len(before["features"])
        checks.append(
            f"特征树新增 {len(after['features']) - len(before['features'])} 个特征"
            if grew else "特征树没有新增特征 —— 生成器报告成功但零件没成型"
        )
        ok = grew
        if before["box"] and after["box"] and not _box_changed(before, after):
            checks.append("包围盒未变化 —— 没有实际生成几何")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if name in _FEATURE_CREATORS:
        # 特征类：执行后特征树必须多出这个名字（工具返回了 feature 名）
        ok = _feat_added(before, after, None)
        if ok:
            checks.append(f"特征树新增 {len(after['features']) - len(before['features'])} 个特征")
        else:
            checks.append("特征树没有新增特征 —— 工具报告成功但什么都没建成")
        # P100: body count is the honest "geometry appeared" test. Feature count lies
        # (start_sketch adds 草图N to the tree), so a batch can report 10 ok steps with
        # zero solid on screen. A solid feature must create/change a body. box is a
        # fallback when body enumeration is unavailable on this install.
        b_before, b_after = before.get("bodies"), after.get("bodies")
        if b_before is not None and b_after is not None:
            if b_after > b_before:
                checks.append(f"实体数 {b_before} → {b_after}")
            elif name == "cut_extrude":
                # cut keeps body count the same — box change is the only geometric signal,
                # and even that is exempt for interior cuts (P98). Feature-added already
                # passed; nothing more to verify here.
                checks.append("实体数不变（切除不增实体，特征树已确认新增）")
            elif name in ("fillet_edges", "fillet_all", "chamfer", "shell"):
                # P121: 修饰类特征作用在已有实体上，实体数不变是正常的 —— 之前这
                # 条路只在 build_part 里走，修饰特征恰好都跟在增实体特征后面，问题
                # 没暴露；单步验证会让每个成功的圆角/倒角被误判 verified_failed。
                # 包围盒变化是它们唯一的粗几何信号，但内圆角可能不改包围盒 ——
                # 特征树新增已经确认，不再加罚。
                checks.append("实体数不变（修饰类特征作用于已有实体，特征树已确认新增）")
            else:
                checks.append(f"实体数未增长（{b_before} → {b_after}）—— 报告成功但没生成实体")
                ok = False
        elif (
            name != "fillet_all"
            and name != "cut_extrude"
            and before["box"] and after["box"] and not _box_changed(before, after)
        ):
            checks.append("包围盒未变化 —— 实体特征没有实际改变几何")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if name in _SKETCH_ADDERS:
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

    if name in _SKETCH_OPS:
        if after.get("sketch_active"):
            checks.append("草图仍活跃")
        else:
            checks.append("没有活跃草图 —— 草图操作必须在 start_sketch 之后调用")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if name == "start_sketch":
        if after.get("sketch_active"):
            checks.append("草图已激活")
        else:
            checks.append("草图未激活 —— start_sketch 报告成功但没开草图")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    if name == "exit_sketch":
        if before.get("sketch_active") and not after.get("sketch_active"):
            checks.append("草图已退出")
        elif before.get("sketch_active") is False and after.get("sketch_active") is False:
            checks.append("本来就没有活跃草图（幂等）")
        else:
            checks.append("草图仍活跃 —— exit_sketch 报告成功但没退出")
            ok = False
        return {"ok": ok, "checked": True, "checks": checks}

    # 未知工具：不假装验证
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
_REQUIRES_BODY = {"cut_extrude", "fillet_edges", "fillet_all",
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
