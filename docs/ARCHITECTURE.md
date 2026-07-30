# Millwright — Technical Design Document

> SolidWorks AI automation assistant · Technical specification v0.2 · 2026-04-29

---

## 1. Project Overview

### 1.1 Product Positioning

Millwright is an open-source SolidWorks AI automation assistant. Users describe operations in natural language, and the AI automatically generates and executes SolidWorks macro scripts. Unlike commercial solutions such as MecAgent, Millwright lets users freely choose their AI backend (Anthropic / OpenAI / Bailian / MiniMax / DeepSeek, etc.) — no vendor lock-in.

### 1.2 Core Capabilities

- Natural-language-driven SolidWorks automation
- Supports the Anthropic protocol and the OpenAI-compatible protocol, so any large model can be plugged in
- Drives SolidWorks directly through the COM interface — no plugin installation required
- Dual-mode generation: VBA macros and Python scripts
- Built-in library of common automation templates
- Light/dark dual-theme UI

### 1.3 Tech Stack Overview

| Layer | Choice | Notes |
|------|----------|------|
| Desktop framework | Electron 28+ | Broad Windows version compatibility |
| Frontend | React 18 + TypeScript | Chat UI, settings panel |
| Backend logic | Node.js (Main Process) | API calls, script management |
| COM bridge | cscript.exe + VBScript | Zero native dependencies to reach the SolidWorks COM API |
| AI integration | Native fetch + hand-written SSE | Dual protocol support, no SDK dependency |
| Packaging | electron-builder + Squirrel | Auto-update |
| Script execution | cscript/VBS > Python > COM RunMacro2 | Three-level fallback chain |

---

## 2. System Architecture

### 2.1 Overall Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
│  ┌─────────────────┐    ┌────────────────────────────┐  │
│  │   Renderer       │    │   Main Process             │  │
│  │   (React UI)     │◄──►│                            │  │
│  │                  │IPC │  ┌──────────────────────┐  │  │
│  │  • Chat UI       │    │  │  LLM Service          │  │  │
│  │  • Settings      │    │  │  • Anthropic client   │  │  │
│  │  • Templates     │    │  │  • OpenAI client      │  │  │
│  │  • Tool status   │    │  │  • Build & streaming  │  │  │
│  │                  │    │  └──────────┬───────────┘  │  │
│  └─────────────────┘    │             │              │  │
│                          │  ┌──────────▼───────────┐  │  │
│                          │  │  Script Engine        │  │  │
│                          │  │  • VBA macro gen       │  │  │
│                          │  │  • Python script gen   │  │  │
│                          │  │  • Safety & sandbox    │  │  │
│                          │  └──────────┬───────────┘  │  │
│                          │             │              │  │
│                          │  ┌──────────▼───────────┐  │  │
│                          │  │  COM Bridge           │  │  │
│                          │  │  • SolidWorks conn    │  │  │
│                          │  │  • Macro injection    │  │  │
│                          │  │  • Health monitor     │  │  │
│                          │  └──────────┬───────────┘  │  │
│                          └─────────────┼──────────────┘  │
└────────────────────────────────────────┼────────────────┘
                                         │ COM / win32com
                              ┌──────────▼───────────┐
                              │    SolidWorks         │
                              │    (running instance) │
                              └──────────────────────┘
```

### 2.2 Core Module Notes

#### LLM Service

Talks to the model APIs. Supports two protocols:

- **Anthropic protocol**: hand-written `fetch` + SSE streaming parser, supports the full Claude lineup.
- **OpenAI-compatible protocol**: hand-written `fetch` + SSE streaming parser, supports GPT, Bailian, MiniMax, DeepSeek, Qwen, and any other OpenAI-format service.

Key design: zero SDK dependency. Switching protocols is a matter of changing `baseURL`, `apiKey`, and `model` — no app restart required.

#### Script Engine

Converts AI output into executable scripts:

- Parses code blocks (VBA / Python) out of the AI response.
- Runs safety validation (no file deletion, registry editing, and similar dangerous operations).
- Supports script saving, reuse, and parameterized templates.

#### COM Bridge

Manages the connection to SolidWorks:

- Auto-discovers the running SolidWorks instance via the `SldWorks.Application` ProgID.
- Wraps common operations as tool functions (create part, extrude, fillet, etc.).
- Heartbeat monitoring periodically verifies SolidWorks is still running.

---

## 3. AI Interface Design

### 3.1 Dual-Protocol Adapter

```typescript
// src/main/llm/adapter.ts

interface LLMConfig {
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
}

interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

class LLMAdapter {
  private config: LLMConfig;

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    if (this.config.protocol === 'anthropic') {
      return this.callAnthropic(messages);
    } else {
      return this.callOpenAI(messages);
    }
  }

  private async callAnthropic(messages: LLMMessage[]): Promise<LLMResponse> {
    const response = await fetch(`${this.config.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        system: this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        messages: messages.filter(m => m.role !== 'system'),
      }),
    });
    const data = await response.json();
    return this.parseAnthropicResponse(data);
  }

  private async callOpenAI(messages: LLMMessage[]): Promise<LLMResponse> {
    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
          ...messages,
        ],
      }),
    });
    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }
}
```

### 3.2 System Prompt Design

```typescript
const DEFAULT_SYSTEM_PROMPT = `You are a SolidWorks automation specialist.

## Your Capabilities
- Generate SolidWorks VBA macros
- Generate Python + win32com automation scripts
- Understand natural-language CAD-operation requests
- Invoke the SolidWorks API for modeling, modification, and export operations

## Output Rules
- Wrap code in \`\`\`vba or \`\`\`python fences
- Every script must include error handling
- Explain what the script will do before executing
- Require explicit confirmation for dangerous operations (deleting features, overwriting files)

## SolidWorks API Notes
- Connect over COM: SldWorks.Application
- Active document: swApp.ActiveDoc
- Feature traversal: ModelDoc2.FirstFeature → Feature.GetNextFeature
- Select entities: ModelDoc2.Extension.SelectByID2
- Modify dimensions: Dimension.SetSystemValue3

## Safety Rules
- Never generate code that deletes files or edits the registry
- Never access the network or run system commands
- All file operations must stay within the user-specified directory
`;
```

### 3.3 Sample Provider Configuration

| Provider | Protocol | Base URL | Example model |
|---------|----------|----------|----------|
| Anthropic | anthropic | https://api.anthropic.com | claude-sonnet-4-20250514 |
| OpenAI | openai | https://api.openai.com/v1 | gpt-4o |
| Bailian | openai | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-coder-plus |
| MiniMax | openai | https://api.minimax.chat/v1 | MiniMax-Text-01 |
| DeepSeek | openai | https://api.deepseek.com | deepseek-chat |
| SiliconFlow | openai | https://api.siliconflow.cn/v1 | deepseek-ai/DeepSeek-V3 |
| Ollama (local) | openai | http://localhost:11434/v1 | qwen2.5-coder:32b |

---

## 4. COM Bridge Layer

### 4.1 SolidWorks Connection Management

```typescript
// src/main/com/sw-bridge.ts

class SolidWorksBridge {
  // Connects to SolidWorks by executing VBScript through cscript.exe
  // GetObject → CreateObject automatic fallback
  // VBS files use UTF-16LE+BOM encoding (for CJK compatibility)
  async connect(): Promise<boolean> {
    // Run a probe VBS script; connect via GetObject(, "SldWorks.Application")
    // No native modules such as winax required
  }

  isConnected(): boolean {
    if (!this.swApp) return false;
    try {
      // Heartbeat: try to read the version number
      const version = this.swApp.RevisionNumber();
      return !!version;
    } catch {
      this.connected = false;
      return false;
    }
  }

  getActiveDocument(): any {
    return this.swApp?.ActiveDoc;
  }

  async runVBAMacro(code: string): Promise<{ success: boolean; output: string }> {
    // Write a temporary .swp file and execute it
    const tempPath = path.join(os.tmpdir(), `sw_macro_${Date.now()}.swp`);
    fs.writeFileSync(tempPath, code);
    try {
      const result = this.swApp.RunMacro2(tempPath, '', 'main', 1, 0);
      return { success: result === 0, output: '' };
    } finally {
      fs.unlinkSync(tempPath);
    }
  }

  async runPythonScript(code: string): Promise<{ success: boolean; output: string }> {
    const tempPath = path.join(os.tmpdir(), `sw_script_${Date.now()}.py`);
    fs.writeFileSync(tempPath, code);
    return new Promise((resolve) => {
      exec(`python "${tempPath}"`, (error, stdout, stderr) => {
        fs.unlinkSync(tempPath);
        resolve({
          success: !error,
          output: stdout || stderr,
        });
      });
    });
  }
}
```

### 4.2 Tool Function Registration

```typescript
// Tools exposed to the AI
const SW_TOOLS = [
  {
    name: 'create_part',
    description: 'Create a new SolidWorks part document',
    parameters: {},
    execute: async (bridge: SolidWorksBridge) => {
      return bridge.swApp.NewDocument(
        bridge.swApp.GetUserPreferenceStringValue(21), // default part template
        0, 0, 0
      );
    },
  },
  {
    name: 'create_sketch',
    description: 'Create a sketch on the specified plane',
    parameters: { plane: 'Front | Top | Right' },
    execute: async (bridge: SolidWorksBridge, params: any) => {
      const doc = bridge.getActiveDocument();
      const planeMap = { Front: 'Front Plane', Top: 'Top Plane', Right: 'Right Plane' };
      doc.Extension.SelectByID2(planeMap[params.plane], 'PLANE', 0, 0, 0, false, 0, null, 0);
      doc.SketchManager.InsertSketch(true);
    },
  },
  {
    name: 'extrude_feature',
    description: 'Extrude the active sketch into a solid feature',
    parameters: { depth: 'number (mm)' },
    execute: async (bridge: SolidWorksBridge, params: any) => {
      const doc = bridge.getActiveDocument();
      doc.FeatureManager.FeatureExtrusion3(
        true, false, false, 0, 0,
        params.depth / 1000, 0,  // convert to meters
        false, false, false, false,
        0, 0, false, false, false, false,
        true, true, true, 0, 0, false
      );
    },
  },
  // ... more tool definitions
];
```

---

## 5. Security Mechanisms

### 5.1 Script Sandbox

Every AI-generated script is validated before execution:

```typescript
class ScriptSanitizer {
  private BLOCKED_PATTERNS = [
    /kill|taskkill|shutdown/i,           // Process termination
    /del\s|rmdir|remove-item/i,          // File deletion
    /reg\s+add|reg\s+delete/i,           // Registry edits
    /net\s+user|net\s+localgroup/i,      // User management
    /invoke-webrequest|curl|wget/i,      // Network requests
    /set-executionpolicy/i,              // Execution policy
    /format\s+[a-z]:/i,                  // Disk format
  ];

  validate(code: string): { safe: boolean; issues: string[] } {
    const issues: string[] = [];
    for (const pattern of this.BLOCKED_PATTERNS) {
      if (pattern.test(code)) {
        issues.push(`Potentially dangerous operation detected: ${pattern.source}`);
      }
    }
    return { safe: issues.length === 0, issues };
  }
}
```

### 5.2 User Confirmation

- Every generated script is shown to the user for preview before execution.
- Destructive operations (geometry modification, feature deletion, etc.) require a second confirmation.
- Batch operations display an impact scope estimate.

### 5.3 Data Privacy

- API keys are stored in the local `electron-store` with encryption.
- No CAD files are uploaded to any external server.
- Only text descriptions are sent to the AI — never model data.

---

## 6. Project Structure

```
Millwright/
├── package.json
├── electron-builder.yml          # Packaging config
├── tsconfig.json
├── src/
│   ├── main/                     # Electron main process
│   │   ├── index.ts              # Application entry
│   │   ├── ipc.ts                # IPC handler
│   │   ├── llm/
│   │   │   ├── adapter.ts        # Dual-protocol LLM adapter
│   │   │   ├── anthropic.ts      # Anthropic client
│   │   │   ├── openai.ts         # OpenAI-compatible client
│   │   │   └── prompts.ts        # System prompt
│   │   ├── com/
│   │   │   ├── sw-bridge.ts      # SolidWorks COM bridge
│   │   │   ├── tools.ts          # Tool function registry
│   │   │   └── health.ts         # Connection heartbeat
│   │   ├── scripts/
│   │   │   ├── engine.ts         # Script execution engine
│   │   │   ├── sanitizer.ts      # Safety check
│   │   │   └── templates/        # Prebuilt automation templates
│   │   │       ├── batch-fillet.vba
│   │   │       ├── export-pdf.py
│   │   │       ├── batch-rename.vba
│   │   │       └── bom-export.py
│   │   └── store/
│   │       └── config.ts         # Persistent config (encrypted)
│   ├── renderer/                 # Electron renderer process
│   │   ├── App.tsx               # Application root
│   │   ├── components/
│   │   │   ├── Chat.tsx          # Chat interface
│   │   │   ├── Settings.tsx      # Settings panel
│   │   │   ├── Automations.tsx   # Automation templates
│   │   │   ├── ToolsList.tsx     # Tool list
│   │   │   └── StatusBar.tsx     # Status bar
│   │   ├── hooks/
│   │   │   ├── useTheme.ts       # Theme management
│   │   │   └── useLLM.ts         # AI call hook
│   │   └── themes/
│   │       ├── light.ts          # Light theme
│   │       └── dark.ts           # Dark theme
│   └── shared/
│       └── types.ts              # Shared type definitions
├── assets/
│   ├── icon.ico                  # Application icon
│   └── icon.png
├── scripts/
│   └── notarize.js               # macOS notarization (if needed)
└── docs/
    ├── ARCHITECTURE.md           # This document
    ├── USER-GUIDE.md             # User manual
    ├── API-REFERENCE.md          # API reference
    └── CONTRIBUTING.md           # Contributing guide
```

---

## 7. Build & Distribution

### 7.1 Dev Environment Setup

```bash
# Prerequisites
node >= 20.0.0
npm >= 10.0.0
python >= 3.10
SolidWorks 2017+ (installed and run at least once)

# Initialize the project
git clone https://github.com/raylanlin/Millwright.git
cd Millwright
npm install
npm run dev          # Start dev mode (hot reload)
```

### 7.2 Packaging Config

```yaml
# electron-builder.yml
appId: com.swcopilot.app
productName: Millwright
win:
  target:
    - target: nsis
      arch: [x64]
    - target: squirrel
  icon: assets/icon.ico
squirrelWindows:
  iconUrl: https://your-cdn.com/icon.ico
nsis:
  oneClick: true
  allowToChangeInstallationDirectory: false
publish:
  provider: github
  owner: raylanlin
  repo: Millwright
```

### 7.3 Build Commands

```bash
npm run build         # Compile TypeScript
npm run pack          # Package as executable
npm run dist          # Generate installers + auto-update artifacts
```

Outputs:
- `Millwright Setup x.x.x.exe` (NSIS installer)
- `Millwright-x.x.x-full.nupkg` (Squirrel update package, used before v0.2.0)
- `RELEASES` (version index)

Mirrors MecAgent's packaging structure.

---

## 8. Development Roadmap

- [x] **v0.1.0** — MVP foundation (Electron + LLM + COM + 26 tools)
- [x] **v0.2.0** — Stable release (bug fixes + CI/CD + .env fallback + docs polish)
- [x] **v0.2.1** — Permanent fix for fake-success bug (remove CreateObject fallback + vbaToVbs rewrite)
- [x] **v0.2.2** — Renderer fixes (IPC error normalization + theme tokens + scrolling)
- [x] **v0.2.3** — CI quality gate (PR/push runs typecheck + lint + test) ← *current*
- [ ] **v0.3.0** — Advanced features (visual perception + agent loop + function calling)
- [ ] **v1.0.0** — Ecosystem (MCP server + multi-CAD + commercial licensing)

---

## 9. Technical Comparison with MecAgent

| Dimension | MecAgent | Millwright |
|------|----------|------------|
| Architecture | Electron + proprietary AI | Electron + open AI |
| AI backend | Fixed (per-plan tier) | User-selectable (any model) |
| Protocol | Proprietary | Anthropic + OpenAI standard protocols |
| COM bridge | winax / COM | cscript.exe + VBScript (zero native deps) |
| Safety check | Unknown | Open source, auditable |
| Automation templates | Yes (with community library) | Yes (extensible) |
| Pricing | $16–417/month | Free (users pay their own API fees) |
| Source code | Closed source | Open source (Apache-2.0) |

---

## Appendix A: Key Dependency Versions

```json
{
  "electron": "^28.0.0",
  "react": "^18.2.0",
  "typescript": "^5.3.0",
  // Zero SDK dependency: native fetch + SSE for LLM
  "electron-store": "^8.1.0",
  "electron-builder": "^24.9.0"
}
```

## Appendix B: SolidWorks COM API Cheat Sheet

| Interface | Description | Example |
|------|------|------|
| `SldWorks.Application` | Application entry point | Get/create SW instance |
| `ModelDoc2` | Document object | Part / assembly / drawing |
| `FeatureManager` | Feature manager | Extrude / revolve / pattern |
| `SketchManager` | Sketch manager | Line / circle / rectangle |
| `SelectionMgr` | Selection manager | Get selected entities |
| `DimensionData` | Dimension data | Modify parametric dimensions |
| `AssemblyDoc` | Assembly document | Insert components / mates |
| `DrawingDoc` | Drawing document | Views / annotations / BOM |
| `ModelDocExtension` | Extension methods | Save / export / select |