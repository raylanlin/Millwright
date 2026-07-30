# Contributing to Millwright / 贡献指南

感谢你对 Millwright 的关注！Thank you for your interest in contributing!

---

## 🚀 快速开始 / Quick Start

```bash
git clone https://github.com/raylanlin/Millwright.git
cd Millwright
npm install
cp .env.example .env          # 填入 API Key（可选）
SKIP_SW_CONNECT=true npm run dev   # 无需 SolidWorks 即可开发 UI
```

### 前置要求 / Prerequisites

- Node.js >= 20, npm >= 10
- Python >= 3.10（可选，执行 Python 脚本时需要）
- SolidWorks 2017+（可选，实际测试时需要）
- Git

## 🎯 贡献方向 / Ways to Contribute

| 方向 | 难度 | 说明 |
|---|---|---|
| 🧪 SolidWorks 实测 | ⭐ | 在真实 SW 环境测试工具，提交测试报告 |
| 📝 文档翻译 | ⭐ | 中英双语文档完善 |
| 🐛 Bug 修复 | ⭐⭐ | 查看 [Issues](https://github.com/raylanlin/Millwright/issues) |
| 🔨 新工具生成器 | ⭐⭐ | 扩展 SW 工具覆盖（见下方流程） |
| 🎨 UI/UX 改进 | ⭐⭐ | 交互优化、动画、响应式 |
| 🔌 MCP Server | ⭐⭐⭐ | 作为 MCP Server 被 Claude Desktop 等调用 |
| 🌐 多 CAD 适配 | ⭐⭐⭐ | Inventor / CATIA / NX 支持 |

## 📋 新增 SW 工具的完整步骤

```
1. shared/sw-tools.ts     → SW_TOOLS 加定义（name/description/parameters/category）
2. scripts/generators/*.ts → 加实现函数
3. scripts/generators/index.ts → REGISTRY 映射
4. npm test               → generators.test.mjs 自动覆盖新工具
```

详见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 🔀 Pull Request 流程

1. Fork → 创建分支 `feat/your-feature` 或 `fix/your-fix`
2. 开发并确保 `npm test` 和 `npm run lint` 通过
3. 更新 CHANGELOG.md（如适用）
4. 提交 PR，使用模板描述改动

### 提交格式 / Commit Convention

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: add shell feature generator
fix: vbs encoding for Chinese comments
docs: add DeepSeek configuration guide
chore: bump electron to v29
test: add mirror feature edge cases
```

### 分支命名 / Branch Naming

```
feat/xxx    — 新功能
fix/xxx     — 修复
docs/xxx    — 文档
chore/xxx   — 构建/依赖/CI
```

## 📐 代码规范 / Code Style

- TypeScript 严格模式，ESLint + Prettier
- 函数式组件 + Hooks，无 class component
- 文件名 `kebab-case`，变量 `camelCase`，类型 `PascalCase`
- IPC 频道名只从 `shared/ipc-channels.ts` 导入
- 所有 UI 颜色通过主题对象 `t` 引用，不硬编码
- LLM 错误统一经 `toLLMError()` 归一化

## 🧪 测试

```bash
npm run build:main && npm test    # 全部 161 个用例
node --test tests/sse.test.mjs    # 单个文件
```

测试使用 `node:test`（零外部依赖），读取 `dist/` 编译产物。

## 📄 许可证 / License

贡献的代码将以 [Apache-2.0](../LICENSE) 发布。
