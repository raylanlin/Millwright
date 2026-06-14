<p align="center">
  <img src="assets/icon-256.png" width="80" height="80" alt="SW Copilot" />
</p>

<h1 align="center">SW Copilot</h1>

<p align="center">
  <strong>开源的 SolidWorks AI 自动化助手</strong><br/>
  <em>Open-source SolidWorks AI automation assistant</em>
</p>

<p align="center">
  <a href="#快速开始--quick-start">快速开始</a> ·
  <a href="docs/USER-GUIDE.md">用户手册</a> ·
  <a href="docs/ARCHITECTURE.md">技术架构</a> ·
  <a href="docs/CONTRIBUTING.md">参与贡献</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.1-blue" alt="version" />
  <img src="https://img.shields.io/badge/electron-28-47848F?logo=electron" alt="electron" />
  <img src="https://img.shields.io/badge/react-18-61DAFB?logo=react" alt="react" />
  <img src="https://img.shields.io/badge/typescript-5.3-3178C6?logo=typescript" alt="typescript" />
  <img src="https://img.shields.io/badge/tests-161_passed-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/license-GPLv3-orange" alt="license" />
</p>

---

## 为什么选择 SW Copilot？ / Why SW Copilot?

市面上的 CAD AI 助手（如 MecAgent）绑定特定 AI 服务商，按月收费 $16–417，且底层模型能力有限。

SW Copilot 的理念：**AI 后端由你决定**。接入 Claude、GPT-4o、DeepSeek、Qwen、Ollama 本地模型——代码开源，开箱即用。

> Existing CAD AI tools lock you into one provider at $16–417/mo. SW Copilot lets you **choose any AI backend** — Claude, GPT-4o, DeepSeek, Qwen, or local Ollama. Open source. Works out of the box.

| | MecAgent | **SW Copilot** |
|---|---|---|
| AI 后端 | 固定（按套餐分级） | **用户自选（任意模型）** |
| 价格 | $16–417/月 | **免费**（用户自付 API 费用） |
| 源代码 | 闭源 | **开源** |
| COM 方式 | winax 原生模块 | **零依赖 cscript.exe** |

## 核心特性 / Features

- **自然语言 → SolidWorks 操作**：用中文或英文描述需求，AI 生成 VBA/Python 脚本并通过 COM 接口执行
- **双协议 LLM 适配**：Anthropic 协议 + OpenAI 兼容协议，覆盖 7+ 服务商
- **零插件安装**：通过 Windows 原生 `cscript.exe` + VBScript 连接 SolidWorks，无需 winax 等原生模块
- **26 个内置工具**：草图、特征、装配、导出、批量操作全覆盖
- **安全第一**：脚本黑名单校验 + 执行前自动备份 + 用户确认机制
- **开发者友好**：161 个单元测试、完整文档、`SKIP_SW_CONNECT` 纯 UI 开发模式

## 快速开始 / Quick Start

### 安装 / Install

从 [Releases](https://github.com/raylanlin/sw-copilot/releases) 下载安装包，双击安装。

### 从源码运行 / From Source

```bash
git clone https://github.com/raylanlin/sw-copilot.git
cd sw-copilot
npm install
npm run dev
```

> 纯 UI 开发无需 SolidWorks：设置 `SKIP_SW_CONNECT=true`
>
> UI-only dev without SolidWorks: set `SKIP_SW_CONNECT=true`

### 配置 / Configuration

1. 启动 SolidWorks → 启动 SW Copilot
2. 点击 ⚙️ **设置** → 选择 API 协议 → 填入 Base URL 和 API Key → **保存**

<details>
<summary><strong>支持的 AI 服务商 / Supported Providers</strong></summary>

| 服务商 Provider | 协议 Protocol | Base URL |
|---|---|---|
| Anthropic (Claude) | Anthropic | `https://api.anthropic.com` |
| OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` |
| 百炼 (Qwen) | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| MiniMax | OpenAI 兼容 | `https://api.minimax.chat/v1` |
| DeepSeek | OpenAI 兼容 | `https://api.deepseek.com` |
| 硅基流动 | OpenAI 兼容 | `https://api.siliconflow.cn/v1` |
| Ollama (本地) | OpenAI 兼容 | `http://localhost:11434/v1` |

</details>

## 使用示例 / Examples

```
你: 把装配体里所有零件的圆角半径统一改成 3mm
AI: [生成 VBA 脚本] → 检测到 8 个圆角特征，确认执行？ → 执行完成 ✓

你: 导出当前零件为 STEP 和 PDF
AI: [生成导出脚本] → 导出完成 ✓

你: 在前视面画一个 50×30 的矩形然后拉伸 20mm
AI: [生成建模脚本] → 零件创建完成 ✓
```

## 架构 / Architecture

```
Renderer (React UI)  ←IPC→  Main Process (Node.js)  ←COM/cscript→  SolidWorks
```

- **零 SDK 依赖**：原生 `fetch` + 手写 SSE 解析器，运行时仅 2 个 npm 依赖
- **VBA → VBS 转换器**：10 步自动转换，支持 AI 直接生成的 VBA 代码
- **UTF-16LE+BOM 编码**：解决中文注释在 cscript 中的编译错误
- **GetObject → CreateObject fallback**：兼容 SolidWorks 未注册 ROT 的场景

详见 [技术架构文档](docs/ARCHITECTURE.md)。

## 系统要求 / Requirements

- Windows 10/11 (64-bit)
- SolidWorks 2017+
- Node.js 20+（仅开发模式）

## 文档 / Documentation

| 文档 | 说明 |
|---|---|
| [技术架构](docs/ARCHITECTURE.md) | 系统设计、模块说明、数据流 |
| [用户手册](docs/USER-GUIDE.md) | 安装配置、使用指南、FAQ |
| [开发者指南](docs/DEVELOPMENT.md) | 代码结构、开发约定、测试 |
| [API 参考](docs/API-REFERENCE.md) | LLM 接口、COM API 速查 |
| [贡献指南](docs/CONTRIBUTING.md) | 如何参与贡献 |
| [变更记录](CHANGELOG.md) | 版本历史 |
| [安全策略](SECURITY.md) | 安全规范与漏洞报告 |

## 参与贡献 / Contributing

欢迎贡献！详见 [CONTRIBUTING.md](docs/CONTRIBUTING.md)。

特别欢迎 / We especially welcome:

- 🧪 SolidWorks 实际环境测试报告
- 🔨 新的 SW 工具生成器（扩展 26 → 40+）
- 🎨 UI/UX 改进与交互优化
- 🌐 多 CAD 软件适配（Inventor、CATIA、NX）
- 📝 文档翻译与国际化
- 🔌 MCP Server 集成

## 路线图 / Roadmap

- [x] **v0.1.0** — MVP 基础架构（Electron + LLM + COM + 26 Tools）
- [x] **v0.2.0** — 稳定版（Bug 修复 + CI/CD + .env fallback + 文档完善）
- [x] **v0.2.1** — 假成功问题彻底修复（移除 CreateObject fallback + vbaToVbs 重写）← *当前*
- [ ] **v0.3.0** — 高级特性（视觉感知 + 小步快跑 Agent + Function Calling）
- [ ] **v1.0.0** — 生态建设（MCP Server + 多 CAD + 商业授权）

## 许可证 / License

[GNU GPLv3](LICENSE) — 自由软件，允许商业使用，衍生作品也须开源。

## 致谢 / Acknowledgments

- SolidWorks COM API 参考：[CodeStack](https://www.codestack.net/)
- MCP 生态：[SolidworksMCP-TS](https://github.com/vespo92/SolidworksMCP-TS)、[SolidPilot](https://github.com/eyfel/mcp-server-solidworks)
- 灵感来源：Cursor、Claude Code、MecAgent
