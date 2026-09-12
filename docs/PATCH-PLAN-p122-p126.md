# P122–P126 补丁包总览（对应 `COMPARE-v2-ecosystem.md` §4 五阶段）

按顺序落位，每包独立可发版，每包末尾有真机回归清单。全部**无手改**（P125 有一处需确认 guidance 目录）。

| 包 | 版本 | 阶段 | 一句话 | 新增 / 覆盖 |
| --- | --- | --- | --- | --- |
| `p122-com-foundation` | 0.2.122 | 1 地基 | 晚绑定 + `_FlagAsMethod` + 单一 COM 线程；拆掉六轮补丁撞的接口墙 | +com_executor.py +typeinfo.py / bridge.py server.py |
| `p123-topology-index` | 0.2.123 | 2 读回 | `list_faces / list_edges / get_selection / select_entities / sketch_on_face` | +tools/topology.py / registry.py server.py verify.py |
| `p124-verify-quant` | 0.2.124 | 3 验证 | 体积/质心方向判定；装配与删除/抑制进验证；`edit_state / feature_diagnostics / diagnose_document` | +tools/health.py / verify.py server.py |
| `p125-reliability` | 0.2.125 | 4 协议 | op_id 幂等、state_version、错误码、版本 advisory、health、会话重放导出、陷阱手册、建模纪律 | +session_log.py +tools/session.py +docs / server.py verify.py |
| `p126-mcp-and-workflows` | 0.2.126 | 5 对外 | 零依赖 MCP server；`cut_face_outline` 复合工作流 | +mcp_server.py +tools/workflows.py / server.py verify.py |

## 落位顺序与门禁
```
for p in p122 p123 p124 p125 p126: 覆盖 → python -m compileall -q sidecar/sw_agent → pytest sidecar/tests -q → 真机回归清单
```
`tests/test_verify_coverage.py` 每包都更新导入清单——新工具模块不进清单，门禁看不到它。

## 每包真机验收的「一票否决」项
- P122：`create_plane offset=±50` 对称、`fillet vertical` 选中 4 条（P46/P120 清单）
- P123：`list_edges(axis=[0,1,0])` 恰 4 条 → `select_entities` → `fillet_edges(edges="selected")` ok
- P124：内部盲孔切除 `体积 -…` 且 `ok:true`；切在实体外 `ok:false`
- P125：同 op_id 两次 extrude 只多 1 个特征
- P126：Claude Desktop 通过 MCP 建出零件

## Node 侧待办（沉淀在各 APPLY 的「Node 侧」节）
1. agent-loop：每个 tool_call 带 uuid `op_id`；按 `code` 分支（STALE_STATE 自动重读一次）
2. 审批模式：`_advisory` 出现时 mutating 工具强制确认
3. ToolCard：显示 `get_selection / select_entities` 的索引与几何摘要；显示 `_verified.checks` 的 ΔV
4. 设置页：`health` 的版本与支持级别
5. guidance 索引加入 `modeling-discipline.zh.md`、`COM-PITFALLS.md`
