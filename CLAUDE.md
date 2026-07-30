# Millwright — Project Conventions (CLAUDE.md)

> Read automatically by Claude Code / AI coding assistants and referenced as the team's engineering conventions.

## Project Overview

Millwright is an open-source SolidWorks AI automation assistant. Users describe operations in natural language; the AI generates VBA/Python scripts and injects them into SolidWorks through the COM interface. Supports the Anthropic and OpenAI-compatible protocols, so any large model can be plugged in.

- **Tech stack**: Electron 28 + React 18 + TypeScript 5.3 + cscript/VBS (COM) + native fetch/SSE
- **Runtime**: Windows 10/11 (64-bit), SolidWorks 2017+, Node.js 20+
- **Package manager**: npm

## Architecture at a Glance

```
Renderer (React)  ←IPC→  Main Process (Node.js)  ←COM/cscript→  SolidWorks
```

Three-process model:

- **Main** (`src/main/`): LLM calls, script generation/execution, COM bridge, config persistence
- **Preload** (`src/preload/`): contextBridge security boundary exposing `window.api`
- **Renderer** (`src/renderer/`): React UI, pure orchestration layer

## Directory Layout

```
src/
├── shared/                  # Shared between main and renderer (types, constants, presets)
│   ├── types.ts             #   All interfaces & types
│   ├── ipc-channels.ts      #   IPC channel constants (single source of truth)
│   ├── presets.ts           #   Model presets & DEFAULT_CONFIG
│   └── sw-tools.ts          #   26 SW tool definitions (metadata)
├── main/
│   ├── index.ts             #   Application entry, window management
│   ├── ipc/handlers.ts      #   Centralized IPC handler registration
│   ├── llm/                 #   LLM dual-protocol adapters
│   │   ├── adapter.ts       #     BaseLLMAdapter abstract base class
│   │   ├── anthropic.ts     #     Anthropic protocol implementation
│   │   ├── openai.ts        #     OpenAI-compatible protocol implementation
│   │   ├── sse.ts           #     Hand-written SSE streaming parser
│   │   ├── factory.ts       #     createAdapter() factory
│   │   ├── code-extract.ts  #     Code block extraction
│   │   ├── context-window.ts#     Token estimation & message truncation
│   │   ├── errors.ts        #     Error normalization → LLMErrorInfo
│   │   └── prompts.ts       #     System prompts (dynamic context stitching)
│   ├── com/                 #   SolidWorks COM bridge
│   │   ├── sw-bridge.ts     #     cscript/VBS connection management (not winax)
│   │   ├── health.ts        #     Heartbeat monitoring
│   │   ├── context-collector.ts #  Document context collection
│   │   ├── tools.ts         #     Tool metadata export
│   │   └── vbs-writer.ts    #     VBS file writer (UTF-16LE+BOM)
│   ├── scripts/
│   │   ├── engine.ts        #     Script execution engine (cscript > python > com)
│   │   ├── sanitizer.ts     #     Safety check (per-language blacklists for VBA/Python)
│   │   ├── backup.ts        #     Auto-backup before execution
│   │   ├── vba-macro-writer.ts #  VBA → VBS 10-step conversion
│   │   ├── generators/      #     VBA generators for 26 SW tools
│   │   │   ├── index.ts     #       Registry + generateScript() + checkCoverage()
│   │   │   ├── vba-helpers.ts #     mmToM / degToRad / vbaString / wrapMain / selectPlane
│   │   │   ├── sketch.ts    #       Sketches
│   │   │   ├── feature.ts   #       Features (extrude/cut/revolve/fillet/pattern/mirror/dimension)
│   │   │   ├── document.ts  #       Document operations
│   │   │   ├── assembly.ts  #       Assemblies
│   │   │   ├── export.ts    #       Export
│   │   │   └── batch-query.ts #     Batch queries
│   │   └── templates/       #     Prebuilt script templates
│   └── store/
│       ├── config.ts        #     Config persistence (safeStorage-encrypted API key)
│       ├── chat-store.ts    #     Chat history CRUD
│       └── env-fallback.ts  #     .env parsing + protocol mapping
├── preload/
│   └── index.ts             #   contextBridge exposes window.api
└── renderer/
    ├── App.tsx              #   Pure orchestration layer
    ├── components/          #   UI components
    ├── hooks/               #   useLLM / useSWStatus / useTheme
    ├── themes/              #   Light/dark token sets
    └── styles/
```

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev mode (parallel tsc -w + vite + electron)
npm run build        # Compile main + preload + renderer
npm run dist         # Build NSIS installer
npm test             # Run all tests (node:test, requires build:main first)
npm run lint         # ESLint check
npm run format       # Prettier formatting
```

## Core Development Conventions

### IPC

- **Channel names must only be imported from `shared/ipc-channels.ts`**, never hard-coded as strings.
- The main process uses `ipcMain.handle` (awaitable); streaming events use `webContents.send`.
- The renderer only calls `window.api.xxx()`, never `ipcRenderer` directly.

### LLM Adapters

- New protocols must extend `BaseLLMAdapter` and implement `chat / chatStream / test`.
- Errors are normalized through `toLLMError()`; **never throw raw Error**.
- Streaming is exposed as `AsyncIterable<LLMStreamEvent>`: `start | delta | done | error`.
- Zero SDK dependency: native `fetch` + hand-written SSE parser.

### COM Bridge

- Connects to SolidWorks by executing VBScript through `cscript.exe` (not winax).
- VBS files must be UTF-16LE with BOM (for CJK compatibility).
- `GetObject` → `CreateObject` automatic fallback.
- Every `swApp` call must be wrapped in try/catch — SW can be closed at any time.

### Script Generators

- Each SW tool maps to a function in `generators/*.ts`.
- **Units**: input is always mm/degrees; generators convert with `mmToM` / `degToRad`.
- **Strings**: user input is escaped with `vbaString()`.
- **Wrapping**: `wrapMain()` produces a full executable macro.
- **Reference planes**: `selectPlane()` handles both Chinese and English SolidWorks.

### VBA → VBS Conversion (`vba-macro-writer.ts`)

Ten rules (any change to generators must keep the output valid VBS):

1. Strip `Option Explicit` / `As <Type>`
2. `Application.SldWorks` → `GetObject(, "SldWorks.Application")`
3. `On Error GoTo <label>` → `On Error Resume Next`
4. `Exit Sub` → `WScript.Quit 0`
5. Strip the `Sub main() ... End Sub` wrapper

### Full Steps for Adding a New SW Tool

1. Add the definition to `SW_TOOLS` in `shared/sw-tools.ts`.
2. Add the implementation function under `scripts/generators/<category>.ts`.
3. Map it in the `REGISTRY` in `scripts/generators/index.ts`.
4. Tests are auto-covered (`generators.test.mjs` checks every tool).

### Config Persistence

- API keys must be encrypted with `safeStorage` before being stored in `electron-store`.
- Other fields go straight into `electron-store`.
- `.env` variables are fallback only — never written back into the store.

### UI Conventions

- All colors reference the theme object `t`; no hard-coded values.
- Functional components + Hooks only.
- File names `kebab-case`, variables `camelCase`, types `PascalCase`.

## Testing

Uses `node:test` (no external dependencies). Test files live under `tests/*.test.mjs` and read from the `dist/` build output.

```bash
npm run build:main && npm test
```

Currently 161 test cases covering: SSE parsing, code extraction, safety check, error normalization, adapter factory, SW tool inventory, presets, VBA helpers, 26 generators, VBA→VBS conversion, env fallback.

## Environment Variables

See `.env.example`. Set `SKIP_SW_CONNECT=true` during development to skip the COM connection for pure UI work.

API key priority: UI Settings > process.env > `.env` file > empty.

## Git Conventions

- Branches: `feat/xxx`, `fix/xxx`, `docs/xxx`, `chore/xxx`
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/)
- CHANGELOG: [Keep a Changelog](https://keepachangelog.com/)
- Versioning: [Semantic Versioning](https://semver.org/)

## Security Red Lines

- Never upload any CAD files to the outside world.
- Only text is sent to the AI — never model data.
- All scripts must pass `sanitizer.ts` before execution.
- The active document is auto-backed up before execution.