<p align="center">
  <img src="assets/banner-hero.png" alt="Millwright — 让 AI 操作 SolidWorks，而不是写代码" />
</p>

<p align="center">
  <img src="assets/icon-512.png" width="96" height="96" alt="Millwright" />
</p>

<h1 align="center">Millwright</h1>

<p align="center">
  <strong>让 AI 直接操作 SolidWorks —— 而不是生成宏。</strong>
</p>

<p align="center">
  开源的 SolidWorks AI 工作台，通过原生工具调用、结构化推理和真实的视觉反馈闭环，直接驱动 SolidWorks 完成建模。
</p>

<p align="center">
  <a href="#为什么选-millwright">为什么选 Millwright</a> ·
  <a href="#核心特性">核心特性</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#支持的-ai-服务商">AI 服务商</a> ·
  <a href="https://github.com/raylanlin/Millwright/blob/master/docs/ARCHITECTURE.md">技术架构</a> ·
  <a href="https://github.com/raylanlin/Millwright/blob/master/docs/CONTRIBUTING.md">参与贡献</a> ·
  <a href="README.md">English</a>
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

## 不再生成宏

大部分 AI CAD 助手会生成 VBA 或 Python 脚本，然后让你自己复制、粘贴、调试、运行。

Millwright 不这样做。它直接调用约 **50 个原生 SolidWorks 工具**——草图、特征、装配、导出、查询——一步一步地调用。每次调用都返回结构化结果，AI 读取结果后决定下一步做什么。不用改宏，也不用猜有没有生效。

```
你：  帮我做一个带四个 M6 孔的安装支架。

Millwright：
  ✓ 创建草图
  ✓ 矩形 (80 × 50)
  ✓ 凸台拉伸 (10 mm)
  ✓ 孔向导 × 4
  ✓ 添加圆角
  ✓ 截取视口
  ✓ 视觉核验
  完成。
```

**AI 后端由你决定。** Claude、GPT-4o、DeepSeek、Kimi、MiniMax、Qwen、GLM，或本地 Ollama —— 任何支持 Anthropic 或 OpenAI 兼容协议的模型都行。代码开源，你只需支付自己的 API 费用。

|         | 常见 CAD AI SaaS       | **Millwright**             |
| ------- | -------------------- | --------------------------- |
| 自动化方式   | 提示词 → 一次性宏，需人工粘贴运行   | **可自我纠正的 agent 工具循环**       |
| AI 后端   | 按套餐固定                | **任你选择（自带 API Key）**        |
| 价格      | $16–417 / 月          | **免费 —— 开源**                |
| 源代码     | 闭源                    | **开源（Apache-2.0）**          |
| 结果核验    | 无                     | **截取模型视口并进行视觉推理**            |
| SolidWorks 版本 | 通常锁定单一版本         | **运行时自动跨版本适配**              |

## 为什么选 Millwright

[#为什么选-millwright](#为什么选-millwright)

- 🛠 **真正的工具直驱，不是代码生成。** AI 不输出让你复制粘贴的宏，而是直接调用原生 SolidWorks 工具，每步根据上一步的结构化结果决定下一步。
- ⚙️ **双引擎架构。** Python 边车走 COM 早绑定，拿到完整能力；边车起不来时自动降级到内置 VBScript 引擎，并在聊天里明写降级原因——不静默缩水。
- 🔀 **跨版本自适应。** SolidWorks 的 COM API 在不同版本间参数个数和成员名都会变。工具会自动搜索可用签名、遇成员缺失降级动态调度、切除方向自动试探——不靠硬编码某个版本。
- 👁 **眼见为实的视觉闭环。** AI 能截图看模型：多模态主模型直接读图，纯文本模型则接一个视觉模型作答，还能对同一张截图连续追问。建完特征自己看一眼确认，出错先看图再动手。
- 🔒 **安全边界。** 破坏性操作弹确认卡片（带工具名和完整参数），不点不执行；执行前自动备份文档；脚本经黑名单校验；CAD 文件从不外传，只发文本。
- 📦 **零外部依赖安装。** installer 内置 Python 运行时和 pywin32，装完即用。
- 🔌 **协议无关。** Anthropic / OpenAI 兼容双协议，原生 fetch + 手写 SSE，不锁任何厂商——接 DeepSeek、MiniMax、GLM 都一样。

## 核心特性

[#核心特性](#核心特性)

- **原生 Function Calling。** 工具通过标准 `tools` 接口注入模型，而非塞进提示词——单一真源，工具自我描述。
- **Agent 工具循环。** 观察 → 推理 → 执行。模型串联多次工具调用，读取每次返回的结构化 JSON，出错能自愈而不是静默失败。
- **视觉理解。** 可翻转、旋转、截屏，再做分析——既支持多模态主模型，也支持独立视觉模型。
- **常驻执行引擎。** 常驻 Python 边车在一整个多步任务中复用同一条 COM 连接。
- **开发者友好。** 167 个 TS/Node 单元测试，另有独立的 Python 测试套件（`pytest sidecar/tests`），类型化 IPC 边界，`SKIP_SW_CONNECT` 纯 UI 开发模式（无需 SolidWorks）。

## 跨版本兼容

[#跨版本兼容](#跨版本兼容)

SolidWorks 的 COM API 在不同版本间并不稳定：方法签名会变、可选参数会增减、枚举值会演进、成员名会不一样。硬编码某一个版本行不通。

```
工具请求 → 签名探测 → 可用 COM 成员 → 动态调度 → 执行
```

Millwright 在运行时探测当前机器可用的最佳 API，而不是假设固定版本，能自动处理不同的参数个数、缺失的 COM 成员、多个重载候选、以及不同的拉伸方向。一套运行时，无需针对版本单独打包。

这不是纸面上的设计，而是针对真机反馈持续加固的结果——例如 `cut_extrude` 和 `extrude` 现在会在运行时搜索参数个数和签名变体，直到成功为止，自动收敛到当前机器 SolidWorks 版本所需要的形式。目前已通过宏录制器核验的多参 API 有 `add_mate`、文档/模板常量、草图基元、`chamfer`；还有 `revolve`、`fillet_edges`、`shell`、`linear_pattern`、`circular_pattern`、`mirror_feature`、`create_reference_point`、`export_stl` 等十项，记录在[待核验清单](https://github.com/raylanlin/Millwright/blob/master/docs/VERIFY-ISSUES.md)里，欢迎真机核对后提交反馈。

## 默认开启的安全机制

[#默认开启的安全机制](#默认开启的安全机制)

AI 不应该被允许悄悄破坏 CAD 数据。

```
删除特征 → 确认卡片 → 用户批准 → 自动备份 → 执行
```

- **确认门。** 删特征/删实体/删草图、替换零部件、覆盖导出等破坏性操作，会展示工具名和完整参数，需要明确点击才会执行。
- **自动备份。** 任何破坏性操作前都会自动备份当前文档，随时可以恢复。
- **脚本校验。** 旧版 VBScript 执行前会经过黑名单校验和危险 API 检测。
- **本地优先。** CAD 文件从不离开你的机器——只有推理所需的最少文本上下文会发给 AI 服务商。

## 视觉反馈闭环

[#视觉反馈闭环](#视觉反馈闭环)

大多数 CAD 自动化在 API 调用返回的那一刻就结束了。Millwright 会继续往下走——它真的会看一眼模型。

```
创建特征 → 截取视口 → 视觉模型 → 与需求比对 → 是否需要修改？ → 继续编辑
```

- **多模态主模型**（Claude、GPT-4o、Gemini、Qwen-VL 等）：截图直接进模型上下文，不用额外一步。
- **纯文本主模型：** 截图会转发给独立的视觉模型，其描述再喂回规划器——纯文本模型也能理解 CAD 几何。

## 快速开始

[#快速开始](#快速开始)

### 安装

[#安装](#安装)

1. 从 [Releases](https://github.com/raylanlin/millwright/releases) 下载安装包并运行。
2. 安装边车运行时（用于驱动 SolidWorks）：
   ```bash
   pip install pywin32 pillow
   ```
   > 未装 Python 时应用仍可运行，会自动回退到旧的 VBScript 引擎 —— 但会失去结构化结果与视觉理解。强烈建议安装 Python。

### 从源码运行

[#从源码运行](#从源码运行)

```bash
git clone https://github.com/raylanlin/millwright.git
cd millwright
npm install
npm run dev
```

> 纯 UI 开发无需 SolidWorks：设置 `SKIP_SW_CONNECT=true`。

### 配置

[#配置](#配置)

1. 先启动 SolidWorks，再启动 Millwright。
2. 打开 ⚙️ **设置** → 选择协议 → 填入 Base URL、API Key、模型名 → **保存**。
3. （可选）开启**视觉**：勾选「主模型支持图像」，或单独配置一个视觉模型。

## 支持的 AI 服务商

[#支持的-ai-服务商](#支持的-ai-服务商)

| 服务商         | 协议        | Base URL                                            | 推荐模型                                |
| ----------- | --------- | --------------------------------------------------- | ----------------------------------- |
| DeepSeek    | OpenAI 兼容 | `https://api.deepseek.com`                          | `deepseek-v4-pro`                   |
| Kimi / 月之暗面 | OpenAI 兼容 | `https://api.moonshot.cn/v1`                        | `kimi-k3`                           |
| MiniMax     | OpenAI 兼容 | `https://api.minimaxi.com/v1`                       | `minimax-m3`                        |
| Anthropic   | Anthropic | `https://api.anthropic.com`                         | `claude-sonnet-5` / `claude-opus-5` |
| OpenAI      | OpenAI    | `https://api.openai.com/v1`                         | `gpt-5.6`                           |
| 阿里百炼 (Qwen) | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-3.8max`                       |
| 智谱 (GLM)    | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4`               | `glm-4.6`                           |
| 硅基流动        | OpenAI 兼容 | `https://api.siliconflow.cn/v1`                     | —                                   |
| Ollama（本地）  | OpenAI 兼容 | `http://localhost:11434/v1`                         | —                                   |

> Agent 工具调用需要模型支持 function calling。DeepSeek、Kimi K3、MiniMax M3、GLM-4.6 是一等公民。

## 使用示例

[#使用示例](#使用示例)

```
你: 在前视基准面画一个 50×30 的矩形，拉伸 20mm
AI: create_sketch(front) → sketch_rectangle(50,30) → extrude(20)  ✓  零件已创建

你: 这个零件多重？包络多大？
AI: mass_properties → bounding_box  ✓  0.42 kg · 50 × 30 × 20 mm

你: 从等轴测看看，比例协调吗？
AI: set_view_orientation(isometric) → analyze_view("比例是否协调？")  ✓

你: 把模型里所有圆角改成 3mm
AI: fillet_all(3)  → 确认？ → ✓  更新了 6 个圆角
```

## 工作原理

[#工作原理](#工作原理)

```
渲染层 (React UI)
      │  IPC
主进程 (Electron / Node)
      │  agent 循环  ──  原生 function-calling 工具注入模型
      │      ├─ 工具来源与执行 = 边车（结构化 JSON 出入）
      │      └─ analyze_view ─┬─ 独立视觉模型（图生文）
      │                       └─ 或多模态主模型（图像直喂）
      │  stdio 上的 JSON-RPC
Python 边车（常驻）  ──  pywin32 → SolidWorks COM API
      │
SolidWorks
```

- **结构化、可观测的工具。** 每个工具返回 `{ ok, data | error }` JSON，模型能读到真实状态（特征树、尺寸、质量、干涉）来规划下一步。
- **保留旧路径。** Python 边车无法启动时，自动回退原 VBScript 引擎，绝不硬崩。
- **LLM 访问零 SDK 依赖**：原生 `fetch` + 手写 SSE 解析。

详见 [docs/ARCHITECTURE.md](https://github.com/raylanlin/Millwright/blob/master/docs/ARCHITECTURE.md)。

## 系统要求

[#系统要求](#系统要求)

- Windows 10/11 (64-bit)
- SolidWorks 2017+
- Python 3.9+（含 `pywin32`、`pillow`；installer 已内置，从源码运行时需手动安装）
- Node.js 20+（仅开发模式）

## 文档

[#文档](#文档)

| 文档                                                                | 内容             |
| ----------------------------------------------------------------- | -------------- |
| [技术架构](https://github.com/raylanlin/Millwright/blob/master/docs/ARCHITECTURE.md)    | 系统设计、模块、数据流    |
| [用户手册](https://github.com/raylanlin/Millwright/blob/master/docs/USER-GUIDE.md)      | 安装、配置、FAQ      |
| [开发者指南](https://github.com/raylanlin/Millwright/blob/master/docs/DEVELOPMENT.md)    | 代码结构、约定、测试     |
| [API 参考](https://github.com/raylanlin/Millwright/blob/master/docs/API-REFERENCE.md) | LLM 接口、工具清单    |
| [贡献指南](https://github.com/raylanlin/Millwright/blob/master/docs/CONTRIBUTING.md)    | 如何参与           |
| [待核验清单](https://github.com/raylanlin/Millwright/blob/master/docs/VERIFY-ISSUES.md)  | 待宏录制器核验的多参 API |
| [变更记录](https://github.com/raylanlin/Millwright/blob/master/CHANGELOG.md)            | 版本历史           |
| [安全策略](https://github.com/raylanlin/Millwright/blob/master/SECURITY.md)             | 安全规范与漏洞报告      |

## 参与贡献

[#参与贡献](#参与贡献)

欢迎贡献 —— 详见 [CONTRIBUTING.md](https://github.com/raylanlin/Millwright/blob/master/docs/CONTRIBUTING.md)。我们尤其欢迎：

- 🧪 真实 SolidWorks 环境的测试报告（以及对[待核验 API](https://github.com/raylanlin/Millwright/blob/master/docs/VERIFY-ISSUES.md) 的宏录制器核对）
- 🔨 新的边车工具（`sidecar/sw_agent/tools/`）
- 🎨 UI/UX 改进
- 🌐 其他 CAD 适配（Inventor、CATIA、NX）与 MCP server 集成
- 📝 文档与翻译

## 路线图

[#路线图](#路线图)

- [x] **v0.1** — MVP：Electron + LLM 适配器 + VBS/COM 桥接 + 首批工具
- [x] **v0.2** — Python 边车、agent 工具循环、双引擎降级、视觉反馈、确认卡片，Apache-2.0 开源
- [x] **v0.2.4 → v0.2.37** — 大量真机加固 ← *当前*：COM 早绑定、`extrude`/`cut_extrude` 跨版本参数自适应搜索、确认卡片幂等化、边车启动失败时的降级说明、截图改为 PNG、可配置的最大工具轮数
- [ ] **v0.3** — 工具全覆盖、剩余 `# VERIFY` 参数在真机上完成核验、流式工具调用
- [ ] **v1.0** — MCP server、多 CAD 支持

> Millwright 还很年轻、迭代很快——目前大多数版本都是在修复真实 SolidWorks 安装环境反馈的 COM 绑定与跨版本问题，详见 [CHANGELOG.md](CHANGELOG.md) 和[待核验清单](https://github.com/raylanlin/Millwright/blob/master/docs/VERIFY-ISSUES.md)。

## 关于名字

[#关于名字](#关于名字)

**Millwright**（名词）—— 安装、维护并操作机械设备的技工。这正是本工具扮演的角色：站在你 SolidWorks 工作台前的 AI 机械技工。

## 许可证

[#许可证](#许可证)

[Apache-2.0](https://github.com/raylanlin/Millwright/blob/master/LICENSE) —— 宽松协议，含明确的专利授权。允许商业使用。

## 致谢

[#致谢](#致谢)

- SolidWorks COM API 参考：[CodeStack](https://www.codestack.net/)
- 灵感来源：Cursor、Claude Code

<sub>SolidWorks 是 Dassault Systèmes 的注册商标。Millwright 是独立开源项目，与 Dassault Systèmes 无从属或背书关系。</sub>
