# SolidPilot (raylanlin/mcp-server-solidworks) vs Millwright / SW Copilot — 功能对比与优化建议

> 2026-09-12 · 基于 SolidPilot main@fc3c743 与本项目 master@v0.2.121（P121）
> 目的：找出本项目「可用性不高」的根因，借鉴对方已验证的做法。

---

## 0. 一句话结论

两个项目解决的是同一个问题，但**投入的位置不同**：

- **SolidPilot**：几乎全部精力在「执行层可信 + 结果可验证」——C# STA 单线程 COM、幂等/状态版本、`verified` 判定（拓扑精确 + ΔV≤1% + ΔA≤1%）、把读回（analyze）做到比写入更厚。写入面 ≈ 47 工具，但每个都跑过真机、且有读回对账。
- **Millwright**：精力大量花在「LLM 编排 + 桌面 UI + 多厂商兼容」，执行层（Python sidecar / pywin32）是后补的，P46→P120 有 ~60 个补丁在同一类问题上反复（早绑定接口墙、工具谎报成功、分类表漂移）。P121 才把验证搬到统一入口。

**可用性不高的根因不是工具数量（77 vs 47，我们更多），而是「每个工具的真机可信度」和「模型拿到的读回信息不够厚」。** 下面按层拆。

---

## 1. 架构对比

| 维度 | SolidPilot | Millwright | 评注 |
|---|---|---|---|
| 形态 | MCP server（任何 MCP 客户端可接） | Electron 桌面 app，自带 agent loop | 我们对普通用户更友好；他们对开发者/Claude Desktop 用户零 UI 成本 |
| COM 执行 | C# .NET 4.8，**单一专用 STA 线程**（`StaExecutor`）串行化全部 COM 调用 | Python pywin32，`gencache.EnsureDispatch` 早绑定 + `as_iface/try_member` 阶梯 | 他们直接绕开了我们 P15/P46/P116–P120 撞的接口墙：C# 拿的是强类型互操作程序集，不存在「成员不存在」 |
| 层次 | Planner(IR) → Compiler(确定性) → Execution(COM)，各层互不知道对方 | agent loop → sidecar tools，一层到底 | 他们多一层 IR/编译器，意在把 token 成本收敛到「一次调用一个 feature graph」 |
| 状态一致性 | `operation_id` 幂等 + `state_version` 乐观并发（`OperationGuard`），返回 `COMPLETED / FAILED / DUPLICATE` | 无 operation id；重试 = 重做 | 流式/断线重试时我们会双做特征 |
| 契约测试 | 适配器 ↔ `tool-schemas.json` 双向漂移测试；IR schema ↔ validator 双向测试；CI 离线跑 | P121 起有 `classify` 完备性门禁（registry ↔ verify 表） | 同思路，我们刚起步 |
| 验证口径 | `compare_parts`：拓扑精确 ∧ \|ΔV\|≤1% ∧ \|ΔA\|≤1% → `verified`；每个 create 工具回 `result_geometry`（实际圆心/半径/端点） | `_verified`：特征数 / 实体数 / 包围盒 / 草图段数 前后快照 | 我们的证据是「有没有变」，他们的是「变成了什么」 |
| 读回（analyze） | `analyze_model` 8 种模式：geometry / mass / bodies / features / edges / faces / sketch / **feature_map**（每特征消费/创建的拓扑）；`get_selection` 把 GUI 选中映射到分析索引 | `list_features` / `bounding_box` / `mass_properties` / `measure_selection` / `check_interference` | **最大差距**。模型看不到面/边索引，就只能靠坐标猜选边 → 我们 edge_select 八轮迭代的根源 |
| 视觉 | 无 | `capture_view` + `analyze_view`（双路径） | 我们独有优势，保留 |
| 钣金 | base_flange / edge_flange / sketched_bend / flat_pattern | 无 | 机械行业高频需求缺失 |
| 工程图 | 创建/视图/剖视/自动标注/中心线/孔标注/展开视图；读 DXF/DWG 反建模 | `new_drawing / add_drawing_view / add_section_view / insert_model_dimensions / insert_bom / add_drawing_note` | 我们有骨架，缺自动中心符号、孔标注、展开视图 |
| 装配 | insert(13 数变换) / add_mate(索引选面) / analyze_assembly(树+变换+配合) / compare_assemblies / save_body_as_part | insert_component / add_mate / list_components / suppress / check_interference | 缺读回：不知道组件变换和配合，装配无法迭代 |
| 单位 | 全部米（SW 内部单位），文档里明说 | mm/度，生成器内转换 | 我们的选择对 LLM 更友好，保留 |
| 许可证 | AGPL-3.0 + 商业双许可 | Apache-2.0 | 我们更宽松，可作宣传点 |

---

## 2. 我们「可用性不高」的四个具体病灶（对照他们怎么解的）

### 2.1 早绑定接口墙 —— 60 个补丁的主线
P15 → P46 → P69(makepy) → P72 → P116–P120。pywin32 早绑定下每个对象只绑一个接口；`GetBodies2` 在 IPartDoc、`GetSpecificFeature2` 在 IFeature……每次新 API 都要重新发现一遍。P120 用 `as_iface/try_member` 收成一个出口，但**这是在给一个结构性问题打通用补丁**。

SolidPilot 的解法是换语言：C# + SolidWorks 互操作程序集，接口转换是编译期的事。

**建议（三选一，按代价排序）：**
1. **最小**：sidecar 全部改 `win32com.client.dynamic.Dispatch`（纯 IDispatch，晚绑定），放弃 makepy。P15 的 `'int' object is not callable` 是枚举常量问题，可用本地常量表替代（我们 `API-REFERENCE.md` 已有一份）。代价：失去类型提示、部分 out 参数需 `pythoncom` 手工包装。
2. **中等**：sidecar 保留 Python 做 JSON-RPC 与工具编排，COM 部分用 **pythonnet 加载 SolidWorks.Interop.sldworks.dll**——拿到和 C# 一样的强类型接口，接口墙消失，代码仍是 Python。
3. **最大**：执行层改 C#（可以直接借鉴 SolidPilot 的 `StaExecutor` 模式，AGPL 只需不复制代码、自己实现）。Electron 通过 stdio/HTTP 调它。

我倾向 2：一周内可迁移，且顺带解决 2.2。

### 2.2 COM 线程模型
我们的 sidecar 是否在 STA 线程上做**所有** COM 调用（含首次 `GetObject` attach）？P23 "warmup-thread-fix" 说明踩过。SolidPilot 的经验：MTA 线程上轻量调用能「跛行」通过，钣金返回 null、圆角死锁（`ContextSwitchDeadlock`）——症状正好像我们「工具说成功但几何没变」的一部分。

**建议**：sidecar 启动时 `pythoncom.CoInitializeEx(COINIT_APARTMENTTHREADED)`，一个专用工作线程 + 队列，所有工具调用 marshal 进去（约 40 行）。写进 `bridge.py` 的不变量注释。

### 2.3 读回太薄 → 模型只能猜
edge_select「三策略八轮收束」、cut 方向四轮（P37/39/40/42）、fillet 选边部分成功——都是因为模型没有**面/边的可寻址列表**。SolidPilot 让模型先 `analyze_model(mode='edges')` 拿到带索引、几何摘要（类型/长度/端点/所属面）的列表，再用索引选边；`get_selection` 反向把用户在 GUI 点的东西映射到同一索引。

**建议（优先级最高的功能项）：**
- 新增 `list_faces` / `list_edges`（返回 index、类型、法向/方向、中心、面积/长度、相邻关系），索引在一次 rebuild 内稳定。
- `fillet_edges` / `chamfer` / `start_sketch(face=)` / `add_mate` 接受 `edge_index` / `face_index`，坐标选择降为兼容路径。
- 新增 `get_selection`：读用户 GUI 当前选中 → 同一索引空间。这让「用户点一下 + 说一句」成为最可靠的交互方式，也是桌面 app 相对 MCP 的天然优势。
- 每个创建工具返回 `result_geometry`（实际建出的尺寸），而不只是 `_verified.ok`。

### 2.4 「成功」的定义
`_verified` 现在只回答「特征树多了一个、实体数/包围盒变了」。这挡得住谎报，挡不住**建错**（切反方向、拉伸 10 建成 20）。SolidPilot 用质量属性（体积/面积/质心）作为廉价的几何指纹，每步都读。

**建议**：snapshot 加 `volume / area / com`（`GetMassProperties2` 一次调用），`verify_step` 对有明确预期的工具做量化校验：extrude depth d → ΔV ≈ 草图面积 × d（±2%）；cut → ΔV<0；create_plane 已做 measured_offset，推广即可。

---

## 3. 可以直接借鉴的机制（小而确定）

| 机制 | 他们 | 我们做法 | 工作量 |
|---|---|---|---|
| 幂等 | 每次调用带 `operation_id`，重复返回 `DUPLICATE` | agent loop 为每个 tool_call 生成 uuid 传给 sidecar；sidecar 维护 `{op_id: result}` LRU。解决流式中断重试双做 | 小 |
| state_version | 每次 mutating 成功 +1，调用方带上旧值不匹配即拒 | 用户在 SW 里手动改了模型后，模型持有的上下文过期 → 拒绝并提示重读。配合 `sw_status` 返回当前版本 | 小 |
| 错误码 | `FAILED + {code, message}`，code 是枚举（`FEATURE_CREATION_FAILED`, `OPEN_FAILED`…） | 我们目前 `{ok, error: string}`；加 `code` 字段让 Node 侧审计层和模型都能分支处理 | 小 |
| health / ensure_ready 分离 | `/health` 只读探测；`ensure_ready` 才启动 SW | 我们的 `sw_status` 与连接混在一起（P24/P73 都在修）；拆开 | 小 |
| 工具描述 vs 资源 | 近静态的规则文档走 MCP resource，不占每轮 token | 我们 `read_guidance` 已是同一思路；进一步把 77 个工具描述精简，长说明移到 guidance | 中 |
| 批量草图实体 | `add_sketch_entities`（复数）一次画完整轮廓 | `sketch_polyline` 部分覆盖；加通用 `sketch_entities([...])` 减少往返和「画一半退出」 | 小 |
| 契约测试 | 工具 schema 与实现双向漂移即 CI 红 | P121 已有 classify 门禁；再加 `registry ↔ i18n 标签 ↔ 文档工具表` 三向对账 | 小 |

---

## 4. 他们做了、我们暂时**不该**跟的

- **Feature Graph IR + 确定性编译器**：他们自己承认 forward 路径的价值要等「耐久引用解析器」（拓扑命名问题）解决才兑现，目前低层工具仍是主路径。我们 `build_part` 批量 + precheck 已是轻量版 IR，够用。别在可用性还低的时候再加一层抽象。
- **DXF/DWG 反建模**：巨大工程（`dxf_read.py` 55KB + 轮廓链接 + 曲线拟合），是他们的差异化卖点，不是我们的。
- **MCP server 化**：roadmap v1.0 已有；可以等执行层稳定后，把 sidecar 的 `list_tools/call` 直接套一层 MCP stdio，成本很低，但现在做只会把不稳定的工具暴露给更多客户端。

---

## 5. 建议的优先顺序（面向「先可用」）

1. **执行层地基**（2.1 + 2.2）：pythonnet 互操作 或 纯动态 Dispatch；STA 专用线程。目标：删掉 `as_iface/try_member` 以及围绕接口墙的全部特判。
2. **读回加厚**（2.3）：`list_faces / list_edges / get_selection` + 索引选边/选面 + `result_geometry`。这一项直接决定模型能不能做第二步。
3. **量化验证**（2.4）：质量属性进快照，extrude/cut 做 ΔV 校验。
4. **协议卫生**（第 3 节）：operation_id 幂等、state_version、错误码、health 拆分。
5. 之后再谈钣金、工程图补全、MCP 化。

每一项做完的验收都应是**真机回归清单**（像 P116/P121 APPLY.md 末尾那样），而不是单元测试绿——他们 README 明确写「CAD 操作的行为验证是手动对真机，by design」，这一点他们是对的。

---

## 6. 我们相对他们的真实优势（别丢）

- 任意 LLM 厂商（他们绑 MCP 客户端，本质上仍多为 Claude Desktop）
- 视觉回路（截图 → 视觉模型/多模态）
- 桌面 UI：审批模式、ToolCard、流式；用户不需要会配 `claude_desktop_config.json`
- mm/度 单位对模型友好
- Apache-2.0
- `build_part` 批量 + precheck：一次提交整段计划，precheck 拦掉结构性错误

把执行层补到他们的可信度，这些优势才算真正兑现。
