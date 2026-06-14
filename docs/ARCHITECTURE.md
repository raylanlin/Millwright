# SW Copilot — 技术设计文档

> SolidWorks AI 自动化助手 · 技术方案 v0.2 · 2026-04-29

---

## 1. 项目概述

### 1.1 产品定位

SW Copilot 是一款开源的 SolidWorks AI 自动化助手，用户通过自然语言描述操作需求，AI 自动生成并执行 SolidWorks 宏脚本。与 MecAgent 等商业方案不同，SW Copilot 允许用户自由选择 AI 后端（Anthropic / OpenAI / 百炼 / MiniMax / DeepSeek 等），无需绑定特定服务商。

### 1.2 核心能力

- 自然语言驱动的 SolidWorks 自动化操作
- 支持 Anthropic 协议和 OpenAI 兼容协议，可接入任意大模型
- 通过 COM 接口直接操控 SolidWorks，零插件安装
- VBA 宏和 Python 脚本双模式生成
- 内置常用自动化模板库
- 浅色 / 深色双主题 UI

### 1.3 技术栈总览

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 桌面框架 | Electron 28+ | 跨版本 Windows 兼容 |
| 前端 | React 18 + TypeScript | 聊天 UI、设置面板 |
| 后端逻辑 | Node.js (Main Process) | API 调用、脚本管理 |
| COM 桥接 | cscript.exe + VBScript | 零原生依赖连接 SolidWorks COM API |
| AI 接口 | 原生 fetch + 手写 SSE | 双协议支持，无 SDK 依赖 |
| 打包分发 | electron-builder + Squirrel | 自动更新 |
| 脚本执行 | cscript/VBS > Python > COM RunMacro2 | 三级 fallback 执行 |

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                    Electron 应用                         │
│  ┌─────────────────┐    ┌────────────────────────────┐  │
│  │   Renderer       │    │   Main Process             │  │
│  │   (React UI)     │◄──►│                            │  │
│  │                  │IPC │  ┌──────────────────────┐  │  │
│  │  • 聊天界面       │    │  │  LLM Service          │  │  │
│  │  • 设置面板       │    │  │  • Anthropic 客户端    │  │  │
│  │  • 自动化模板     │    │  │  • OpenAI 客户端       │  │  │
│  │  • 工具状态       │    │  │  • 消息构建 & 流式输出 │  │  │
│  │                  │    │  └──────────┬───────────┘  │  │
│  └─────────────────┘    │             │              │  │
│                          │  ┌──────────▼───────────┐  │  │
│                          │  │  Script Engine        │  │  │
│                          │  │  • VBA 宏生成          │  │  │
│                          │  │  • Python 脚本生成     │  │  │
│                          │  │  • 安全校验 & 沙箱     │  │  │
│                          │  └──────────┬───────────┘  │  │
│                          │             │              │  │
│                          │  ┌──────────▼───────────┐  │  │
│                          │  │  COM Bridge           │  │  │
│                          │  │  • SolidWorks 连接     │  │  │
│                          │  │  • 宏注入执行          │  │  │
│                          │  │  • 状态监控            │  │  │
│                          │  └──────────┬───────────┘  │  │
│                          └─────────────┼──────────────┘  │
└────────────────────────────────────────┼────────────────┘
                                         │ COM / win32com
                              ┌──────────▼───────────┐
                              │    SolidWorks         │
                              │    (已运行实例)         │
                              └──────────────────────┘
```

### 2.2 核心模块说明

#### LLM Service（AI 服务层）

负责与大模型 API 通信。支持两种协议：

- **Anthropic 协议**：手写 fetch + SSE 流式解析，支持 Claude 全系列模型
- **OpenAI 兼容协议**：手写 fetch + SSE 流式解析，支持 GPT、百炼、MiniMax、DeepSeek、Qwen 等所有兼容 OpenAI 格式的服务

关键设计：零 SDK 依赖，协议切换只需更改 `baseURL`、`apiKey` 和 `model` 三个参数，无需重启应用。

#### Script Engine（脚本引擎）

将 AI 输出转换为可执行脚本：

- 解析 AI 返回中的代码块（VBA / Python）
- 执行安全校验（禁止文件删除、注册表修改等危险操作）
- 支持脚本保存、复用、参数化模板

#### COM Bridge（COM 桥接层）

管理与 SolidWorks 的连接：

- 通过 `SldWorks.Application` ProgID 自动发现运行中的 SolidWorks
- 封装常用操作为工具函数（创建零件、拉伸、倒角等）
- 心跳检测：定时检查 SolidWorks 是否仍在运行

---

## 3. AI 接口设计

### 3.1 双协议适配器

```typescript
// src/main/llm/adapter.ts

interface LLMConfig {
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
}

interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

class LLMAdapter {
  private config: LLMConfig;

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    if (this.config.protocol === 'anthropic') {
      return this.callAnthropic(messages);
    } else {
      return this.callOpenAI(messages);
    }
  }

  private async callAnthropic(messages: LLMMessage[]): Promise<LLMResponse> {
    const response = await fetch(`${this.config.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        system: this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        messages: messages.filter(m => m.role !== 'system'),
      }),
    });
    const data = await response.json();
    return this.parseAnthropicResponse(data);
  }

  private async callOpenAI(messages: LLMMessage[]): Promise<LLMResponse> {
    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
          ...messages,
        ],
      }),
    });
    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }
}
```

### 3.2 系统提示词设计

```typescript
const DEFAULT_SYSTEM_PROMPT = `你是一个 SolidWorks 自动化专家助手。

## 你的能力
- 生成 SolidWorks VBA 宏脚本
- 生成 Python + win32com 自动化脚本
- 理解用户对 CAD 操作的自然语言描述
- 调用 SolidWorks API 完成建模、修改、导出等操作

## 输出规范
- 代码用 \`\`\`vba 或 \`\`\`python 标记
- 每个脚本必须包含错误处理
- 在执行前说明脚本将做什么
- 对危险操作（如删除特征、覆盖文件）必须先确认

## SolidWorks API 要点
- 通过 COM 接口连接：SldWorks.Application
- 活动文档：swApp.ActiveDoc
- 特征遍历：ModelDoc2.FirstFeature → Feature.GetNextFeature
- 选择实体：ModelDoc2.Extension.SelectByID2
- 尺寸修改：Dimension.SetSystemValue3

## 安全规则
- 禁止生成删除文件或修改注册表的代码
- 禁止访问网络或执行系统命令
- 所有文件操作限制在用户指定目录内
`;
```

### 3.3 兼容服务商配置示例

| 服务商 | 协议 | Base URL | 模型示例 |
|--------|------|----------|----------|
| Anthropic | anthropic | https://api.anthropic.com | claude-sonnet-4-20250514 |
| OpenAI | openai | https://api.openai.com/v1 | gpt-4o |
| 百炼 | openai | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-coder-plus |
| MiniMax | openai | https://api.minimax.chat/v1 | MiniMax-Text-01 |
| DeepSeek | openai | https://api.deepseek.com | deepseek-chat |
| 硅基流动 | openai | https://api.siliconflow.cn/v1 | deepseek-ai/DeepSeek-V3 |
| Ollama 本地 | openai | http://localhost:11434/v1 | qwen2.5-coder:32b |

---

## 4. COM 桥接层

### 4.1 SolidWorks 连接管理

```typescript
// src/main/com/sw-bridge.ts

class SolidWorksBridge {
  // 通过 cscript.exe 执行 VBScript 连接 SolidWorks
  // GetObject → CreateObject 自动 fallback
  // VBS 文件使用 UTF-16LE+BOM 编码（解决中文兼容）
  async connect(): Promise<boolean> {
    // 执行 VBS 探测脚本，通过 GetObject(, "SldWorks.Application") 连接
    // 无需 winax 等原生模块
  }

  isConnected(): boolean {
    if (!this.swApp) return false;
    try {
      // 心跳检测：尝试读取版本号
      const version = this.swApp.RevisionNumber();
      return !!version;
    } catch {
      this.connected = false;
      return false;
    }
  }

  getActiveDocument(): any {
    return this.swApp?.ActiveDoc;
  }

  async runVBAMacro(code: string): Promise<{ success: boolean; output: string }> {
    // 写入临时 .swp 文件并执行
    const tempPath = path.join(os.tmpdir(), `sw_macro_${Date.now()}.swp`);
    fs.writeFileSync(tempPath, code);
    try {
      const result = this.swApp.RunMacro2(tempPath, '', 'main', 1, 0);
      return { success: result === 0, output: '' };
    } finally {
      fs.unlinkSync(tempPath);
    }
  }

  async runPythonScript(code: string): Promise<{ success: boolean; output: string }> {
    const tempPath = path.join(os.tmpdir(), `sw_script_${Date.now()}.py`);
    fs.writeFileSync(tempPath, code);
    return new Promise((resolve) => {
      exec(`python "${tempPath}"`, (error, stdout, stderr) => {
        fs.unlinkSync(tempPath);
        resolve({
          success: !error,
          output: stdout || stderr,
        });
      });
    });
  }
}
```

### 4.2 工具函数注册

```typescript
// 注册为 AI 可调用的工具
const SW_TOOLS = [
  {
    name: 'create_part',
    description: '创建新的 SolidWorks 零件文档',
    parameters: {},
    execute: async (bridge: SolidWorksBridge) => {
      return bridge.swApp.NewDocument(
        bridge.swApp.GetUserPreferenceStringValue(21), // 默认零件模板
        0, 0, 0
      );
    },
  },
  {
    name: 'create_sketch',
    description: '在指定平面创建草图',
    parameters: { plane: 'Front | Top | Right' },
    execute: async (bridge: SolidWorksBridge, params: any) => {
      const doc = bridge.getActiveDocument();
      const planeMap = { Front: 'Front Plane', Top: 'Top Plane', Right: 'Right Plane' };
      doc.Extension.SelectByID2(planeMap[params.plane], 'PLANE', 0, 0, 0, false, 0, null, 0);
      doc.SketchManager.InsertSketch(true);
    },
  },
  {
    name: 'extrude_feature',
    description: '将当前草图拉伸为实体特征',
    parameters: { depth: 'number (mm)' },
    execute: async (bridge: SolidWorksBridge, params: any) => {
      const doc = bridge.getActiveDocument();
      doc.FeatureManager.FeatureExtrusion3(
        true, false, false, 0, 0,
        params.depth / 1000, 0,  // 转换为米
        false, false, false, false,
        0, 0, false, false, false, false,
        true, true, true, 0, 0, false
      );
    },
  },
  // ... 更多工具定义
];
```

---

## 5. 安全机制

### 5.1 脚本沙箱

所有 AI 生成的脚本在执行前经过安全校验：

```typescript
class ScriptSanitizer {
  private BLOCKED_PATTERNS = [
    /kill|taskkill|shutdown/i,           // 进程终止
    /del\s|rmdir|remove-item/i,          // 文件删除
    /reg\s+add|reg\s+delete/i,           // 注册表
    /net\s+user|net\s+localgroup/i,      // 用户管理
    /invoke-webrequest|curl|wget/i,      // 网络请求
    /set-executionpolicy/i,              // 安全策略
    /format\s+[a-z]:/i,                  // 磁盘格式化
  ];

  validate(code: string): { safe: boolean; issues: string[] } {
    const issues: string[] = [];
    for (const pattern of this.BLOCKED_PATTERNS) {
      if (pattern.test(code)) {
        issues.push(`检测到潜在危险操作: ${pattern.source}`);
      }
    }
    return { safe: issues.length === 0, issues };
  }
}
```

### 5.2 用户确认机制

- 所有生成的脚本先展示给用户预览
- 修改几何特征、删除特征等操作需要二次确认
- 批量操作显示影响范围预估

### 5.3 数据隐私

- API Key 存储在本地 `electron-store`，加密存储
- 不上传任何 CAD 文件到外部服务器
- AI 对话仅发送文本描述，不发送模型数据

---

## 6. 项目结构

```
sw-copilot/
├── package.json
├── electron-builder.yml          # 打包配置
├── tsconfig.json
├── src/
│   ├── main/                     # Electron 主进程
│   │   ├── index.ts              # 应用入口
│   │   ├── ipc.ts                # IPC 通信处理
│   │   ├── llm/
│   │   │   ├── adapter.ts        # LLM 双协议适配器
│   │   │   ├── anthropic.ts      # Anthropic 客户端
│   │   │   ├── openai.ts         # OpenAI 兼容客户端
│   │   │   └── prompts.ts        # 系统提示词
│   │   ├── com/
│   │   │   ├── sw-bridge.ts      # SolidWorks COM 桥接
│   │   │   ├── tools.ts          # 工具函数注册
│   │   │   └── health.ts         # 连接心跳检测
│   │   ├── scripts/
│   │   │   ├── engine.ts         # 脚本执行引擎
│   │   │   ├── sanitizer.ts      # 安全校验
│   │   │   └── templates/        # 预置自动化模板
│   │   │       ├── batch-fillet.vba
│   │   │       ├── export-pdf.py
│   │   │       ├── batch-rename.vba
│   │   │       └── bom-export.py
│   │   └── store/
│   │       └── config.ts         # 持久化配置（加密）
│   ├── renderer/                 # Electron 渲染进程
│   │   ├── App.tsx               # 应用根组件
│   │   ├── components/
│   │   │   ├── Chat.tsx          # 聊天界面
│   │   │   ├── Settings.tsx      # 设置面板
│   │   │   ├── Automations.tsx   # 自动化模板
│   │   │   ├── ToolsList.tsx     # 工具列表
│   │   │   └── StatusBar.tsx     # 状态栏
│   │   ├── hooks/
│   │   │   ├── useTheme.ts       # 主题管理
│   │   │   └── useLLM.ts         # AI 调用 hook
│   │   └── themes/
│   │       ├── light.ts          # 浅色主题
│   │       └── dark.ts           # 深色主题
│   └── shared/
│       └── types.ts              # 共享类型定义
├── assets/
│   ├── icon.ico                  # 应用图标
│   └── icon.png
├── scripts/
│   └── notarize.js               # macOS 公证（如需）
└── docs/
    ├── ARCHITECTURE.md           # 本文档
    ├── USER-GUIDE.md             # 用户手册
    ├── API-REFERENCE.md          # API 参考
    └── CONTRIBUTING.md           # 贡献指南
```

---

## 7. 构建与分发

### 7.1 开发环境搭建

```bash
# 前置依赖
node >= 20.0.0
npm >= 10.0.0
python >= 3.10
SolidWorks 2017+（已安装并至少运行过一次）

# 初始化项目
git clone https://github.com/yourname/sw-copilot.git
cd sw-copilot
npm install
npm run dev          # 启动开发模式（热重载）
```

### 7.2 打包配置

```yaml
# electron-builder.yml
appId: com.swcopilot.app
productName: SW Copilot
win:
  target:
    - target: nsis
      arch: [x64]
    - target: squirrel
  icon: assets/icon.ico
squirrelWindows:
  iconUrl: https://your-cdn.com/icon.ico
nsis:
  oneClick: true
  allowToChangeInstallationDirectory: false
publish:
  provider: github
  owner: raylanlin
  repo: sw-copilot
```

### 7.3 构建命令

```bash
npm run build         # 编译 TypeScript
npm run pack          # 打包为可执行文件
npm run dist          # 生成安装包 + 自动更新文件
```

产出物：
- `SW Copilot Setup x.x.x.exe`（NSIS 安装包）
- `sw-copilot-x.x.x-full.nupkg`（Squirrel 更新包）
- `RELEASES`（版本索引）

与 MecAgent 的打包结构完全一致。

---

## 8. 开发路线图

- [x] **v0.1.0** — MVP 基础架构（Electron + LLM + COM + 26 Tools）
- [x] **v0.2.0** — 稳定版（Bug 修复 + CI/CD + .env fallback + 文档完善）
- [x] **v0.2.1** — 假成功问题彻底修复（移除 CreateObject fallback + vbaToVbs 重写）
- [x] **v0.2.2** — 渲染层修复（IPC 错误归一化 + 主题色 token + 滚动行为）
- [x] **v0.2.3** — 新增 CI 质量门（PR/push 跑 typecheck + lint + test）← *当前*
- [ ] **v0.3.0** — 高级特性（视觉感知 + Agent Loop + Function Calling）
- [ ] **v1.0.0** — 生态建设（MCP Server + 多 CAD + 商业授权）

---

## 9. 与 MecAgent 的技术对比

| 维度 | MecAgent | SW Copilot |
|------|----------|------------|
| 架构 | Electron + 私有 AI | Electron + 开放 AI |
| AI 后端 | 固定（按套餐分级） | 用户自选（任意模型） |
| 协议 | 私有 | Anthropic + OpenAI 标准协议 |
| COM 桥接 | winax / COM | cscript.exe + VBScript（零原生依赖）|
| 安全校验 | 未知 | 开源可审计 |
| 自动化模板 | 有（含社区库） | 有（可扩展） |
| 定价 | $16-417/月 | 免费（用户自付 API 费用） |
| 源代码 | 闭源 | 开源 GPLv3 |

---

## 附录 A：关键依赖版本

```json
{
  "electron": "^28.0.0",
  "react": "^18.2.0",
  "typescript": "^5.3.0",
  # 零 SDK 依赖：LLM 通信使用原生 fetch + SSE
  "electron-store": "^8.1.0",
  "electron-builder": "^24.9.0"
}
```

## 附录 B：SolidWorks COM API 常用接口速查

| 接口 | 说明 | 示例 |
|------|------|------|
| `SldWorks.Application` | 应用程序入口 | 获取/创建 SW 实例 |
| `ModelDoc2` | 文档对象 | 零件/装配体/工程图 |
| `FeatureManager` | 特征管理器 | 拉伸/旋转/阵列 |
| `SketchManager` | 草图管理器 | 线/圆/矩形 |
| `SelectionMgr` | 选择管理器 | 获取选中实体 |
| `DimensionData` | 尺寸数据 | 修改参数化尺寸 |
| `AssemblyDoc` | 装配体 | 插入组件/添加配合 |
| `DrawingDoc` | 工程图 | 视图/标注/BOM |
| `ModelDocExtension` | 扩展方法 | 保存/导出/选择 |
