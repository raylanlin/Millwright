# Millwright — API Reference & SolidWorks COM Cheat Sheet

> Version 1.0 · 2026-04-23

---

## 1. LLM Adapter API

### 1.1 Configuration Interface

```typescript
interface LLMConfig {
  protocol: 'anthropic' | 'openai';  // API protocol
  baseURL: string;                    // Service endpoint
  apiKey: string;                     // Auth key
  model: string;                      // Model identifier
  systemPrompt?: string;              // Custom system prompt
  temperature?: number;               // Sampling temperature (0–1, default 0.3)
  maxTokens?: number;                 // Max output tokens (default 4096)
  stream?: boolean;                   // Stream output (default true)
}
```

### 1.2 Message Format

```typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];             // Tools the AI requested to call
  code?: string;                      // Extracted code block
  codeLanguage?: 'vba' | 'python';   // Code language
}

interface ToolCall {
  name: string;                       // Tool name
  parameters: Record<string, any>;    // Call parameters
  result?: string;                    // Execution result
}
```

### 1.3 Anthropic Protocol Request Format

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "system": "You are a SolidWorks automation assistant...",
  "messages": [
    { "role": "user", "content": "Change every fillet to 3mm" }
  ]
}
```

Headers:

```
Content-Type: application/json
x-api-key: sk-ant-xxxxx
anthropic-version: 2023-06-01
```

### 1.4 OpenAI-Compatible Protocol Request Format

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a SolidWorks automation assistant..." },
    { "role": "user", "content": "Change every fillet to 3mm" }
  ]
}
```

Headers:

```
Content-Type: application/json
Authorization: Bearer sk-xxxxx
```

---

## 2. COM Bridge API

### 2.1 Connection Management

```typescript
class SolidWorksBridge {
  connect(): Promise<boolean>          // Connect to SolidWorks
  disconnect(): void                   // Disconnect
  isConnected(): boolean               // Check connection status
  getVersion(): string                 // Get SW version
  getActiveDocument(): ModelDoc2       // Get the active document
  getDocumentType(): 'part' | 'assembly' | 'drawing' | null
}
```

### 2.2 Script Execution

```typescript
interface ScriptResult {
  success: boolean;
  output: string;        // Standard output
  error?: string;        // Error message
  duration: number;      // Execution duration (ms)
}

class ScriptEngine {
  runVBA(code: string): Promise<ScriptResult>
  runPython(code: string): Promise<ScriptResult>
  validate(code: string): { safe: boolean; issues: string[] }
}
```

### 2.3 Registered Tool List

| Tool | Description | Parameters |
|--------|------|------|
| `create_part` | Create a new part | — |
| `create_assembly` | Create a new assembly | — |
| `create_drawing` | Create a new drawing | template?: string |
| `create_sketch` | Start a sketch | plane: Front/Top/Right |
| `close_sketch` | Close the current sketch | — |
| `draw_rectangle` | Draw a rectangle | x, y, width, height (mm) |
| `draw_circle` | Draw a circle | x, y, radius (mm) |
| `draw_line` | Draw a line segment | x1, y1, x2, y2 (mm) |
| `extrude_feature` | Extrude feature | depth (mm), direction?: both |
| `cut_extrude` | Cut-extrude | depth (mm) |
| `create_revolve` | Revolve feature | angle (degrees) |
| `create_fillet` | Fillet | radius (mm) |
| `create_chamfer` | Chamfer | distance (mm) |
| `create_pattern` | Linear pattern | count, spacing (mm), direction |
| `mirror_feature` | Mirror feature | plane: Front/Top/Right |
| `insert_component` | Insert component | filePath |
| `add_mate` | Add mate | type: coincident/parallel/... |
| `modify_dimensions` | Modify dimension | featureName, dimName, value |
| `export_step` | Export STEP | outputPath |
| `export_pdf` | Export PDF | outputPath |
| `export_stl` | Export STL | outputPath, quality? |
| `export_dxf` | Export DXF | outputPath |
| `batch_rename` | Batch rename | pattern, replacement |
| `check_interference` | Interference check | — |
| `mass_properties` | Mass properties | — |
| `bom_export` | BOM export | outputPath, format: xlsx/csv |

---

## 3. SolidWorks COM API Cheat Sheet

### 3.1 Connection & Documents

```vba
' Get the SolidWorks application
Dim swApp As SldWorks.SldWorks
Set swApp = Application.SldWorks

' Get the active document
Dim swModel As ModelDoc2
Set swModel = swApp.ActiveDoc

' Create a new part
Dim templatePath As String
templatePath = swApp.GetUserPreferenceStringValue(swUserPreferenceStringValue_e.swDefaultTemplatePart)
Set swModel = swApp.NewDocument(templatePath, 0, 0, 0)

' Open a file
Dim errors As Long, warnings As Long
Set swModel = swApp.OpenDoc6("C:\parts\bracket.sldprt", swDocPART, swOpenDocOptions_Silent, "", errors, warnings)

' Save
swModel.Save3 swSaveAsOptions_Silent, errors, warnings

' Save as STEP
swModel.Extension.SaveAs "C:\output\part.step", swSaveAsCurrentVersion, swSaveAsOptions_Silent, Nothing, errors, warnings
```

### 3.2 Sketch Operations

```vba
' Select a reference plane
swModel.Extension.SelectByID2 "Front Plane", "PLANE", 0, 0, 0, False, 0, Nothing, 0

' Enter sketch mode
swModel.SketchManager.InsertSketch True

' Draw a rectangle (in meters)
swModel.SketchManager.CreateCornerRectangle -0.025, 0.015, 0, 0.025, -0.015, 0

' Draw a circle
swModel.SketchManager.CreateCircle 0, 0, 0, 0.01, 0, 0

' Draw a line
swModel.SketchManager.CreateLine 0, 0, 0, 0.05, 0.03, 0

' Exit sketch mode
swModel.SketchManager.InsertSketch True
```

### 3.3 Feature Operations

```vba
' Extrude (boss)
swModel.FeatureManager.FeatureExtrusion3 _
    True, False, False, _           ' Single direction, not a cut
    0, 0, _                         ' End condition: given depth
    0.02, 0, _                      ' Depth 20 mm
    False, False, False, False, _
    0, 0, False, False, False, False, _
    True, True, True, 0, 0, False

' Cut-extrude
swModel.FeatureManager.FeatureCut4 _
    True, False, False, _
    0, 0, _
    0.01, 0, _                      ' Cut depth 10 mm
    False, False, False, False, _
    0, 0, False, False, False, False, _
    True, True, True, True, _
    0, 0, False

' Fillet (first select an edge)
swModel.Extension.SelectByID2 "", "EDGE", 0.025, 0.015, 0.02, False, 1, Nothing, 0
swModel.FeatureManager.FeatureFillet3 195, 0.003, 0, 0, 0, 0, 0  ' 3 mm fillet

' Revolve
swModel.FeatureManager.FeatureRevolve2 True, True, False, False, False, False, _
    0, 0, 6.28318530718, 0, False, False, 0, 0, 0, 0, 0, True, True, True
```

### 3.4 Dimension Modification

```vba
' Modify a dimension
Dim swDim As Dimension
Set swDim = swModel.Parameter("D1@Boss-Extrude1")
swDim.SetSystemValue3 0.03, swSetValue_InAllConfigurations, Nothing  ' Change to 30 mm

' Iterate all dimensions
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

### 3.5 Assembly Operations

```vba
' Get the assembly document
Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

' Insert a component
Dim swComponent As Component2
Set swComponent = swAssembly.AddComponent5( _
    "C:\parts\bolt_m6.sldprt", _
    swAddComponentConfigOptions_CurrentSelectedConfig, _
    "", False, "", 0, 0, 0)

' Add a coincident mate
swModel.Extension.SelectByID2 "Face1@Part1-1", "FACE", 0, 0, 0, False, 1, Nothing, 0
swModel.Extension.SelectByID2 "Face1@Part2-1", "FACE", 0, 0, 0, True, 1, Nothing, 0
swAssembly.AddMate5 swMateCOINCIDENT, swMateAlignALIGNED, False, 0, 0, 0, 0, 0, 0, 0, 0, False, False, 0, errors
```

### 3.6 Drawing Operations

```vba
' Get the drawing document
Dim swDrawing As DrawingDoc
Set swDrawing = swModel

' Create a view
swDrawing.CreateDrawViewFromModelView3 _
    "C:\parts\bracket.sldprt", "*Front", _
    0.15, 0.15, 0  ' Position (m)

' Insert model annotations
swDrawing.InsertModelAnnotations3 0, 32776, True, True, False, True
```

### 3.7 Python (win32com) Equivalent

```python
import win32com.client

# Connect
sw = win32com.client.Dispatch("SldWorks.Application")
sw.Visible = True

# Active document
model = sw.ActiveDoc

# Create a new part
template = sw.GetUserPreferenceStringValue(21)  # swDefaultTemplatePart
model = sw.NewDocument(template, 0, 0, 0)

# Sketch
model.Extension.SelectByID2("Front Plane", "PLANE", 0, 0, 0, False, 0, None, 0)
model.SketchManager.InsertSketch(True)
model.SketchManager.CreateCornerRectangle(-0.025, 0.015, 0, 0.025, -0.015, 0)
model.SketchManager.InsertSketch(True)

# Extrude
model.FeatureManager.FeatureExtrusion3(
    True, False, False, 0, 0,
    0.02, 0,  # 20 mm
    False, False, False, False,
    0, 0, False, False, False, False,
    True, True, True, 0, 0, False
)

# Export
errors, warnings = 0, 0
model.Extension.SaveAs2(
    r"C:\output\part.step", 0, 1, None, "", False, errors, warnings
)
```

---

## 4. IPC Protocol

Electron main and renderer communicate via IPC:

| Channel | Direction | Data | Description |
|------|------|------|------|
| `sw:connect` | R→M | — | Request connection to SolidWorks |
| `sw:status` | M→R | { connected, version } | Connection status |
| `sw:heartbeat` | M→R | boolean | Heartbeat result |
| `llm:chat` | R→M | { messages, config } | Send chat |
| `llm:stream` | M→R | { chunk, done } | Streaming response |
| `llm:error` | M→R | { message, code } | Error info |
| `script:run` | R→M | { code, lang } | Execute script |
| `script:result` | M→R | ScriptResult | Execution result |
| `config:save` | R→M | LLMConfig | Save config |
| `config:load` | M→R | LLMConfig | Load config |

---

## 5. Error Code Reference

| Code | Description | Handling |
|--------|------|----------|
| `SW_NOT_FOUND` | SolidWorks is not running | Tell the user to start SW |
| `SW_NO_DOCUMENT` | No open document | Tell the user to open a file |
| `SW_COM_ERROR` | COM call failed | Retry or check SW version |
| `LLM_AUTH_FAILED` | API auth failed | Check API key |
| `LLM_RATE_LIMIT` | API rate-limited | Wait and retry |
| `LLM_NETWORK_ERROR` | Network error | Check network/proxy |
| `SCRIPT_UNSAFE` | Script failed safety check | Show specific risks |
| `SCRIPT_EXEC_FAILED` | Script execution failed | Show error details |
| `SCRIPT_TIMEOUT` | Script execution timed out | Abort and notify |