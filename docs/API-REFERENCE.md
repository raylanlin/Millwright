# SW Copilot — API 参考与 SolidWorks COM 速查手册

> 版本 1.0 · 2026-04-23

---

## 1. LLM 适配器 API

### 1.1 配置接口

```typescript
interface LLMConfig {
  protocol: 'anthropic' | 'openai';  // API 协议类型
  baseURL: string;                    // 服务端点
  apiKey: string;                     // 认证密钥
  model: string;                      // 模型标识符
  systemPrompt?: string;              // 自定义系统提示词
  temperature?: number;               // 生成温度 (0-1, 默认 0.3)
  maxTokens?: number;                 // 最大输出 token (默认 4096)
  stream?: boolean;                   // 是否流式输出 (默认 true)
}
```

### 1.2 消息格式

```typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];             // AI 请求调用的工具
  code?: string;                      // 提取出的代码块
  codeLanguage?: 'vba' | 'python';   // 代码语言
}

interface ToolCall {
  name: string;                       // 工具名称
  parameters: Record<string, any>;    // 调用参数
  result?: string;                    // 执行结果
}
```

### 1.3 Anthropic 协议请求格式

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "system": "你是 SolidWorks 自动化助手...",
  "messages": [
    { "role": "user", "content": "把所有圆角改成 3mm" }
  ]
}
```

请求头：

```
Content-Type: application/json
x-api-key: sk-ant-xxxxx
anthropic-version: 2023-06-01
```

### 1.4 OpenAI 兼容协议请求格式

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "你是 SolidWorks 自动化助手..." },
    { "role": "user", "content": "把所有圆角改成 3mm" }
  ]
}
```

请求头：

```
Content-Type: application/json
Authorization: Bearer sk-xxxxx
```

---

## 2. COM Bridge API

### 2.1 连接管理

```typescript
class SolidWorksBridge {
  connect(): Promise<boolean>          // 连接 SolidWorks
  disconnect(): void                   // 断开连接
  isConnected(): boolean               // 检查连接状态
  getVersion(): string                 // 获取 SW 版本号
  getActiveDocument(): ModelDoc2       // 获取当前活动文档
  getDocumentType(): 'part' | 'assembly' | 'drawing' | null
}
```

### 2.2 脚本执行

```typescript
interface ScriptResult {
  success: boolean;
  output: string;        // 标准输出
  error?: string;        // 错误信息
  duration: number;      // 执行耗时 (ms)
}

class ScriptEngine {
  runVBA(code: string): Promise<ScriptResult>
  runPython(code: string): Promise<ScriptResult>
  validate(code: string): { safe: boolean; issues: string[] }
}
```

### 2.3 注册工具列表

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `create_part` | 创建新零件 | — |
| `create_assembly` | 创建新装配体 | — |
| `create_drawing` | 创建新工程图 | template?: string |
| `create_sketch` | 创建草图 | plane: Front/Top/Right |
| `close_sketch` | 关闭当前草图 | — |
| `draw_rectangle` | 画矩形 | x, y, width, height (mm) |
| `draw_circle` | 画圆 | x, y, radius (mm) |
| `draw_line` | 画线段 | x1, y1, x2, y2 (mm) |
| `extrude_feature` | 拉伸特征 | depth (mm), direction?: both |
| `cut_extrude` | 切除拉伸 | depth (mm) |
| `create_revolve` | 旋转特征 | angle (degrees) |
| `create_fillet` | 倒圆角 | radius (mm) |
| `create_chamfer` | 倒斜角 | distance (mm) |
| `create_pattern` | 线性阵列 | count, spacing (mm), direction |
| `mirror_feature` | 镜像特征 | plane: Front/Top/Right |
| `insert_component` | 插入组件 | filePath |
| `add_mate` | 添加配合 | type: coincident/parallel/... |
| `modify_dimensions` | 修改尺寸 | featureName, dimName, value |
| `export_step` | 导出 STEP | outputPath |
| `export_pdf` | 导出 PDF | outputPath |
| `export_stl` | 导出 STL | outputPath, quality? |
| `export_dxf` | 导出 DXF | outputPath |
| `batch_rename` | 批量重命名 | pattern, replacement |
| `check_interference` | 干涉检查 | — |
| `mass_properties` | 质量属性 | — |
| `bom_export` | BOM 导出 | outputPath, format: xlsx/csv |

---

## 3. SolidWorks COM API 速查

### 3.1 连接与文档

```vba
' 获取 SolidWorks 应用
Dim swApp As SldWorks.SldWorks
Set swApp = Application.SldWorks

' 获取活动文档
Dim swModel As ModelDoc2
Set swModel = swApp.ActiveDoc

' 新建零件
Dim templatePath As String
templatePath = swApp.GetUserPreferenceStringValue(swUserPreferenceStringValue_e.swDefaultTemplatePart)
Set swModel = swApp.NewDocument(templatePath, 0, 0, 0)

' 打开文件
Dim errors As Long, warnings As Long
Set swModel = swApp.OpenDoc6("C:\parts\bracket.sldprt", swDocPART, swOpenDocOptions_Silent, "", errors, warnings)

' 保存
swModel.Save3 swSaveAsOptions_Silent, errors, warnings

' 另存为 STEP
swModel.Extension.SaveAs "C:\output\part.step", swSaveAsCurrentVersion, swSaveAsOptions_Silent, Nothing, errors, warnings
```

### 3.2 草图操作

```vba
' 选择基准面
swModel.Extension.SelectByID2 "Front Plane", "PLANE", 0, 0, 0, False, 0, Nothing, 0

' 进入草图编辑
swModel.SketchManager.InsertSketch True

' 画矩形 (米为单位)
swModel.SketchManager.CreateCornerRectangle -0.025, 0.015, 0, 0.025, -0.015, 0

' 画圆
swModel.SketchManager.CreateCircle 0, 0, 0, 0.01, 0, 0

' 画线
swModel.SketchManager.CreateLine 0, 0, 0, 0.05, 0.03, 0

' 退出草图
swModel.SketchManager.InsertSketch True
```

### 3.3 特征操作

```vba
' 拉伸 (凸台)
swModel.FeatureManager.FeatureExtrusion3 _
    True, False, False, _           ' 单方向, 非切除
    0, 0, _                         ' 终止条件: 给定深度
    0.02, 0, _                      ' 深度 20mm
    False, False, False, False, _
    0, 0, False, False, False, False, _
    True, True, True, 0, 0, False

' 切除拉伸
swModel.FeatureManager.FeatureCut4 _
    True, False, False, _
    0, 0, _
    0.01, 0, _                      ' 切除深度 10mm
    False, False, False, False, _
    0, 0, False, False, False, False, _
    True, True, True, True, _
    0, 0, False

' 倒圆角 (先选择边)
swModel.Extension.SelectByID2 "", "EDGE", 0.025, 0.015, 0.02, False, 1, Nothing, 0
swModel.FeatureManager.FeatureFillet3 195, 0.003, 0, 0, 0, 0, 0  ' 3mm 圆角

' 旋转特征
swModel.FeatureManager.FeatureRevolve2 True, True, False, False, False, False, _
    0, 0, 6.28318530718, 0, False, False, 0, 0, 0, 0, 0, True, True, True
```

### 3.4 尺寸修改

```vba
' 修改尺寸
Dim swDim As Dimension
Set swDim = swModel.Parameter("D1@Boss-Extrude1")
swDim.SetSystemValue3 0.03, swSetValue_InAllConfigurations, Nothing  ' 改为 30mm

' 遍历所有尺寸
Dim swFeat As Feature
Set swFeat = swModel.FirstFeature
Do While Not swFeat Is Nothing
    Dim swDispDim As DisplayDimension
    Set swDispDim = swFeat.GetFirstDisplayDimension
    Do While Not swDispDim Is Nothing
        Dim swDimObj As Dimension
        Set swDimObj = swDispDim.GetDimension2(0)
        Debug.Print swDimObj.FullName & " = " & swDimObj.GetSystemValue3(1, Nothing) * 1000 & " mm"
        Set swDispDim = swFeat.GetNextDisplayDimension(swDispDim)
    Loop
    Set swFeat = swFeat.GetNextFeature
Loop
```

### 3.5 装配体操作

```vba
' 获取装配体文档
Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

' 插入组件
Dim swComponent As Component2
Set swComponent = swAssembly.AddComponent5( _
    "C:\parts\bolt_m6.sldprt", _
    swAddComponentConfigOptions_CurrentSelectedConfig, _
    "", False, "", 0, 0, 0)

' 添加配合 (重合)
swModel.Extension.SelectByID2 "Face1@Part1-1", "FACE", 0, 0, 0, False, 1, Nothing, 0
swModel.Extension.SelectByID2 "Face1@Part2-1", "FACE", 0, 0, 0, True, 1, Nothing, 0
swAssembly.AddMate5 swMateCOINCIDENT, swMateAlignALIGNED, False, 0, 0, 0, 0, 0, 0, 0, 0, False, False, 0, errors
```

### 3.6 工程图操作

```vba
' 获取工程图文档
Dim swDrawing As DrawingDoc
Set swDrawing = swModel

' 创建视图
swDrawing.CreateDrawViewFromModelView3 _
    "C:\parts\bracket.sldprt", "*Front", _
    0.15, 0.15, 0  ' 位置 (米)

' 添加尺寸标注
swDrawing.InsertModelAnnotations3 0, 32776, True, True, False, True
```

### 3.7 Python (win32com) 等效写法

```python
import win32com.client

# 连接
sw = win32com.client.Dispatch("SldWorks.Application")
sw.Visible = True

# 活动文档
model = sw.ActiveDoc

# 新建零件
template = sw.GetUserPreferenceStringValue(21)  # swDefaultTemplatePart
model = sw.NewDocument(template, 0, 0, 0)

# 草图
model.Extension.SelectByID2("Front Plane", "PLANE", 0, 0, 0, False, 0, None, 0)
model.SketchManager.InsertSketch(True)
model.SketchManager.CreateCornerRectangle(-0.025, 0.015, 0, 0.025, -0.015, 0)
model.SketchManager.InsertSketch(True)

# 拉伸
model.FeatureManager.FeatureExtrusion3(
    True, False, False, 0, 0,
    0.02, 0,  # 20mm
    False, False, False, False,
    0, 0, False, False, False, False,
    True, True, True, 0, 0, False
)

# 导出
errors, warnings = 0, 0
model.Extension.SaveAs2(
    r"C:\output\part.step", 0, 1, None, "", False, errors, warnings
)
```

---

## 4. IPC 通信协议

Electron 主进程与渲染进程通过 IPC 通信：

| 频道 | 方向 | 数据 | 说明 |
|------|------|------|------|
| `sw:connect` | R→M | — | 请求连接 SolidWorks |
| `sw:status` | M→R | { connected, version } | 连接状态 |
| `sw:heartbeat` | M→R | boolean | 心跳检测结果 |
| `llm:chat` | R→M | { messages, config } | 发送对话 |
| `llm:stream` | M→R | { chunk, done } | 流式返回 |
| `llm:error` | M→R | { message, code } | 错误信息 |
| `script:run` | R→M | { code, lang } | 执行脚本 |
| `script:result` | M→R | ScriptResult | 执行结果 |
| `config:save` | R→M | LLMConfig | 保存配置 |
| `config:load` | M→R | LLMConfig | 加载配置 |

---

## 5. 错误码参考

| 错误码 | 说明 | 处理方式 |
|--------|------|----------|
| `SW_NOT_FOUND` | SolidWorks 未运行 | 提示用户启动 SW |
| `SW_NO_DOCUMENT` | 没有打开的文档 | 提示用户打开文件 |
| `SW_COM_ERROR` | COM 调用失败 | 重试或检查 SW 版本 |
| `LLM_AUTH_FAILED` | API 认证失败 | 检查 API Key |
| `LLM_RATE_LIMIT` | API 限流 | 等待后重试 |
| `LLM_NETWORK_ERROR` | 网络连接失败 | 检查网络/代理 |
| `SCRIPT_UNSAFE` | 脚本安全校验未通过 | 显示具体风险项 |
| `SCRIPT_EXEC_FAILED` | 脚本执行出错 | 显示错误详情 |
| `SCRIPT_TIMEOUT` | 脚本执行超时 | 终止并提示 |
