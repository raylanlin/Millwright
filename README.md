<p align="center">
  <img src="assets/icon-256.png" width="80" height="80" alt="SW Copilot" />
</p>

<h1 align="center">SW Copilot</h1>

<p align="center">
  <strong>Open-source AI automation for SolidWorks — talk to your CAD.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#supported-ai-providers">AI providers</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/CONTRIBUTING.md">Contributing</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.4-blue" alt="version" />
  <img src="https://img.shields.io/badge/electron-28-47848F?logo=electron" alt="electron" />
  <img src="https://img.shields.io/badge/react-18-61DAFB?logo=react" alt="react" />
  <img src="https://img.shields.io/badge/typescript-5.3-3178C6?logo=typescript" alt="typescript" />
  <img src="https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white" alt="python" />
  <img src="https://img.shields.io/badge/tests-167_passed-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/license-Apache_2.0-orange" alt="license" />
</p>

---

Describe what you want in plain language — *"sketch a 50×30 rectangle on the front plane and extrude it 20 mm"* — and SW Copilot drives SolidWorks to do it. The AI plans the work, calls real modeling tools one step at a time, reads structured results back, and corrects itself as it goes.

**You choose the AI backend.** Claude, GPT-4o, DeepSeek, Kimi, MiniMax, Qwen, or a local Ollama model — anything speaking the Anthropic or OpenAI-compatible protocol. The code is open; you pay only your own API usage.

> Existing CAD AI tools lock you into one provider at \$16–417/mo. SW Copilot is free and provider-agnostic.

| | Typical CAD AI SaaS | **SW Copilot** |
|---|---|---|
| AI backend | Fixed by plan | **Any model you choose** |
| Pricing | \$16–417 / month | **Free** (you bring your own API key) |
| Source | Closed | **Open (Apache-2.0)** |
| Automation | Prompt → one-shot script | **Agentic tool loop with self-correction** |
| Visual feedback | — | **Screenshots the viewport & reasons over it** |

## Features

- **Natural language → real modeling.** English or Chinese in; sketches, features, assemblies, and exports out.
- **Agentic tool loop.** The model calls structured, single-purpose tools (`create_sketch`, `extrude`, `chamfer`, `mass_properties`, …), receives JSON results, and chains multiple steps to finish a task — recovering from errors instead of failing silently.
- **Native function calling.** Tools are injected into the model via the standard `tools` API, not stuffed into a prompt. One source of truth — the tools describe themselves.
- **Visual understanding.** The agent can reorient, rotate, and screenshot the model, then analyze it — either through a **dedicated vision model** (image→text) or by feeding the image straight to a **multimodal main model**.
- **Resident execution engine.** A persistent Python sidecar drives the SolidWorks COM API directly (via `pywin32`), holding one connection across many steps.
- **Safety first.** Per-language script validation, automatic pre-execution backup, and a confirmation gate before any destructive operation.
- **Developer-friendly.** 167 unit tests, typed IPC boundary, and a `SKIP_SW_CONNECT` mode for UI-only development without SolidWorks.

## Quick Start

### Install

1. Download the installer from [Releases](https://github.com/raylanlin/sw-copilot/releases) and run it.
2. Install the sidecar runtime (drives SolidWorks):
   ```bash
   pip install pywin32 pillow
   ```
   > Without Python, the app still runs and falls back to the legacy VBScript engine — but you lose structured results and visual understanding. Installing Python is strongly recommended.

### From source

```bash
git clone https://github.com/raylanlin/sw-copilot.git
cd sw-copilot
npm install
npm run dev
```

> UI-only development without SolidWorks: set `SKIP_SW_CONNECT=true`.

### Configure

1. Start SolidWorks, then launch SW Copilot.
2. Open ⚙️ **Settings** → pick a protocol → enter Base URL, API key, and model → **Save**.
3. (Optional) Enable **Vision**: either toggle *"main model supports images"* or configure a separate vision model.

## Supported AI providers

| Provider | Protocol | Base URL | Suggested model |
|---|---|---|---|
| DeepSeek | OpenAI-compatible | `https://api.deepseek.com` | `deepseek-v4-pro` |
| Kimi / Moonshot | OpenAI-compatible | `https://api.moonshot.cn/v1` | `kimi-k3` |
| MiniMax | OpenAI-compatible | `https://api.minimaxi.com/v1` | `minimax-m3` |
| Anthropic | Anthropic | `https://api.anthropic.com` | `claude-sonnet-4` |
| OpenAI | OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Alibaba Bailian (Qwen) | OpenAI-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
| SiliconFlow | OpenAI-compatible | `https://api.siliconflow.cn/v1` | — |
| Ollama (local) | OpenAI-compatible | `http://localhost:11434/v1` | — |

> Agentic tool calling requires a model that supports function calling. DeepSeek, Kimi K3, and MiniMax M3 are first-class targets.

## Examples

```
You: Sketch a 50×30 rectangle on the front plane and extrude it 20 mm.
AI:  create_sketch(front) → sketch_rectangle(50,30) → extrude(20)  ✓  part created

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
- Python 3.9+ with `pywin32` and `pillow` (for the sidecar)
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

- 🧪 Test reports from real SolidWorks environments (and macro-recorder verification of the [pending APIs](docs/VERIFY-ISSUES.md))
- 🔨 New sidecar tools (`sidecar/sw_agent/tools/`)
- 🎨 UI/UX improvements
- 🌐 Adapters for other CAD (Inventor, CATIA, NX) and MCP server integration
- 📝 Documentation & translations

## Roadmap

- [x] **v0.1** — MVP (Electron + LLM + COM + tools)
- [x] **v0.2** — Stable base, CI, docs
- [x] **v0.2.4** — Python sidecar, agentic tool loop, visual understanding, Apache-2.0 open source ← *current*
- [ ] **v0.3** — Full tool coverage, macro-verified parameters, streaming tool calls
- [ ] **v1.0** — MCP server, multi-CAD support

## License

[Apache-2.0](LICENSE) — permissive, with an explicit patent grant. Free for commercial use.

## Acknowledgments

- SolidWorks COM API reference: [CodeStack](https://www.codestack.net/)
- Inspiration: Cursor, Claude Code
