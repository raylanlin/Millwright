# Contributing to Millwright

Thank you for your interest in contributing!

---

## 🚀 Quick Start

```bash
git clone https://github.com/raylanlin/Millwright.git
cd Millwright
npm install
cp .env.example .env          # Fill in API keys (optional)
SKIP_SW_CONNECT=true npm run dev   # Develop the UI without SolidWorks installed
```

### Prerequisites

- Node.js >= 20, npm >= 10
- Python >= 3.10 (optional, only needed to run Python scripts)
- SolidWorks 2017+ (optional, needed for real-world testing)
- Git

## 🎯 Ways to Contribute

| Direction | Difficulty | Description |
|---|---|---|
| 🧪 Real SolidWorks testing | ⭐ | Test tools in a real SW environment and submit test reports |
| 📝 Documentation & translations | ⭐ | Improve bilingual docs |
| 🐛 Bug fixes | ⭐⭐ | See [Issues](https://github.com/raylanlin/Millwright/issues) |
| 🔨 New tool generators | ⭐⭐ | Expand SW tool coverage (see workflow below) |
| 🎨 UI/UX improvements | ⭐⭐ | Interaction polish, animation, responsive layouts |
| 🔌 MCP Server | ⭐⭐⭐ | Expose Millwright as an MCP server callable from Claude Desktop and friends |
| 🌐 Multi-CAD adapters | ⭐⭐⭐ | Inventor / CATIA / NX support |

## 📋 Full Steps to Add a New SW Tool

```
1. shared/sw-tools.ts     → Add a definition to SW_TOOLS (name/description/parameters/category)
2. scripts/generators/*.ts → Add the implementation function
3. scripts/generators/index.ts → Map it in REGISTRY
4. npm test               → generators.test.mjs auto-covers the new tool
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for details.

## 🔀 Pull Request Workflow

1. Fork → create a branch `feat/your-feature` or `fix/your-fix`
2. Develop and make sure `npm test` and `npm run lint` pass
3. Update CHANGELOG.md (when applicable)
4. Open the PR using the template to describe the change

### Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add shell feature generator
fix: vbs encoding for Chinese comments
docs: add DeepSeek configuration guide
chore: bump electron to v29
test: add mirror feature edge cases
```

### Branch Naming

```
feat/xxx    — New feature
fix/xxx     — Bug fix
docs/xxx    — Documentation
chore/xxx   — Build / dependencies / CI
```

## 📐 Code Style

- TypeScript strict mode, ESLint + Prettier
- Functional components + Hooks only, no class components
- File names `kebab-case`, variables `camelCase`, types `PascalCase`
- IPC channel names must only be imported from `shared/ipc-channels.ts`
- All UI colors reference the theme object `t`; no hard-coded values
- LLM errors are normalized through `toLLMError()`

## 🧪 Testing

```bash
npm run build:main && npm test    # All 161 cases
node --test tests/sse.test.mjs    # Single file
```

Tests use `node:test` (zero external dependencies) and read from the `dist/` build output.

## 📄 License

Contributed code is released under [Apache-2.0](../LICENSE).