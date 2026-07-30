# Developer Guide

> This document is for contributors. It explains Millwright's code structure and development conventions.
> For end-user usage, see [`../README.md`](../README.md) and [`USER-GUIDE.md`](USER-GUIDE.md).

## Project Structure

```
Millwright/
├── package.json
├── tsconfig.json                # References the main/renderer projects
├── tsconfig.main.json           # Main process + preload compilation
├── tsconfig.renderer.json       # Renderer process type checking
├── vite.config.ts               # Renderer bundling
├── electron-builder.yml         # Packaging & distribution
├── src/
│   ├── shared/                  # Shared between main & renderer
│   │   ├── types.ts             #   Interfaces, error codes, message types
│   │   ├── ipc-channels.ts      #   IPC channel constants
│   │   ├── presets.ts           #   Model presets, default URLs
│   │   └── sw-tools.ts          #   SW tool inventory (metadata, shared by both sides)
│   ├── main/                    # Electron main process
│   │   ├── index.ts             #   Application entry, window management
│   │   ├── llm/                 #   LLM dual-protocol adapters
│   │   │   ├── adapter.ts       #     Abstract base class
│   │   │   ├── anthropic.ts     #     Anthropic protocol
│   │   │   ├── openai.ts        #     OpenAI-compatible protocol
│   │   │   ├── sse.ts           #     SSE streaming parser
│   │   │   ├── prompts.ts       #     System prompt
│   │   │   ├── code-extract.ts  #     Code block extraction
│   │   │   ├── errors.ts        #     Error normalization
│   │   │   ├── factory.ts       #     createAdapter()
│   │   │   └── index.ts
│   │   ├── com/                 #   SolidWorks COM bridge
│   │   │   ├── sw-bridge.ts     #     cscript/VBS connection management
│   │   │   ├── health.ts        #     Heartbeat monitoring
│   │   │   └── tools.ts         #     AI-callable tool inventory
│   │   ├── scripts/             #   Script execution
│   │   │   ├── engine.ts        #     VBA / Python executor
│   │   │   ├── sanitizer.ts     #     Safety check
│   │   │   ├── generators/      #     VBA generators (26 SW tools)
│   │   │   │   ├── index.ts     #       Registry + generateScript()
│   │   │   │   ├── vba-helpers.ts #     Unit conversion, string escaping, wrapping
│   │   │   │   ├── document.ts  #       Part / assembly / drawing
│   │   │   │   ├── sketch.ts    #       Sketch + rectangle / circle / line
│   │   │   │   ├── feature.ts   #       Extrude / cut / revolve / fillet / pattern / mirror / dim
│   │   │   │   ├── assembly.ts  #       Components / mates
│   │   │   │   ├── export.ts    #       STEP / PDF / STL / DXF
│   │   │   │   └── batch-query.ts #     Batch rename / interference / mass / BOM
│   │   │   └── templates/       #     Prebuilt parameterized templates (samples)
│   │   ├── store/
│   │   │   └── config.ts        #   Persistent config (safeStorage)
│   │   └── ipc/
│   │       └── handlers.ts      #   Centralized IPC handler registration
│   ├── preload/
│   │   └── index.ts             # contextBridge exposes window.api
│   └── renderer/                # React renderer process
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx              # Pure orchestration: hooks, components, tab routing
│       ├── preload.d.ts         #   window.api type declaration
│       ├── components/          #   Components
│       │   ├── Sidebar.tsx      #     Left rail (status bar + tabs + theme/settings)
│       │   ├── StatusDot.tsx    #     Connection status dot
│       │   ├── Chat.tsx         #     Message list container + auto-scroll
│       │   ├── ChatMessage.tsx  #     Single message bubble (text / code / tool / result)
│       │   ├── ChatInput.tsx    #     Bottom input box (with cancel button)
│       │   ├── SettingsModal.tsx#     Settings panel (real IPC connection test)
│       │   ├── Automations.tsx  #     Quick-template grid
│       │   ├── automations-data.ts # Template data (icon/label/prompt)
│       │   └── ToolsList.tsx    #     Tool list (grouped by category)
│       ├── hooks/
│       │   ├── useLLM.ts        #   Chat state + streaming
│       │   ├── useSWStatus.ts   #   SW connection status subscription
│       │   └── useTheme.ts      #   Theme
│       ├── themes/
│       │   └── index.ts         #   Light / dark tokens
│       └── styles/
│           └── global.css
├── docs/
│   ├── ARCHITECTURE.md          # Design document
│   ├── USER-GUIDE.md            # User manual
│   ├── API-REFERENCE.md         # API reference / COM cheat sheet
│   ├── CONTRIBUTING.md          # Contributing guide
│   ├── UI-PROTOTYPE.jsx         # Early UI prototype (reference)
│   └── DEVELOPMENT.md           # This document
├── tests/                       # node:test unit tests (see Testing section)
│   ├── sse.test.mjs
│   ├── code-extract.test.mjs
│   ├── sanitizer.test.mjs
│   ├── errors.test.mjs
│   ├── factory.test.mjs
│   ├── sw-tools.test.mjs
│   ├── presets.test.mjs
│   ├── vba-helpers.test.mjs
│   └── generators.test.mjs
└── assets/                      # Icons, etc.
```

## Dev Environment

```bash
node >= 20.0.0
npm >= 10.0.0
# Runtime (optional):
python >= 3.10          # Required to execute Python scripts
SolidWorks 2017+        # Required for real-world use; UI dev works without it
```

## Bootstrapping

```bash
npm install
npm run dev
```

`npm run dev` runs three things in parallel:

1. `tsc -w` watches and compiles main-process TS → `dist/main/`
2. The Vite dev server boots the renderer on :5173
3. Once both are ready, Electron launches

## Building

```bash
npm run build      # Compile main + bundle renderer
npm run pack       # Bundle an unsigned exe (test only)
npm run dist       # Generate NSIS installer + Squirrel update package
```

## Environment Variables

Copy `.env.example` to `.env` and fill in what you need. Common dev variables:

| Variable | Description | Default |
|------|------|------|
| `SKIP_SW_CONNECT` | Set to `true` to skip COM connect/heartbeat for pure UI dev | — |
| `DEBUG` | Set to `millwright:*` for verbose logging | — |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` | Anthropic fallback (active when UI is unconfigured) | — |
| `OPENAI_API_KEY` + `OPENAI_MODEL` + `OPENAI_BASE_URL` | OpenAI fallback | — |
| `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL` | DeepSeek fallback | — |
| `DASHSCOPE_API_KEY` + `DASHSCOPE_MODEL` | Alibaba Bailian fallback | — |
| `MINIMAX_API_KEY` + `MINIMAX_MODEL` | MiniMax fallback | — |

**API key priority** (high → low):

1. Value saved in the UI settings panel (`electron-store` + `safeStorage` encryption)
2. The matching variable in `process.env` (shell environment)
3. The project's `.env` file
4. Empty (user must configure in the UI)

Env fallback lives only in memory — it is never written back to `electron-store`. When multiple protocols are configured, the first one in this order is used: Anthropic → OpenAI → DeepSeek → Bailian → MiniMax.

## Module Conventions

### LLM Adapters

- Every new protocol must extend `BaseLLMAdapter` and implement `chat / chatStream / test`.
- Errors are normalized through `toLLMError()` in `errors.ts` into `LLMErrorInfo`. **Never throw raw Error.**
- Streaming is exposed as `AsyncIterable<LLMStreamEvent>` with four events: `start / delta / done / error`.
- Code block extraction is handled centrally by `code-extract.ts`; adapters just pass the full `content` in.

### IPC

- **Channel names must only be imported from `shared/ipc-channels.ts`** — no hard-coded strings.
- The main process always uses `ipcMain.handle` (awaitable); streaming events use `webContents.send`.
- The renderer always calls through `window.api.xxx()` — never `ipcRenderer.invoke` directly (preload is the only boundary).

### COM Bridge

- Connects via `.vbs` scripts executed by `cscript.exe`. No native modules required; cross-platform compatible.
- Every `swApp.xxx()` call must be wrapped in try/catch — SW can be closed by the user at any time.

### Script Execution Paths

`ScriptEngine` calls `detectRuntime()` at startup to pick the most suitable runtime, in priority order:

| Runtime | Trigger | Pros | Cons |
|---------|---------|------|------|
| **cscript** (VBS, default) | Windows | Native, fast, stable; no reliance on SW RunMacro2 GUI callback | Needs VBA→VBS conversion (see below) |
| **python** | Python + pywin32 available | Most flexible, supports complex control flow | Requires the user to install Python |
| **com** (RunMacro2) | The previous two are unavailable | Runs directly inside the SW macro environment | Requires SW connection + correct macro file format |

The **VBA → VBS conversion** in `vba-macro-writer.ts` is the heart of the cscript path. Generators emit standard VBA macros (`Sub main()` + `On Error GoTo`); to execute via cscript we need to:

1. Strip `Option Explicit` / `As <Type>` (VBS is loosely typed)
2. `Application.SldWorks` → `GetObject(, "SldWorks.Application")` (VBS connects from its own process)
3. `On Error GoTo <label>` → `On Error Resume Next` (VBS has no GoTo)
4. **`Exit Sub` → `WScript.Quit 0`** (top-level VBS forbids `Exit Sub`; must replace)
5. Strip the `Sub main() ... End Sub` wrapper (VBS executes top-level code directly)
6. Append a JSON-result footer for `engine.ts` to read back

Any change to `vba-helpers.ts` / `generators/*.ts` must keep the output valid VBS after `vbaToVbs()` — the end-to-end tests in `tests/vba-macro-writer.test.mjs` cover all 26 generators.

### Script Generators

- Each SW tool maps to a function under `scripts/generators/*.ts`; its parameters match `SWToolDefinition.parameters`.
- **Units**: input is always mm / degrees. Generators convert with `mmToM` / `degToRad` from `vba-helpers` into the meters/radians the SolidWorks API expects.
- **String embedding**: paths and user input are escaped through `vbaString()`, which handles the double quotes.
- **Wrapping**: every generator returns its code wrapped by `wrapMain()` into a complete, executable `.swp` (with `Sub main()` + `On Error` handling).
- To add a new tool:
  1. Add a definition in `SW_TOOLS` inside `shared/sw-tools.ts` (name/description/parameters/category/exampleParams)
  2. Add the implementation function under `scripts/generators/<category>.ts`
  3. Map the name → function in `REGISTRY` inside `scripts/generators/index.ts`
  4. The "registry covers all SW_TOOLS" test in `generators.test.mjs` will pick it up automatically

### Config Persistence

- API keys must be encrypted with `safeStorage` before storage.
- Other fields go into `electron-store` directly.

## Testing

Uses Node's built-in `node:test` (no external dependencies). Test files live under `tests/*.test.mjs` and read compiled JS from `dist/`.

```bash
npm run build:main    # Compile the main process first
npm test              # Run all tests
# Or run just one:
node --test tests/sse.test.mjs
```

Current test coverage:

| File | Module | Cases |
|------|------|--------|
| `tests/sse.test.mjs` | SSE parser (chunk boundaries, CRLF, comments, multi-line data) | 8 |
| `tests/code-extract.test.mjs` | Code block extraction (fenced, heuristic, multi-block) | 12 |
| `tests/sanitizer.test.mjs` | Safety check (VBA/Python blacklists, language isolation, dedup) | 12 |
| `tests/errors.test.mjs` | Error normalization (status-code mapping, AbortError, network) | 18 |
| `tests/factory.test.mjs` | Adapter factory + config validation | 8 |
| `tests/sw-tools.test.mjs` | SW tool inventory invariants (unique names, categories, grouping) | 9 |
| `tests/presets.test.mjs` | Preset data consistency (URLs, DEFAULT_CONFIG, OpenAI-compat) | 8 |
| `tests/vba-helpers.test.mjs` | VBA generation helpers (unit conversion, string escape, wrapping, CJK plane names) | 24 |
| `tests/generators.test.mjs` | Generators for 26 SW tools (completeness + parameters + units + CJK fallback) | 21 |
| `tests/vba-macro-writer.test.mjs` | VBA→VBS conversion (7 rules + end-to-end + VBS static validity) | 21 |
| `tests/env-fallback.test.mjs` | .env parsing + protocol mapping fallback | 20 |
| **Total** | | **161** |

Planned for Phase 2:
- Adapter integration tests (via MSW or a local mock server)
- End-to-end `sw-bridge` tests on Windows
- `engine` execution tests (need a mocked `swApp` + Python executable)