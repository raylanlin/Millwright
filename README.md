<p align="center">
  <img src="assets/banner-hero.png" alt="Millwright — Let AI operate SolidWorks, not just write code" />
</p>

<p align="center">
  <img src="assets/icon-512.png" width="96" height="96" alt="Millwright" />
</p>

<h1 align="center">Millwright</h1>

<p align="center">
  <strong>Let AI operate SolidWorks — not generate macros.</strong>
</p>

<p align="center">
  The open-source AI workbench that directly drives SolidWorks through native tool calling,<br/>
  structured reasoning, and a real visual feedback loop.
</p>

<p align="center">
  <a href="#why-millwright">Why Millwright</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#supported-ai-providers">AI providers</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/CONTRIBUTING.md">Contributing</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.37-blue" alt="version" />
  <img src="https://img.shields.io/badge/electron-28-47848F?logo=electron" alt="electron" />
  <img src="https://img.shields.io/badge/react-18-61DAFB?logo=react" alt="react" />
  <img src="https://img.shields.io/badge/typescript-5.3-3178C6?logo=typescript" alt="typescript" />
  <img src="https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white" alt="python" />
  <img src="https://img.shields.io/badge/tests-167_JS_%2B_13_Python-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/license-Apache_2.0-orange" alt="license" />
</p>

---

## Stop generating macros

Most AI CAD assistants generate VBA or Python scripts and leave you to copy, paste, debug, and run them yourself.

Millwright doesn't. It calls **~50 native SolidWorks tools directly** — sketch, feature, assembly, export, and query operations — one step at a time. Every call returns a structured result, the AI reads it, and decides what to do next. No macro editing. No guessing whether it worked.

```
You:  Make a 80 × 50 × 10 plate with a 10 mm hole through the middle.

Millwright:
  ✓ New Part
  ✓ Start Sketch (top)
  ✓ Sketch Rectangle (80 × 50)
  ✓ Extrude (10 mm)
  ✓ Start Sketch · Sketch Circle (⌀10)
  ✓ Cut-Extrude (through all)
  ✓ Analyze View — "hole is open on both faces"
  Done.
```

**You choose the AI backend.** Claude, GPT, DeepSeek, Kimi, MiniMax, Qwen, GLM, or a local Ollama model — anything speaking the Anthropic or OpenAI-compatible protocol. The code is open; you only pay for your own API usage.

| | Typical CAD AI SaaS | **Millwright** |
|---|---|---|
| Automation | Prompt → one-shot macro you paste & run | **Agentic tool loop with self-correction** |
| AI backend | Fixed by plan | **Any model you choose (BYO key)** |
| Pricing | Per-seat subscription | **Free — open source, pay only your API usage** |
| Source | Closed | **Open (Apache-2.0)** |
| Verification | None | **Screenshots the model & reasons over it** |
| SolidWorks versions | Often pinned to one | **Adapts across versions at runtime** |

## Why Millwright

- 🛠 **Real tool-driving, not code generation.** The AI never hands you a macro to copy-paste — it calls native SolidWorks operations directly and decides its next move from the structured result of the last one.
- ⚙️ **Dual-engine runtime.** A Python sidecar talks to SolidWorks over early-bound COM for full capability. If the sidecar can't start, Millwright automatically falls back to a built-in VBScript engine — and says so in the chat, instead of silently losing functionality.
- 🔀 **Cross-version adaptive.** SolidWorks' COM API shifts parameter counts and member names across releases. Millwright discovers available signatures at runtime, falls back to dynamic dispatch when a member is missing, and probes cut/extrude direction automatically — no version hardcoded.
- 👁 **Seeing is believing.** The AI can screenshot the model and look at it: multimodal models read the image directly, text-only models get a dedicated vision model in the loop, and you can keep asking follow-up questions about the same screenshot. It checks its own work visually before moving on, and looks before it acts when something goes wrong.
- 🔒 **Safety boundaries.** Destructive operations show a confirmation card with the tool name and full parameters — nothing runs without a click. Documents are backed up automatically before destructive edits. Legacy scripts are blacklist-validated. CAD files never leave your machine; only text is sent to the AI.
- 📦 **Zero-dependency install.** The installer bundles its own Python runtime, `pywin32`, and `pillow` — no separate setup, works out of the box.
- 🔌 **Protocol-agnostic.** Native Anthropic and OpenAI-compatible support, hand-written `fetch` + SSE, no vendor lock-in. DeepSeek, MiniMax, GLM, and friends all work the same way.

## Features

- **Native tool calling.** Tools are injected into the model through the standard `tools` API, not stuffed into a prompt — one source of truth, and the tools describe themselves.
- **Agentic tool loop.** Observe → reason → act. The model chains multiple tool calls, reads structured JSON back from each one, and recovers from errors instead of failing silently.
- **Visual understanding.** Reorient, rotate, screenshot, and analyze the model — via a multimodal main model or a dedicated vision model.
- **Resident execution engine.** A persistent Python sidecar holds one COM connection open across an entire multi-step task.
- **Developer-friendly.** 167 TypeScript/Node tests plus a Python suite (`pytest sidecar/tests`) for the sidecar, a typed IPC boundary, and a `SKIP_SW_CONNECT` mode for UI-only development without SolidWorks installed.

## Cross-version compatibility

SolidWorks' COM API is not stable across releases: method signatures change, optional parameters appear or vanish, enum values evolve, and member names differ from version to version. Hardcoding against one release doesn't hold up.

```
Tool Request → Signature Discovery → Available COM Members → Dynamic Dispatch → Execute
```

Millwright discovers the best available API at execution time instead of assuming a fixed version, handling different parameter counts, missing COM members, multiple overload candidates, and differing feature directions automatically. One runtime, no version-specific builds.

This is hardened against real SolidWorks installs, not tested in the abstract. Concretely: `cut_extrude` searches parameter-count and signature variants at runtime until one succeeds, converging on whatever a given machine's build expects; feature-tree traversal falls back from the linked-list API to `IFeatureManager.GetFeatures` when COM won't resolve it; cut direction is probed forward, reverse, then symmetric. Every one of these came from a real failure on a real install.

## Safety, by default

AI should never be allowed to silently destroy CAD data.

```
Delete Feature → Confirmation Card → User Approval → Automatic Backup → Execute
```

- **Confirmation gate.** Destructive operations — cut, delete feature, suppress components, overwrite an export — show the tool name and full parameters and require an explicit click before running.
- **Automatic backup.** The current document is backed up before any destructive operation, so you can always recover.
- **Script validation.** Legacy VBScript execution is checked against a blacklist and dangerous-API detection before it ever reaches SolidWorks.
- **Local-first data.** CAD files never leave your machine — only the minimal text context needed for reasoning is sent to the AI provider.

## Vision feedback loop

Most CAD automation stops the moment the API call returns. Millwright keeps going — it actually looks at the model.

```
Create Feature → Capture View → Vision Model → Compare With Request → Need Changes? → Continue Editing
```

- **Multimodal main model** (Claude, GPT, MiniMax M3, Qwen-VL, …): screenshots go straight to the model, no extra step.
- **Text-only main model:** the screenshot is routed to an independent vision model, and its description feeds back into the planner — so even text-only LLMs can reason about CAD geometry.

## Quick Start

### Install

1. Download the installer from [Releases](https://github.com/raylanlin/Millwright/releases) and run it.
2. Start SolidWorks, then launch Millwright — the Python runtime is bundled, nothing else to install.

### From source

```bash
git clone https://github.com/raylanlin/Millwright.git
cd Millwright
npm install
pip install pywin32 pillow   # the sidecar runtime the installer normally bundles
npm run dev
```

> UI-only development without SolidWorks: set `SKIP_SW_CONNECT=true`.
>
> Without Python the app still runs, falling back to the legacy VBScript engine — but you lose structured results and visual understanding.

### Configure

1. Start SolidWorks, then launch Millwright.
2. Open ⚙️ **Settings** → pick a protocol → enter Base URL, API key, and model → **Save**.
3. (Optional) Enable **Vision**: either toggle *"main model supports images"* or configure a separate vision model.

## Supported AI providers

| Provider | Protocol | Base URL | Suggested model |
|---|---|---|---|
| DeepSeek | OpenAI-compatible | `https://api.deepseek.com` | `deepseek-v4-pro` |
| Kimi / Moonshot | OpenAI-compatible | `https://api.moonshot.cn/v1` | `kimi-k3` |
| MiniMax | OpenAI-compatible | `https://api.minimaxi.com/v1` | `minimax-m3` |
| Anthropic | Anthropic | `https://api.anthropic.com` | `claude-sonnet-5` / `claude-opus-5` |
| OpenAI | OpenAI | `https://api.openai.com/v1` | `gpt-5.6` |
| Alibaba Bailian (Qwen) | OpenAI-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-3.8max` |
| Zhipu (GLM) | OpenAI-compatible | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` |
| SiliconFlow | OpenAI-compatible | `https://api.siliconflow.cn/v1` | — |
| Ollama (local) | OpenAI-compatible | `http://localhost:11434/v1` | — |

> Model IDs move fast — check your provider's docs for the current lineup. Agentic tool calling requires a model that supports function calling; DeepSeek V4, Kimi K3, MiniMax M3, and GLM-4.6 are first-class targets.

## Examples

```
You: Sketch a 50×30 rectangle on the front plane and extrude it 20 mm.
AI:  start_sketch(front) → sketch_rectangle(50,30) → extrude(20)  ✓  part created

You: How heavy is this part, and what's its bounding box?
AI:  mass_properties → bounding_box  ✓  0.42 kg · 50 × 30 × 20 mm

You: Look at it from isometric — do the proportions look right?
AI:  set_view_orientation(isometric) → analyze_view("are the proportions balanced?")  ✓

You: Set every fillet in the model to 3 mm.
AI:  fillet_all(3)  → confirm? → ✓  6 fillets updated
```

## How it works

```
Renderer (React UI)
      │  IPC
Main process (Electron / Node)
      │  agent loop  ──  native function-calling tools injected into the model
      │      ├─ tool source & execution = sidecar (structured JSON in/out)
      │      └─ analyze_view ─┬─ dedicated vision model (image→text)
      │                       └─ or multimodal main model (image fed directly)
      │  JSON-RPC over stdio
Python sidecar (resident)  ──  pywin32 → SolidWorks COM API
      │
SolidWorks
```

- **Structured, observable tools.** Every tool returns `{ ok, data | error }` JSON, so the model can read the real state (feature tree, dimensions, mass, interferences) and plan the next step.
- **Legacy path retained.** If the Python sidecar can't start, the app automatically falls back to the original VBScript engine so nothing hard-breaks.
- **Zero SDK dependency** for LLM access: native `fetch` + a hand-written SSE parser.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Requirements

- Windows 10/11 (64-bit)
- SolidWorks 2017+
- Python 3.9+ with `pywin32` and `pillow` (bundled by the installer; required manually when running from source)
- Node.js 20+ (development only)

## Documentation

| Doc | What's inside |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | System design, modules, data flow |
| [User Guide](docs/USER-GUIDE.md) | Install, configure, FAQ |
| [Development](docs/DEVELOPMENT.md) | Code layout, conventions, testing |
| [API Reference](docs/API-REFERENCE.md) | LLM interfaces, tool catalog |
| [Contributing](docs/CONTRIBUTING.md) | How to contribute |
| [Verification backlog](docs/VERIFY-ISSUES.md) | Multi-parameter APIs pending macro-recorder verification |
| [Changelog](CHANGELOG.md) | Version history |
| [Security](SECURITY.md) | Security policy & disclosure |

## Contributing

Contributions welcome — see [CONTRIBUTING.md](docs/CONTRIBUTING.md). We especially value:

- 🧪 **Test reports from real SolidWorks environments.** Most of Millwright's hardening came from exactly this. A handful of multi-parameter APIs (`revolve`, `fillet_edges`, `shell`, the pattern and mirror family, `create_reference_point`, `export_stl`) are still waiting on macro-recorder confirmation from real installs — they're tracked in the [verification backlog](docs/VERIFY-ISSUES.md), and confirming one on your machine is the single most useful contribution you can make.
- 🔨 New sidecar tools (`sidecar/sw_agent/tools/`)
- 🎨 UI/UX improvements
- 🌐 Adapters for other CAD (Inventor, CATIA, NX) and MCP server integration
- 📝 Documentation & translations

## Roadmap

- [x] **v0.1** — MVP: Electron shell, LLM adapters, COM bridge, first tool set
- [x] **v0.2** — Python sidecar, agentic tool loop, dual-engine fallback, vision feedback, confirmation cards, Apache-2.0 open source
- [x] **v0.2.4 → v0.2.37** — Extensive hardening against real SolidWorks installs ← *current*: the sketch → feature → cut → visual-verification loop now runs end to end on real hardware
- [ ] **v0.3** — Streaming tool calls, sketching on model faces (not just reference planes), hole wizard, sheet metal, drawing annotations, remaining `#VERIFY` parameters confirmed
- [ ] **v1.0** — MCP server, multi-CAD support

> Millwright is young and moves fast — most releases so far have come from fixing real COM-binding and cross-version quirks reported from actual SolidWorks installs, tracked in [CHANGELOG.md](CHANGELOG.md).

## Name

**Millwright** *(n.)* — a skilled tradesperson who installs, maintains, and operates machinery. That's the role this tool plays: the AI machinist standing at your SolidWorks bench.

## License

[Apache-2.0](LICENSE) — permissive, with an explicit patent grant. Free for commercial use.

## Acknowledgments

- SolidWorks COM API reference: [CodeStack](https://www.codestack.net/)
- Inspiration: Cursor, Claude Code

<sub>SolidWorks is a registered trademark of Dassault Systèmes. Millwright is an independent open-source project and is not affiliated with or endorsed by Dassault Systèmes.</sub>
