# SW Copilot — 用户手册

> 版本 0.2.0 · 2026-04-28

---

## 快速开始

### 系统要求

- Windows 10 / 11（64 位）
- SolidWorks 2017 或更高版本（已安装并激活许可证）
- Node.js 20+（开发模式需要）
- 至少一个 AI API 账号（Anthropic / OpenAI / 百炼 / MiniMax / DeepSeek 等）

### 安装步骤

1. 从 GitHub Releases 下载最新版 `SW Copilot Setup x.x.x.exe`
2. 双击运行安装程序，按提示完成安装
3. 安装完成后桌面会出现 SW Copilot 图标

### 首次配置

1. 先启动 SolidWorks，打开或新建一个文件
2. 启动 SW Copilot
3. 检查左侧边栏状态区域，确认 SolidWorks 显示为「已连接」
4. 点击左下角「⚙️ 设置」按钮
5. 选择 API 协议并填入配置信息（详见下节）
6. 点击「测试连接」确认 API 可用
7. 点击「保存」

---

## 配置 AI 服务

### 方式一：使用 Anthropic（Claude）

如果你有 Anthropic API Key：

| 配置项 | 值 |
|--------|-----|
| API 协议 | Anthropic |
| Base URL | https://api.anthropic.com |
| API Key | 你的 sk-ant-... 密钥 |
| 模型 | claude-sonnet-4-20250514（推荐） |

获取 API Key：前往 console.anthropic.com 注册并创建密钥。

### 方式二：使用 OpenAI

| 配置项 | 值 |
|--------|-----|
| API 协议 | OpenAI 兼容 |
| Base URL | https://api.openai.com/v1 |
| API Key | 你的 sk-... 密钥 |
| 模型 | gpt-4o |

### 方式三：使用百炼（阿里云）

| 配置项 | 值 |
|--------|-----|
| API 协议 | OpenAI 兼容 |
| Base URL | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| API Key | 你的百炼 API Key |
| 模型 | 选「自定义模型」，填入 qwen-coder-plus |

### 方式四：使用 MiniMax

| 配置项 | 值 |
|--------|-----|
| API 协议 | OpenAI 兼容 |
| Base URL | https://api.minimax.chat/v1 |
| API Key | 你的 MiniMax API Key |
| 模型 | 选「自定义模型」，填入 MiniMax-Text-01 |

### 方式五：使用 DeepSeek

| 配置项 | 值 |
|--------|-----|
| API 协议 | OpenAI 兼容 |
| Base URL | https://api.deepseek.com |
| API Key | 你的 DeepSeek API Key |
| 模型 | 选「自定义模型」，填入 deepseek-chat |

### 方式六：使用本地模型（Ollama）

无需 API Key，完全离线运行：

1. 安装 Ollama：https://ollama.com
2. 拉取模型：`ollama pull qwen2.5-coder:32b`
3. 配置 SW Copilot：

| 配置项 | 值 |
|--------|-----|
| API 协议 | OpenAI 兼容 |
| Base URL | http://localhost:11434/v1 |
| API Key | ollama（任意字符串即可） |
| 模型 | 选「自定义模型」，填入 qwen2.5-coder:32b |

---

## 使用界面

### 主界面布局

```
┌────────┬──────────────────────────────┐
│ 侧边栏  │          主内容区              │
│        │                              │
│ Logo   │    对话消息 / 自动化 / 工具     │
│ 状态    │                              │
│        │                              │
│ 💬 对话 │                              │
│ ⚡ 自动化│                              │
│ 🔧 工具 │                              │
│        │                              │
│        │──────────────────────────────│
│ 主题切换 │          输入框               │
│ ⚙ 设置  │                              │
└────────┴──────────────────────────────┘
```

### 对话界面

在输入框中用自然语言描述你想执行的操作，例如：

- 「把所有圆角半径改成 3mm」
- 「导出当前零件为 STEP 和 PDF」
- 「在前视面画一个 50×30 的矩形然后拉伸 20mm」
- 「批量重命名装配体里的零件，加上前缀 PROJ-2026-」
- 「检查装配体有没有干涉」
- 「导出 BOM 表到 Excel」

AI 会生成对应的 VBA 宏或 Python 脚本，展示代码预览后等待你确认执行。

### 快捷自动化

点击侧边栏「⚡ 自动化」可以看到预置的常用操作卡片，点击即可快速填入对话框执行。

### 工具列表

点击侧边栏「🔧 工具列表」可以查看当前注册的所有 SolidWorks COM 工具，了解 AI 可以调用哪些能力。

---

## 自定义系统提示词

在设置面板的「系统提示词」中，你可以自定义 AI 的行为。例如：

### 限定输出语言

```
你必须始终使用中文回答。生成的代码注释也使用中文。
```

### 限定脚本类型

```
你只生成 VBA 宏脚本，不要使用 Python。
所有宏必须包含 Sub main() 作为入口。
```

### 添加公司规范

```
所有零件命名遵循公司规范：[项目代号]-[零件类型]-[序号]
例如：P2026-BRACKET-001
导出文件统一保存到 D:\Projects\Export\ 目录
```

### 限定操作范围

```
你只能操作当前打开的文档，不要打开新文件。
所有修改前先保存当前文档的备份副本。
```

---

## 主题切换

SW Copilot 提供两种主题：

- **浅色主题**：白色背景 + 浅灰色侧边栏，适合明亮环境
- **深色主题**：深灰背景 + 中灰色卡片，适合暗光环境

切换方式：
- 侧边栏底部「🌙 深色模式」/「☀️ 浅色模式」按钮
- 设置面板中的「外观主题」选项

---

## 常见问题

### SolidWorks 显示「未检测到」

1. 确认 SolidWorks 已启动并且有打开的文件
2. 点击「刷新」按钮重试
3. 如果仍未检测到，尝试以管理员身份运行 SW Copilot
4. 确认 SolidWorks 版本 >= 2017

### API 测试连接失败

1. 检查 API Key 是否正确粘贴（无多余空格）
2. 确认 Base URL 格式正确（注意末尾不要有多余的 /）
3. 检查网络连接（部分 API 可能需要代理）
4. 百炼用户注意 Base URL 是 dashscope.aliyuncs.com 而非 bailian.console.aliyun.com

### 脚本执行失败

1. 查看错误信息，通常是 API 调用参数不正确
2. 检查 SolidWorks 当前文档类型是否匹配（零件 vs 装配体 vs 工程图）
3. 某些操作需要先选中特定实体
4. 尝试换一种方式描述你的需求

### 如何降低 API 成本

- 使用更小的模型（如 Claude Haiku、GPT-4o-mini）处理简单任务
- 使用百炼/DeepSeek 等更便宜的国内服务
- 使用 Ollama 运行本地模型（完全免费，但效果取决于硬件）
- 重复性任务保存为自动化模板，避免重复调用 AI

---

## 安全须知

- SW Copilot 不会上传你的 CAD 文件到任何服务器
- 发送给 AI 的只有你的文字描述，不包含模型数据
- API Key 加密存储在本地，不会明文传输到 SW Copilot 的服务器（我们没有服务器）
- 所有生成的脚本在执行前会展示给你预览，你有完全的控制权
- 建议在重要操作前保存文件备份

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Enter | 发送消息 |
| Shift + Enter | 输入换行 |
| Ctrl + , | 打开设置 |
| Ctrl + L | 清空对话 |
| Ctrl + 1/2/3 | 切换标签页（对话/自动化/工具） |
