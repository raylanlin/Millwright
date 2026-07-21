<p align="center">
  <img src="assets/banner-hero.png" alt="SW Copilot — SolidWorks AI 自动化助手" />
</p>

<h1 align="center">SW Copilot</h1>

<p align="center">
  <strong>开源的 SolidWorks AI 自动化助手</strong><br/>
  <em>用自然语言跟 CAD 对话,直接出货几何体,不再写样板代码。</em>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/USER-GUIDE.md">用户手册</a> ·
  <a href="docs/ARCHITECTURE.md">技术架构</a> ·
  <a href="docs/CONTRIBUTING.md">参与贡献</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.4-blue" alt="version" />
  <img src="https://img.shields.io/badge/electron-28-47848F?logo=electron" alt="electron" />
  <img src="https://img.shields.io/badge/react-18-61DAFB?logo=react" alt="react" />
  <img src="https://img.shields.io/badge/typescript-5.3-3178C6?logo=typescript" alt="typescript" />
  <img src="https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python" alt="python" />
  <img src="https://img.shields.io/badge/tests-167_passed-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="license" />
</p>

---

## 为什么选择 SW Copilot?

市面上的 CAD AI 助手(如 MecAgent)把用户绑死在单一服务商、按月收费 $16–417,且底层模型闭源无法审计。**SW Copilot 把这两个默认都翻了过来**:你可以选任何 AI 后端(Claude、GPT-4o、DeepSeek、Qwen、MiniMax、本地 Ollama),跑的是你能读、能改、能 fork 的开源代码。

| | 闭源 CAD AI | **SW Copilot** |
|---|---|---|
| AI 后端 | 单一服务商,按套餐分级 | **任意 OpenAI / Anthropic 兼容端点** |
| 价格 | $16–417/月 | **免费**(你自付 API 费用) |
| 源代码 | 闭源 | **Apache-2.0,开源** |
| COM 桥 | 原生 `winax` 模块 | **Python `pywin32` + stdio JSON-RPC** |
| 工具集 | 固定目录 | **26+ 工具,带扩展 API** |

---

## 核心特性

- **自然语言 → SolidWorks 操作**。用中文或英文描述需求,agent 自动规划步骤、调用工具、返回结构化结果——不是甩一坨文本给你。
- **LLM 不绑服务商**。同时支持 Anthropic 协议 + OpenAI 兼容协议。Anthropic Claude、OpenAI、DeepSeek、Qwen(百炼)、MiniMax、硅基流动、Ollama,以及任何自定义端点。
- **Python 边车架构**。常驻 `sw_agent` 进程持有 SolidWorks COM 连接、执行工具、以结构化 JSON 流式回传结果。再也不会每个动作起一个 cscript 子进程。
- **可选视觉感知**。可配独立视觉模型(图生文),或勾选多模态主模型。Agent 可以转视角、截屏、分析、决策。
- **26+ 内置工具**覆盖草图、特征、装配、参考几何、文档、视图、导出。每个工具都是 `@tool` 装饰的 Python 函数,带自动生成的 JSON schema。
- **安全第一**。脚本黑名单校验、会话级备份一键回滚、破坏性操作需用户确认、crash log 滚动保留。
- **开发者友好**。167 个单元测试、端到端构建(typecheck + lint + test + electron-builder)、`SKIP_SW_CONNECT` 开关让你在没装 SW 的情况下纯开发 UI。

---

## 快速开始

### 系统要求

- **Windows 10/11 (64-bit)**
- **SolidWorks 2017+**(已安装并能正常运行)
- **Python 3.9+**,装好 `pywin32` 和 `Pillow`:

  ```powershell
  pip install pywin32 pillow
  ```

  Pillow 这一步很关键——没装的话边车只能返回 BMP 截屏,大多数视觉模型会拒绝解码。

- **Node.js 20+**(仅从源码构建时需要)

### 安装(终端用户)

1. 从 [Releases](https://github.com/raylanlin/sw-copilot/releases) 下载最新的 `SW Copilot-Setup-x.y.z-x64.exe`
2. 双击安装。安装器会把应用和打包好的 Python 边车一起放到 `Program Files\SW Copilot\`
3. 先启动 SolidWorks,再启动 SW Copilot
4. 打开 ⚙️ 设置 → 选择 AI 服务商 → 粘贴 API Key → 保存

### 从源码运行

```bash
git clone https://github.com/raylanlin/sw-copilot.git
cd sw-copilot
npm install
npm run dev
```

> 纯 UI 开发模式(不需要 SolidWorks):`SKIP_SW_CONNECT=true npm run dev`

### 第一次对话

打开聊天面板,试试:

```
在前视基准面画一个 50×30 mm 的矩形,拉伸 20 mm。
```

```
这个零件多重?包络多大?
```

Agent 会依次调 `start_sketch` → `sketch_rectangle` → `extrude`,每一步实时渲染到 UI。在 SolidWorks 里切换文档,侧栏指示器会在 3 秒内自动刷新。

---

## 架构

SW Copilot 是三层架构。Python 边车是工具的唯一真源;主进程是编排者;渲染层是表现面。

```
┌────────────────────────────────────────────────────────────┐
│  渲染层 (React)                                             │
│    └─ llm:agent → window.api.llm.agent(config, messages)    │
└────────────────────────┬───────────────────────────────────┘
                         │ IPC (preload)
┌────────────────────────▼───────────────────────────────────┐
│  主进程 (Electron)                                          │
│    ├─ runSidecarAgent ─ OpenAI 兼容工具分发                │
│    │     ├─ 工具真源 = 边车 list_tools() 自描述 JSON schema │
│    │     ├─ 执行 = 边车 call() → 结构化 {ok, data, error}  │
│    │     └─ 视觉 analyze_view → 独立视觉模型 或 主模型多模态│
│    ├─ 确认门 → 破坏性工具需用户确认                         │
│    ├─ 会话级备份 → 一键回滚                                 │
│    └─ 兜底:边车不可用时 → runAgentLoop (旧 VBS 路径)        │
└────────────────────────┬───────────────────────────────────┘
                         │ stdio JSON-RPC (按换行符分隔)
┌────────────────────────▼───────────────────────────────────┐
│  Python 边车 (sw_agent, 常驻)                              │
│    ├─ win32com → SolidWorks (单连接常驻)                   │
│    ├─ 工具注册表 (@tool 装饰) — view/sketch/feature/       │
│    │   reference/assembly/query/document/export            │
│    └─ 每次工具调用返回结构化 JSON                           │
└────────────────────────────────────────────────────────────┘
```

### 为什么要用 Python 边车?

旧设计每次工具调用都起一个新 `cscript.exe`。能跑,但有三个坑:(a) 每步都要付 COM 握手的代价;(b) VBS 里任何未捕获错误都会让进程进入不确定状态;(c) VBS 没有原生的结构化数据返回——agent 只能看到 `MsgBox` 字符串。

P3 边车用一个常驻 Python 进程替换掉这一切:

1. 整个 App 生命周期内持有同一个 `SldWorks.Application` COM 句柄
2. 每个工具都是 `@tool` 装饰的函数,自动生成 JSON schema
3. 每次调用返回 `{ ok, data, error }`,agent 失败时能自纠
4. 进度通过 stdio 流式回传,UI 可以实时渲染每一步

如果 `pywin32` 或 Python 没装,应用会自动回退到旧 VBS 路径——不会崩,但吃不到结构化返回和视觉。README 在第一次启动时会强制提示。

---

## 系统要求

| 层级 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 (64-bit) |
| CAD | SolidWorks 2017 或更新(已安装并授权) |
| Python | 3.9+ 装好 `pywin32` 和 `Pillow` |
| 内存 | 最低 4 GB,推荐 8 GB(跑视觉流程时) |
| Node | 20+ (仅从源码构建) |
| 网络 | 出站 HTTPS 到你选的 LLM 端点 |

---

## 文档

| 文档 | 说明 |
|---|---|
| [用户手册](docs/USER-GUIDE.md) | 安装配置、使用指南、FAQ |
| [技术架构](docs/ARCHITECTURE.md) | 系统设计、模块说明、数据流 |
| [API 参考](docs/API-REFERENCE.md) | LLM 接口、工具目录、COM API 速查 |
| [开发者指南](docs/DEVELOPMENT.md) | 代码结构、开发约定、测试 |
| [贡献指南](docs/CONTRIBUTING.md) | 如何参与贡献、代码风格、PR 流程 |
| [VERIFY 追踪](docs/VERIFY-ISSUES.md) | 待 SolidWorks 宏录制核验的工具 |
| [更新日志](CHANGELOG.md) | 版本历史 |
| [安全策略](SECURITY.md) | 安全规范与漏洞报告 |

---

## 参与贡献

欢迎贡献!详见 [CONTRIBUTING.md](docs/CONTRIBUTING.md)。

特别欢迎:

- 🧪 **SolidWorks 真实环境测试报告**——开个 issue 附上你的 SW 版本和最小复现
- 🔨 **新增工具实现**(在 `sidecar/sw_agent/tools/` 下)——把工具目录从 26 扩到 40+
- 🎨 **UI/UX 改进**——聊天面板和工具步骤渲染
- 🌐 **多 CAD 适配器**(Inventor、CATIA、NX、Onshape)
- 📝 **文档翻译与国际化**——README.zh-CN.md 需要持续跟进
- 🔌 **MCP Server 集成**——让 SW Copilot 能被 Claude Code / Cursor 直接驱动

### 加一个新工具

边车的工具注册表就是扩展点。在 `sidecar/sw_agent/tools/` 下加一个新文件:

```python
from ..registry import tool

@tool(
    name="my_tool",
    description="这个工具做什么(LLM 可见)。",
    parameters={
        "type": "object",
        "properties": {
            "param1": {"type": "string", "description": "第一个参数"},
        },
        "required": ["param1"],
    },
)
def my_tool(param1: str) -> dict:
    """实现写这里。返回 {\"ok\": True, \"data\": {...}}。"""
    return {"ok": True, "data": {"result": param1}}
```

重启 App——边车会自动发现新工具并暴露给 LLM。完整注册表协议见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 路线图

- [x] **v0.1.0** — MVP(Electron + LLM + COM + 26 工具)
- [x] **v0.2.0** — 稳定版(修 bug + CI/CD + .env fallback)
- [x] **v0.2.1** — 彻底修复"假成功"问题(移除 CreateObject fallback)
- [x] **v0.2.2** — 渲染层加固(IPC 错误归一化 + 主题色 token)
- [x] **v0.2.3** — CI 质量门(每次 PR / push 跑 typecheck + lint + test)
- [x] **v0.2.4** — **Python 边车架构(P3)**——结构化工具返回、视觉管线、agent 循环重写
- [ ] **v0.3.0** — 强制边车作为装机依赖(干掉 VBS fallback)、所有 `# VERIFY` 工具在真实 SW 版本上跑过验证
- [ ] **v0.4.0** — MCP Server 适配器(让 Claude Code / Cursor 直接驱动 SW Copilot)
- [ ] **v1.0.0** — 多 CAD 适配器(Inventor、CATIA、NX、Onshape)+ 商业授权轨道

---

## 许可证

[Apache License 2.0](LICENSE)——宽松开源。可用、可改、可塞进商业产品。署不署名都欢迎,不强求;带专利授权;无 copyleft。

---

## 致谢

- SolidWorks COM API 参考:[CodeStack](https://www.codestack.net/) SolidWorks API 文档
- MCP 生态:[SolidworksMCP-TS](https://github.com/vespo92/SolidworksMCP-TS)、[SolidPilot](https://github.com/eyfel/mcp-server-solidworks)
- 灵感来源:Cursor、Claude Code、MecAgent,以及每一个手写过 FeatureExtrusion3 调用的工程师