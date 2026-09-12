# SolidWorks COM 陷阱手册（pywin32 · Millwright sidecar）

> 每条 = 症状 → 根因 → 修法 → 出处。来自本项目 P13–P125 的真机记录，以及对标项目
> （SolidworksMCP-python `com-api-pitfalls.md`、SolidPilot、just1step）的公开经验。
> 改任何 COM 相关代码前先读这里；新踩的坑按同格式追加。

## 绑定与线程

### 1. `'int' / 'str' / 'tuple' object is not callable`
- **根因**：晚绑定下 pywin32 对未知名字先试 PROPERTYGET，成功就把方法当属性返回其值。
- **修法**：`typeinfo.flag_methods(obj, "IModelDoc2", ...)`（`_FlagAsMethod`）；工具代码用 `sw_get(obj, "GetType")` 两种形式都对。
- **别做**：为此切早绑定（P15）——会撞 #2。

### 2. `DISP_E_MEMBERNOTFOUND (-2147352573, 找不到成员)` / `<unknown>.GetBodies2`
- **根因 A**：早绑定一对象一接口（IModelDoc2 上没有 IPartDoc.GetBodies2）。P46/P116–P120。
- **修法 A**：晚绑定（P122 默认）。
- **根因 B**：调用对象本身就错：`InsertFeatureChamfer` 在 `IFeatureManager` 不在 `Extension`；`GetTessellation` 在 IFace2 不在 IEdge。
- **修法 B**：查 gen_py 里 `def 方法名` 所在的类。

### 3. 跨线程 `com_error` / `AttributeError: SldWorks.Application.ActiveDoc`
- **根因**：STA 对象跨线程使用（P23 warmup 线程）。
- **修法**：所有 COM 走 `ComExecutor`（P122）。不要在别处 `CoInitialize`。

### 4. gen_py 缓存过期 → `Member not found` / `NoneType not callable`
- **根因**：SW 升级后 `%TEMP%\gen_py\` 里的 wrapper 指向旧 TLB。
- **修法**：删 `%TEMP%\gen_py`；P122 只读缓存不依赖它。

### 5. 启动时 makepy 把连接饿死（P69/P72）
- **症状**：「SolidWorks 正在运行但 COM 拒绝」。
- **修法**：永远不要在启动路径生成 typelib 缓存。

## 参数形态

### 6. `SelectByID2` `(-2147352571, Type mismatch, None, 8)`
- Callout 必须 `VARIANT(VT_DISPATCH, None)`，裸 `None` 是 VT_NULL。P26。

### 7. byref out 参数：`OpenDoc6(errors, warnings)`、`GetMassProperties2(status)`、`RunMacro2(Error)`、`AddMate5(ErrorStatus)`
- 晚绑定下传 `VARIANT(VT_BYREF | VT_I4, 0)`，事后读 `.value`；裸 `0` → Type mismatch；`pythoncom.Missing` 在部分方法上报「不能转换为 VARIANT」。
- `OpenDoc6` 传 `Missing` 会返回 None，文档没加载 → 后续 `AddComponent5` 静默无效（#12）。

### 8. `SelectByID2(..., SelectOption=16)` 静默被丢（P114/P116）
- swSelectOption_e 只有 0/1。传无效值不报错、不生效。基准面朝向是特征属性，用 refplane 设置并**实测**。

## 返回值

### 9. `FeatureFillet3` / `FeatureChamfer` 返回 `int` 不是 IFeature（SW 2025+ 的 IModelDoc2 版本）
- 1=成功 0=失败；`.Name` 会炸。用 `IFeatureManager` 版本，或用特征树前后差找新特征（本项目 `_new_feature_of`）。

### 10. `ToolsCheckInterference2` 是 Sub，out 参数晚绑定下永远 None → 永远「无干涉」
- 用 `InterferenceDetectionManager.GetInterferenceCount()` / `GetInterferences()`，`finally: Done()`。`IInterference.Components` 是属性不是 `GetComponents()`。

### 11. `InsertModelAnnotations3` 返回的是 IAnnotation 数组，不是计数
- `int(result)` 无意义；`len(result)` 才是。对标项目记录它在 SW 2025 返回 None（未解）——我们 `insert_model_dimensions` 结果需真机核对。

## 静默失败

### 12. `AddComponent5` 返回对象但没插入
- 组件文档必须先 `OpenDoc6` 加载；零件无实体也会静默失败。**用组件数前后对比验证**（P124 `_verified`）。

### 13. `AddMate5` 接受配合但什么都没动
- 只能靠组件 `Transform2` 前后对比（P124）。

### 14. 新特征的边坐标选不中（`SelectByID2 EDGE` 返回 False）
- 重建前未细分。第一次坐标选边前 `ForceRebuild3(True)`（P122 `ensure_tessellated`）。P92「4 选 3」的成因之一。

### 15. 坐标选边只能选到当前视角**可见**的边（P89）
- 底面边在等轴测下不可见。索引选择（P123 `select_entities`）不受此限。

### 16. 残留选中让 `FeatureFillet3` 圆掉整个面（P93）
- 特征前 `ClearSelection2(True)`；只数边：`GetSelectedObjectType3 == 1`（swSelEDGES=1，**2 是 FACES**）。

### 17. 草图编辑态下删特征/读树不可靠（P105）
- 先 `edit_state`；`editing_sketch` 为真先 `exit_sketch`。

### 18. `GetUserPreferenceStringValue(0..3)` 在 SW 2025 为空
- 模板槽位 8=零件 9=装配 10=工程图；校验扩展名和文件存在。

### 19. 面的边要从 loop 走：`face.GetLoops()` → `loop.GetEdges()`
- `face.GetEdges()` 读的是 `GetTrimCurves2` 填的临时缓冲，可能为空（P86）。

### 20. `IsSame` / COM 引用相等在本机不可靠（P90/P94）
- 用几何指纹（`GetCurveBox` 6dp）去重、匹配；P123 `get_selection` 亦然。

## 生命周期

### 21. `0x800706BA RPC server unavailable` 之后所有调用都失败
- SW 关了又开，sidecar 拿着死指针。P122/P125：识别 `DEAD_HRESULTS` 自动 `reconnect` 一次。

### 22. 大文件批处理会把 SW 崩掉
- 打开→导出→关闭之间留 ~10 s；>1 MB 零件最后做；一次崩溃后停止循环不要重试风暴。

## 查询处
| 问题 | 去哪看 |
| --- | --- |
| 方法属于哪个接口 | gen_py `…x0x{major}x0.py` 搜 `def 方法名` |
| 方法还是属性 | `def` = 方法；`_prop_map_get_` = 属性 |
| 返回 IFeature 还是 int | `InvokeTypes(...)` 返回类型 `(9,0)` 对象 / `(3,0)` int |
