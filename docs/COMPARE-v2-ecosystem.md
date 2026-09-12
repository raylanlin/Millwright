# 生态对比 v2 — SolidPilot / SolidworksMCP-python / solidworks-mcp vs Millwright

> 2026-09-12 · 续 `COMPARE-solidpilot.md`（v1 结论仍成立，本文只补新发现，不重复）。
> 参照仓库：
> - **SolidPilot** `raylanlin/mcp-server-solidworks`（C# 执行层 + Python MCP 适配 + IR 编译器，AGPL）
> - **SolidworksMCP-python** `andrewbartels1/SolidworksMCP-python`（纯 Python pywin32，132 工具，MIT）
> - **solidworks-mcp** `just1step/solidworks-mcp`（C# .NET 8 托盘 Hub + Proxy，MIT，v0.1.0 2026-04）
> - **Millwright / SW Copilot**（Electron + Python sidecar，Apache-2.0，master@v0.2.121）

---

## 0. 最重要的一个发现：我们 60 个补丁的病，别人已经开过药

三个项目**都**撞过我们 P15→P120 的墙（pywin32 下「成员不存在 / 'int' object is not callable / 跨线程 AttributeError」）。SolidPilot 和 solidworks-mcp 用 C# 绕开；**SolidworksMCP-python 和我们一样是 pywin32，它的解法是可以直接搬的**：

| 我们的症状（补丁号） | 他们的诊断 | 他们的解法 |
| --- | --- | --- |
| P15 `'int' object is not callable` → 改早绑定 | 晚绑定下零参方法被当属性取值 | **保持晚绑定**，用 `CDispatch._FlagAsMethod(name)` 按接口批量标记（`sw_type_info.flag_methods(obj, "IModelDoc2", "IPartDoc")`），方法名来自 gen_py wrapper 的类定义（只读它，不用它绑定） |
| P46 / P116–P120 `DISP_E_MEMBERNOTFOUND`，as_iface/try_member 三级阶梯 | 早绑定一对象一接口 | 晚绑定 IDispatch 无接口墙；`GetBodies2` 直接在 model 上可调。整套 CastTo 阶梯**可以删除** |
| P23 warmup 线程与 RPC 线程共享 COM 对象炸 | STA 对象跨线程 | `ComExecutor`：一个专用线程 `CoInitialize`，所有 COM 工作 `submit(fn)` 排队执行，其它线程只拿 Future。**我们 server.py 主循环仍在 stdin 线程直接调 COM**，warmup 只是「不共享」而非「单线程」 |
| P26 SelectByID2 Callout 类型不匹配 | 同 | 同解（VT_DISPATCH null）——我们已修，说明方向一致 |
| P92 fillet 4 选 3、edge_select 八轮 | 新特征边未细分，坐标选择失败 | **`ForceRebuild3(True)` 必须在第一次坐标选边前调用**（他们 pitfall #3）。我们 edge_select 三策略里没有这一步 |
| fillet 返回值处理 | SW 2025+ `IModelDoc2.FeatureFillet3` 返回 **int** 不是 IFeature | 按 `RevisionNumber` 主版本分支（≥33） |
| `check_interference` | `ToolsCheckInterference2` 是 Sub，晚绑定下 out 参数**永远为 None**，永远报「无干涉」 | 改用 `InterferenceDetectionManager.GetInterferenceCount()` + `finally: Done()` —— **我们的 check_interference 大概率一直在静默返回 0，需立刻核对** |
| `insert_component` | `AddComponent5` 前必须 `OpenDoc6` 加载文档，且 out 参数用 `VARIANT(VT_BYREF\|VT_I4)`；返回对象不代表插入成功 | 用组件数前后对比验证（正好是我们 P121 的 snapshot 思路，但 assembly 类目前在 `_SKIP`） |
| `add_mate` | `AddMate5`（15 参），成功与否只能靠组件 `Transform2` 前后对比 | 同上，加进验证层 |
| 新建文档模板 | SW 2025 `GetUserPreferenceStringValue(0..3)` 为空，8/9/10 才是零件/装配/工程图模板 | 我们 P27 template-fix 是否覆盖？核对 |

这张表的意义：**我们不需要换语言**。晚绑定 + 按接口 flag + 单 COM 线程，三件事做完，v1 文档第 2.1/2.2 节的「地基」问题就解决了，代码仍是 Python，sidecar 结构不变。

---

## 1. 四个项目的定位矩阵

| | SolidPilot | SolidworksMCP-python | solidworks-mcp | Millwright |
|---|---|---|---|---|
| 形态 | MCP server（Claude Desktop 为主） | MCP server（FastMCP） | MCP server + 托盘 Hub/Proxy | **桌面 App**，自带 agent loop，任意 LLM |
| COM 层 | C# .NET 4.8 STA 线程 | Python 晚绑定 + ComExecutor + flag_methods | C# .NET 8 `StaDispatcher`，Hub 独占会话 | Python 早绑定，主线程直调 |
| 工具数 | 47 + 13 资源 | 132（含 VBA 生成、宏、模板、API 文档检索） | ~40（文档/视图/选择/草图/特征/装配/工作流） | 77 |
| 读回 | analyze_model 8 模式、get_selection、feature_map | list_features、get_model_info、drawing_analysis | ListEntities/SelectEntity 索引、GetFeatureDiagnostics、Sensors、EditState | list_features / bbox / mass / measure |
| 验证 | compare_parts（拓扑+ΔV+ΔA）、result_geometry | 组件数/Transform 前后对比（零散） | DiagnoseActiveDocumentHealth（官方错误码 + 重建 + 保存诊断） | `_verified` 快照（P121） |
| 可靠性机制 | operation_id 幂等、state_version | circuit breaker、连接池、重试退避 | 版本兼容门禁（2024 认证/2025 目标/2026 实验→高风险操作阻断）、死连接 HRESULT 检测重连 | 无 |
| 视觉 | — | — | 视口 PNG 导出（无分析） | **双路径视觉分析** |
| 复合工作流 | analyze_drawing→build | 批量导出/模板/宏 | CutFaceByProjectedEdges、ReplaceNestedComponentAndVerify、ReviewTargetedStaticInterference | build_part（批量+precheck）、create_spur_gear/stepped_shaft |
| 模型侧指导 | recipe:// 资源 | docs_discovery（让模型查 SW API 文档） | `skills/solidworks-modeling-tips.md` | read_guidance |
| 会话可重放 | save_analysis 产物 | **SoC logging：SQLite 记录每次调用 → 导出为可运行 Python 脚本** | 日志 | 对话历史 |
| 许可证 | AGPL + 商业 | MIT | MIT | Apache-2.0 |

我们独有且应保持的：桌面 UI + 审批模式、任意 LLM、视觉回路、mm 单位、Apache-2.0。
我们唯一落后于**全部三家**的：COM 层线程/绑定模型、面/边索引读回。

---

## 2. 值得吸收的具体机制（按项目）

### 2.1 来自 SolidworksMCP-python（同技术栈，可直接移植）
1. **`ComExecutor`**（~200 行）：专用 STA 线程 + queue + Future。server.py 的 `call` 分支改为 `executor.run(lambda: _call_verified(...))`；warmup 也走它（不再需要「抛弃式连接」）。
2. **`sw_type_info`**：读 gen_py wrapper 得到每接口方法名集合（只读不绑），对 swApp / 每个文档 / 每个短命对象按需 `flag_methods`。`flag_members(obj, "GetType", "GetTitle")` 用于循环内短命对象（省 GetIDsOfNames 往返）。
3. **`docs/agents/com-api-pitfalls.md` 模式**：每条 = 症状 + 根因 + 修法 + 发现日期。我们 120 个 APPLY.md 里其实埋着同样的知识，但没人能检索。建议把 P13/P15/P16/P26/P45/P46/P92/P105/P116–P120 提炼成 `docs/COM-PITFALLS.md`，同时喂给 `read_guidance` 工具——**模型自己也能读**。
4. **SoC 会话日志 → 可重放脚本**：每次 sidecar call 落 SQLite，导出成 pywin32 Python 脚本。这直接对应我们 CLAUDE.md 说的「AI 生成脚本注入」初衷，且是宣传点：「对话 → 可交付的宏」。
5. **API 文档检索工具**（`lookup_api_method`）：让模型在生成 run_shell / 自定义脚本前先查签名。我们已有 `docs/API-REFERENCE.md`，索引化即可。
6. 不要学的：complexity analyzer / intelligent router / 连接池——文档自己承认多为「in progress」，对单机单 SW 实例是过度工程。

### 2.2 来自 solidworks-mcp（just1step）
1. **`GetEditState` 门**：树读取、删特征、清理草图必须在非编辑态。我们 P105 delete_feature 谎报十次，很可能就是在草图编辑态下删。加 `edit_state` 到 `_state` 快照，mutating 工具前自动检查。
2. **`GetFeatureDiagnostics`**：读 FeatureManager 官方错误码（What's Wrong），而不是靠截图猜红叉。我们视觉回路很贵，这个是免费的结构化替代。
3. **`DiagnoseActiveDocumentHealth`**：ForceRebuild → 特征错误 → 可选保存诊断，作为「危险操作后的验证门」。可作为 build_part 结束后的自动一步。
4. **版本兼容门禁**：按 `RevisionNumber` 映射年份，未验证版本上**阻断高风险修改**并给出 advisory。我们支持 2017+，但真机只验过少数版本——诚实标注比宣称更可信。
5. **死连接检测**：`0x800706BA`（RPC unavailable）等 HRESULT → 丢弃旧包装重新 attach。我们 P73/P74 修过连接，但没有「连上后又死掉」的恢复路径。
6. **复合工作流工具** `CutFaceByProjectedEdges`：选面 → 开草图 → `SketchUseEdge3` 投影面边 → 切除，一个工具。这类「高频且多步易错」的序列值得打包（我们 build_part 是通用批量，这是领域特化，两者互补）。
7. `ListReferencePlanes` 返回本地化名字 + `GetSolidWorksContext` 返回 UI 语言——我们 `_PLANES` 中英双表是硬编码，改为运行时读取。
8. `skills/solidworks-modeling-tips.md`：给模型的建模纪律（草图挂实体面、先清选择、切除方向翻入实体等）。我们 guidance 里应有对应中文版。

### 2.3 来自 SolidPilot（v1 已列，补充细节）
1. `analyze_model(edges|faces, near=[x,y,z], k=5, axis=[0,0,1])` —— **带过滤的读回**，避免整表 dump 吃 token。
2. `add_sketch_entities`（批量，一个 AddToDB 括号），失败时报「第 i 条失败、前 n 条已建」。
3. `extrude_feature(up_to_face_index=…, mid_plane=…)`：终止条件用面索引；我们 extrude 只有 blind/through_all。
4. `result_geometry`：草图实体建完读回真实圆心/半径；rib 建完读回 volume/faces/edges。
5. sketch plane **frame**（origin + xdir + ydir）读回：解决「Right 面草图往 -Z 建」这类镜像问题——我们 P37/P39/P40/P42 cut 方向四轮正是这个问题的表象。
6. `get_selection`：几何 JSON DeepEquals 匹配到索引（因为 RCW 引用不可比、IsSame 不可靠）——我们 `edge_fingerprint`（GetCurveBox）是同一思路，可以直接扩展成索引匹配。
7. NoiseFeatureTypes 表：过滤 21 种无设计意图的树节点，list_features 输出干净。

---

## 3. 对「可用性不高」的重新归因

把三家的经验对到我们的 CHANGELOG：

| 根因 | 我们的补丁群 | 三家的对应解 | 状态 |
| --- | --- | --- | --- |
| A. COM 绑定/线程模型 | P15 P16 P23 P24 P46 P69 P72 P73 P116–P120 | 晚绑定 + flag_methods + ComExecutor | **未解**，仍在打补丁 |
| B. 选边/选面靠坐标猜 | P37 P39 P40 P42 P45 P49 P67 P82 P83 P85 P86 P92 P99 | 索引读回 + ForceRebuild3 前置 + 面 frame | **未解** |
| C. 工具谎报成功 | P92 P100 P105 P121 | result_geometry / 组件数·Transform 对比 / 官方诊断码 | P121 半解（只看「有没有变」） |
| D. 编辑态/文档态混乱 | P96 P110 P112 | GetEditState 门 + state_version | 未解 |
| E. 模型缺乏领域纪律 | P28 P30 P33 P35 P43 P50 | skills/tips 文档 + recipe 资源 | 部分（read_guidance 有壳） |
| F. 连接生命周期 | P9 P13 P14 P17 P24 P73 P74 | health/ensure 分离 + 死连接检测 | 部分 |

A 和 B 占了补丁总数的一半以上，且互相放大（选边失败一半是因为读不到几何）。**先做 A，B 会自然变简单。**

---

## 4. 建议路线（按依赖顺序，每阶段可独立发版）

### 阶段 1 — 地基（预计 2 个补丁包）
- `bridge.py`：`_connect` 改 `win32com.client.dynamic.Dispatch`；新增 `typeinfo.py`（移植 sw_type_info 思路，用现有 typelib.py 的注册表读取）；`Context.model` 取到后 `flag_doc`；删除 `as_iface`/`try_member`/`solid_bodies` 三级阶梯（保留 `sw_get` 作为兜底）。
- `server.py`：引入 `ComExecutor`，所有 `call`/`reconnect` 走它；warmup 改为 executor 内首次 connect。
- 回归：P46/P116–P120 的真机清单（GetBodies2、create_plane ±50）必须一次通过；这是判断阶段 1 成功的唯一标准。

### 阶段 2 — 读回与索引选择（2–3 个补丁包）
- `list_faces` / `list_edges`（含 near/k/axis 过滤；索引 = GetBodies2→GetFaces/GetEdges 枚举顺序；每项带 fingerprint）。
- `fillet_edges / chamfer / start_sketch(face_index) / extrude(up_to_face_index) / add_mate` 接受索引；坐标路径保留。
- `get_selection`：用户 GUI 选中 → 索引。桌面 App 的天然优势：ToolCard 里可以直接显示「你选中的是 face #7」。
- edge_select 第一步加 `ForceRebuild3(True)`。
- `_state` 加 `edit_state`（草图编辑中 / 特征编辑中）、`sw_version_year`。

### 阶段 3 — 验证升级（1–2 个补丁包）
- snapshot 加 volume/area/com（`GetMassProperties2`）；extrude/cut 做 ΔV 方向与量级校验。
- assembly 工具从 `_SKIP` 搬出：insert_component 验组件数、add_mate 验 Transform2。
- `check_interference` 改 InterferenceDetectionManager（先真机确认现状是否一直返回 0）。
- 新增 `feature_diagnostics`（官方错误码）+ `diagnose_document`（rebuild + 诊断 + 可选保存），build_part 末尾自动调一次。
- 每个创建工具返回 `result_geometry`。

### 阶段 4 — 可靠性与纪律（1–2 个补丁包）
- operation_id 幂等 + state_version（v1 第 3 节）。
- 版本兼容门禁：`sw_status` 返回年份与支持级别；未验证版本上高风险工具走审批模式强制确认。
- 死连接 HRESULT 表 → 自动 reconnect。
- `docs/COM-PITFALLS.md`（从 APPLY.md 提炼）+ `guidance/modeling-discipline.zh.md`（对标 just1step skills），接进 `read_guidance`。
- 会话调用日志 → 导出 Python/VBA 脚本（复用现有 vba-macro-writer）。

### 阶段 5 — 对外（之后）
- sidecar `list_tools/call` 套一层 MCP stdio，Millwright 同时成为 MCP server（roadmap v1.0 已有）。
- 复合工作流工具（面轮廓切除、孔阵列、法兰）。
- 钣金 / 工程图补全（auto_center_marks、hole_callout、flat_pattern_view）。

---

## 5. 一句话给持续跟进用

跟进三家时看的信号：
- **SolidPilot**：durable reference resolver（拓扑命名）有没有突破——那是所有人的天花板；forward `submit_feature_graph` 何时替代低层工具。
- **SolidworksMCP-python**：`com-api-pitfalls.md` 新增条目（免费的真机验证知识）；pitfall #18 `InsertModelAnnotations3` 是否解决（我们 `insert_model_dimensions` 同样可能是空转）。
- **solidworks-mcp**：版本兼容矩阵更新（SW 2026 何时从 Experimental 升级）；WorkflowTools 新增哪些复合工作流。
