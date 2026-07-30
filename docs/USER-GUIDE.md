# Millwright — User Manual

> Version 0.2.0 · 2026-04-28

---

## Quick Start

### System Requirements

- Windows 10 / 11 (64-bit)
- SolidWorks 2017 or newer (installed and activated)
- Node.js 20+ (only required for development mode)
- At least one AI provider account (Anthropic / OpenAI / Bailian / MiniMax / DeepSeek, etc.)

### Installation Steps

1. Download the latest `Millwright Setup x.x.x.exe` from the GitHub Releases page.
2. Double-click the installer and follow the prompts.
3. A Millwright shortcut will appear on your desktop once installation is complete.

### First-Time Configuration

1. Start SolidWorks first, then open or create a file.
2. Launch Millwright.
3. Check the status area in the left sidebar and confirm that SolidWorks shows "Connected".
4. Click the "⚙️ Settings" button at the bottom-left.
5. Pick an API protocol and fill in the configuration (see the next section).
6. Click "Test Connection" to confirm the API is reachable.
7. Click "Save".

---

## Configuring an AI Provider

### Option 1: Anthropic (Claude)

If you have an Anthropic API key:

| Field | Value |
|--------|-----|
| API Protocol | Anthropic |
| Base URL | https://api.anthropic.com |
| API Key | Your `sk-ant-...` key |
| Model | `claude-sonnet-4-20250514` (recommended) |

Get your API key by signing up at console.anthropic.com and creating a key.

### Option 2: OpenAI

| Field | Value |
|--------|-----|
| API Protocol | OpenAI-compatible |
| Base URL | https://api.openai.com/v1 |
| API Key | Your `sk-...` key |
| Model | `gpt-4o` |

### Option 3: Bailian (Alibaba Cloud)

| Field | Value |
|--------|-----|
| API Protocol | OpenAI-compatible |
| Base URL | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| API Key | Your Bailian API key |
| Model | Choose "Custom model" and enter `qwen-coder-plus` |

### Option 4: MiniMax

| Field | Value |
|--------|-----|
| API Protocol | OpenAI-compatible |
| Base URL | https://api.minimax.chat/v1 |
| API Key | Your MiniMax API key |
| Model | Choose "Custom model" and enter `MiniMax-Text-01` |

### Option 5: DeepSeek

| Field | Value |
|--------|-----|
| API Protocol | OpenAI-compatible |
| Base URL | https://api.deepseek.com |
| API Key | Your DeepSeek API key |
| Model | Choose "Custom model" and enter `deepseek-chat` |

### Option 6: Local Model (Ollama)

No API key needed — runs fully offline:

1. Install Ollama: https://ollama.com
2. Pull a model: `ollama pull qwen2.5-coder:32b`
3. Configure Millwright:

| Field | Value |
|--------|-----|
| API Protocol | OpenAI-compatible |
| Base URL | http://localhost:11434/v1 |
| API Key | `ollama` (any string works) |
| Model | Choose "Custom model" and enter `qwen2.5-coder:32b` |

---

## Using the Interface

### Main Layout

```
┌────────┬──────────────────────────────┐
│ Sidebar│          Main area            │
│        │                              │
│ Logo   │    Chat / Templates / Tools   │
│ Status │                              │
│        │                              │
│ 💬 Chat │                              │
│ ⚡ Quick │                              │
│ 🔧 Tools│                              │
│        │                              │
│        │──────────────────────────────│
│ Theme  │          Input box            │
│ ⚙ Settings│                            │
└────────┴──────────────────────────────┘
```

### Chat

Describe what you want to do in the input box using natural language, e.g.:

- "Change every fillet radius to 3 mm"
- "Export the current part to STEP and PDF"
- "Sketch a 50×30 rectangle on the front plane and extrude 20 mm"
- "Batch-rename all components in this assembly with the prefix PROJ-2026-"
- "Check the assembly for interferences"
- "Export the BOM to Excel"

The AI generates the corresponding VBA macro or Python script, shows a preview, and waits for your confirmation before running.

### Quick Templates

Click "⚡ Templates" in the sidebar to see the preset cards — click any one to populate the chat box.

### Tool List

Click "🔧 Tools" in the sidebar to see every registered SolidWorks COM tool and understand what the AI can call.

---

## Customizing the System Prompt

In Settings → "System Prompt", you can shape how the AI behaves. Examples:

### Constrain the Output Language

```
Always reply in English. Code comments should also be in English.
```

### Restrict Script Type

```
Only generate VBA macros — never Python.
Every macro must have Sub main() as the entry point.
```

### Add Company Conventions

```
All parts follow the naming scheme: [project]-[type]-[sequence]
Example: P2026-BRACKET-001
Exports go to D:\Projects\Export\
```

### Constrain the Operation Scope

```
Only operate on the currently open document — do not open new files.
Save a backup copy of the current document before any modification.
```

---

## Switching Theme

Millwright ships with two themes:

- **Light theme** — white background + light gray sidebar, suited to bright environments.
- **Dark theme** — dark gray background + medium gray cards, suited to dim environments.

Switch via:
- The "🌙 Dark Mode" / "☀️ Light Mode" button at the bottom of the sidebar.
- The "Appearance" option in Settings.

---

## FAQ

### SolidWorks shows "Not Detected"

1. Make sure SolidWorks is running and has an open file.
2. Click the "Refresh" button to retry.
3. If it still isn't detected, try running Millwright as Administrator.
4. Confirm the SolidWorks version is >= 2017.

### API Connection Test Fails

1. Make sure the API key is pasted correctly (no stray spaces).
2. Confirm the Base URL is well-formed (no trailing `/`).
3. Check your network connection (some APIs may require a proxy).
4. Bailian users: the Base URL is `dashscope.aliyuncs.com`, **not** `bailian.console.aliyun.com`.

### Script Execution Fails

1. Read the error message — usually it's an incorrect API call argument.
2. Confirm the document type matches the operation (part vs assembly vs drawing).
3. Some operations require you to select a specific entity first.
4. Try rephrasing your request in a different way.

### Reducing API Cost

- Use smaller models (e.g. Claude Haiku, GPT-4o-mini) for simple tasks.
- Use cheaper domestic providers such as Bailian / DeepSeek.
- Use Ollama to run a local model (free, but quality depends on hardware).
- Save repetitive tasks as templates to avoid repeated AI calls.

---

## Security Notes

- Millwright never uploads your CAD files anywhere.
- Only your text description is sent to the AI — never model data.
- API keys are encrypted at rest and never transmitted in plaintext to any Millwright server (we don't run one).
- Every generated script is shown for preview before execution; you stay in full control.
- Save a backup before any important operation.

---

## Keyboard Shortcuts

| Shortcut | Action |
|--------|------|
| Enter | Send message |
| Shift + Enter | Newline |
| Ctrl + , | Open Settings |
| Ctrl + L | Clear chat |
| Ctrl + 1/2/3 | Switch tabs (Chat / Templates / Tools) |