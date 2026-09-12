# 建模纪律（给模型读的 guidance · P125）

> 这是 agent 在 SolidWorks 里做事的规矩。每条都对应过一次真机失败。

## 一、先看再动
1. 不确定几何在哪，先 `list_faces` / `list_edges`（可带 `near` / `axis` / `kind` 过滤），再 `select_entities` 按索引选，最后特征工具用 `edges="selected"`。不要用坐标猜。
2. 用户说「这个面 / 这条边」并可能已经在窗口里点选了 → 先 `get_selection`，它会把点选映射成索引。任何会清选择的工具之前调用。
3. 每个工具结果都带 `_state`（当前文档、特征数、是否在草图中、选中情况）。先读它，不要再花一轮 `list_features` 定位自己。

## 二、序列
4. 一张草图一件事：`start_sketch` / `sketch_on_face` → 画 → `exit_sketch` → `extrude`/`cut_extrude`。拉伸会消耗草图；之后画新东西必须重新开草图。
5. 草图必须挂在基准面或**实体上的平面面**上。零件不是长方体时用 `sketch_on_face(face_index)`，不要 `start_sketch(face=top)`。
6. 删特征、抑制、读树前先 `edit_state`；`editing_sketch:true` 就先 `exit_sketch`。
7. 多步计划优先 `build_part`（整段预检，结构性错误在第一步前拦下）；被拒后退回单步，逐步看 `_verified`。

## 三、结果以证据为准
8. 工具说成功 ≠ 成功。看 `_verified.ok` 和 `checks`：拉伸要有「体积 +…」，切除要有「体积 -…」，圆角要有体积变化。`ok:false` 就停下说明，不要继续往上叠特征。
9. 切除体积没减少 → 通常是方向反了，试 `flip=true`；或草图不在实体上。
10. 装配：`insert_component` 看组件数是否 +1；`add_mate` 看是否有组件移动。
11. 危险操作后调一次 `diagnose_document`：`healthy:false` 时读 `feature_errors`，不要靠截图猜红叉。
12. `_advisory` 出现（未验证的 SolidWorks 版本）→ 每步确认，不批量。

## 四、常识
13. SolidWorks 世界坐标 **Y 向上**：Front=XY（法向 +Z），Top=XZ（+Y），Right=YZ（+X）。
14. 单位：工具入参 mm / 度；`list_*` 输出 mm。
15. 特征前清选择；配合、阵列方向等需要「标记」的选择用 `select_entities(mark=…)`。
16. 圆角/倒角放在主形体稳定之后；大范围圆角最后做。
17. 对称结构优先镜像；避免 A→B→C 链式驱动。
18. 遇到 `code: STALE_STATE` → 文档已被改动，重新 `list_*` 再行动；`NO_DOCUMENT` → 先 `new_part` / `open_document`。

## 五、不要做
- 不要在没有 `_verified` 证据时说「已完成」。
- 不要重复同一个失败调用超过一次而不改参数。
- 不要用 `run_shell` 绕过工具去写 COM 脚本——除非 `read_guidance` 里的陷阱手册（COM-PITFALLS）已读且用户明确要求。
