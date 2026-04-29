# SW Copilot — 项目规范 (CLAUDE.md)

> 本文件供 Claude Code / AI 辅助开发时自动读取，也作为团队开发规范参考。

## 项目简介

SW Copilot 是开源的 SolidWorks AI 自动化助手。用户用自然语言描述操作，AI 生成 VBA/Python 脚本并通过 COM 接口注入 SolidWorks 执行。支持 Anthropic / OpenAI 兼容协议，可接入任意大模型。

- **技术栈**: Electron 28 + React 18 + TypeScript 5.3 + cscript/VBS (COM) + 原生 fetch/SSE
- **运行环境**: Windows 10/11 (64-bit), SolidWorks 2017+, Node.js 20+
- **包管理器**: npm

## 架构概览

```
Renderer (React)  ←IPC→  Main Process (Node.js)  ←COM/cscript→  SolidWorks
```

三进程模型：
- **Main** (`src/main/`): LLM 调用、脚本生成/执行、COM 桥接、配置持久化
- **Preload** (`src/preload/`): contextBridge 安全边界，暴露 `window.api`
- **Renderer** (`src/renderer/`): React UI，纯编排层

## 目录结构

```
src/
├── shared/                  # 主/渲染共用（类型、常量、预设）
│   ├── types.ts             #   所有接口 & 类型
│   ├── ipc-channels.ts      #   IPC 频道常量（唯一来源）
│   ├── presets.ts           #   模型预设 & DEFAULT_CONFIG
│   └── sw-tools.ts          #   26 个 SW 工具定义（元数据）
├── main/
│   ├── index.ts             #   应用入口、窗口管理
│   ├── ipc/handlers.ts      #   IPC 处理器集中注册
│   ├── llm/                 #   LLM 双协议适配
│   │   ├── adapter.ts       #     BaseLLMAdapter 抽象基类
│   │   ├── anthropic.ts     #     Anthropic 协议实现
│   │   ├── openai.ts        #     OpenAI 兼容协议实现
│   │   ├── sse.ts           #     手写 SSE 流式解析器
│   │   ├── factory.ts       #     createAdapter() 工厂
│   │   ├── code-extract.ts  #     代码块提取
│   │   ├── context-window.ts#     token 估算 & 消息截断
│   │   ├── errors.ts        #     错误归一化 → LLMErrorInfo
│   │   └── prompts.ts       #     系统提示词（支持动态上下文拼接）
│   ├── com/                 #   SolidWorks COM 桥接
│   │   ├── sw-bridge.ts     #     cscript/VBS 连接管理（非 winax）
│   │   ├── health.ts        #     心跳监控
│   │   ├── context-collector.ts #  文档上下文采集
│   │   ├── tools.ts         #     工具元数据导出
│   │   └── vbs-writer.ts    #     VBS 文件写入（UTF-16LE+BOM）
│   ├── scripts/
│   │   ├── engine.ts        #     脚本执行引擎（cscript > python > com）
│   │   ├── sanitizer.ts     #     安全校验（VBA/Python 分语言黑名单）
│   │   ├── backup.ts        #     执行前自动备份
│   │   ├── vba-macro-writer.ts #  VBA → VBS 10 步转换
│   │   ├── generators/      #     26 个 SW 工具的 VBA 生成器
│   │   │   ├── index.ts     #       注册表 + generateScript() + checkCoverage()
│   │   │   ├── vba-helpers.ts #     mmToM / degToRad / vbaString / wrapMain / selectPlane
│   │   │   ├── sketch.ts    #       草图
│   │   │   ├── feature.ts   #       特征（拉伸/切除/旋转/倒角/阵列/镜像/尺寸）
│   │   │   ├── document.ts  #       文档操作
│   │   │   ├── assembly.ts  #       装配体
│   │   │   ├── export.ts    #       导出
│   │   │   └── batch-query.ts #     批量查询
│   │   └── templates/       #     预置脚本模板
│   └── store/
│       ├── config.ts        #     配置持久化（safeStorage 加密 API Key）
│       ├── chat-store.ts    #     对话历史 CRUD
│       └── env-fallback.ts  #     .env 文件解析 + 协议映射
├── preload/
│   └── index.ts             #   contextBridge 暴露 window.api
└── renderer/
    ├── App.tsx              #   纯编排层
    ├── components/          #   UI 组件
    ├── hooks/               #   useLLM / useSWStatus / useTheme
    ├── themes/              #   浅色/深色 token
    └── styles/
```

## 开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（并行 tsc -w + vite + electron）
npm run build        # 编译 main + preload + renderer
npm run dist         # 生成 NSIS 安装包
npm test             # 运行全部测试（node:test，需先 build:main）
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
```

## 核心开发约定

### IPC 通信
- **频道名只从 `shared/ipc-channels.ts` 导入**，绝不硬编码字符串
- 主进程用 `ipcMain.handle`（可 await），流式事件才用 `webContents.send`
- 渲染进程只通过 `window.api.xxx()` 调用，不直接用 `ipcRenderer`

### LLM 适配器
- 新协议必须继承 `BaseLLMAdapter`，实现 `chat / chatStream / test`
- 错误统一经 `toLLMError()` 归一化，**永不直接抛原始 Error**
- 流式通过 `AsyncIterable<LLMStreamEvent>` 暴露：`start | delta | done | error`
- 不依赖任何 SDK，全部用原生 `fetch` + 手写 SSE 解析

### COM 桥接
- 通过 `cscript.exe` 执行 VBScript 连接 SolidWorks（非 winax）
- VBS 文件必须 UTF-16LE+BOM 编码（解决中文兼容）
- `GetObject` → `CreateObject` 自动 fallback
- 所有 swApp 调用必须 try/catch，SW 可能随时被关闭

### 脚本生成器
- 每个 SW 工具对应 `generators/*.ts` 中的一个函数
- **单位**: 入参永远用 mm/度，生成器内用 `mmToM` / `degToRad` 转换
- **字符串**: 用户输入经 `vbaString()` 转义
- **包装**: 通过 `wrapMain()` 得到完整可执行宏
- **基准面**: `selectPlane()` 自动兼容中英文 SolidWorks

### VBA → VBS 转换 (`vba-macro-writer.ts`)
10 步规则（任何对 generators 的改动都必须确保转换后仍是合法 VBS）：
1. 移除 `Option Explicit` / `As <Type>`
2. `Application.SldWorks` → `GetObject(, "SldWorks.Application")`
3. `On Error GoTo <label>` → `On Error Resume Next`
4. `Exit Sub` → `WScript.Quit 0`
5. 移除 `Sub main() ... End Sub` 包装

### 新增 SW 工具的完整步骤
1. `shared/sw-tools.ts` 的 `SW_TOOLS` 加定义
2. `scripts/generators/<category>.ts` 加实现函数
3. `scripts/generators/index.ts` 的 `REGISTRY` 映射
4. 测试自动覆盖（`generators.test.mjs` 会检查所有工具）

### 配置持久化
- API Key 必须经 `safeStorage` 加密后再存 `electron-store`
- 其它字段直接存 `electron-store`
- `.env` 变量仅作 fallback，不写回 store

### UI 规范
- 所有颜色通过主题对象 `t` 引用，不硬编码
- 函数式组件 + Hooks
- 文件命名 kebab-case，变量 camelCase，类型 PascalCase

## 测试

采用 `node:test`（无外部依赖），测试文件在 `tests/*.test.mjs`，读取 `dist/` 编译产物。

```bash
npm run build:main && npm test
```

当前 161 个用例，覆盖：SSE 解析、代码提取、安全校验、错误归一化、适配器工厂、SW 工具清单、预设数据、VBA helpers、26 个生成器、VBA→VBS 转换、env fallback。

## 环境变量

参见 `.env.example`。开发时设 `SKIP_SW_CONNECT=true` 可跳过 COM 连接，纯 UI 开发。

API Key 优先级：UI 设置 > process.env > .env 文件 > 空。

## Git 规范

- 分支: `feat/xxx`, `fix/xxx`, `docs/xxx`, `chore/xxx`
- 提交信息: [Conventional Commits](https://www.conventionalcommits.org/)
- CHANGELOG: 遵循 [Keep a Changelog](https://keepachangelog.com/)
- 版本号: [语义化版本](https://semver.org/)

## 安全红线

- 不上传任何 CAD 文件到外部
- AI 对话仅发送文本，不发送模型数据
- 脚本执行前必须经 `sanitizer.ts` 校验
- 执行前自动备份当前文档
