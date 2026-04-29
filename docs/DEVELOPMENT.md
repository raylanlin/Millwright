# 开发者指南

> 本文档面向贡献者,说明 SW Copilot 代码结构与开发约定。
> 用户使用请看 [`../README.md`](../README.md) 和 [`USER-GUIDE.md`](USER-GUIDE.md)。

## 项目结构

```
sw-copilot/
├── package.json
├── tsconfig.json                # 引用 main/renderer 两个工程
├── tsconfig.main.json           # 主进程 + preload 编译
├── tsconfig.renderer.json       # 渲染进程类型检查
├── vite.config.ts               # 渲染进程打包
├── electron-builder.yml         # 打包分发
├── src/
│   ├── shared/                  # 主 / 渲染共用
│   │   ├── types.ts             #   接口、错误码、消息类型
│   │   ├── ipc-channels.ts      #   IPC 频道常量
│   │   ├── presets.ts           #   模型预设、默认 URL
│   │   └── sw-tools.ts          #   SW 工具清单(元数据,两端共享)
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             #   应用入口、窗口管理
│   │   ├── llm/                 #   LLM 双协议适配
│   │   │   ├── adapter.ts       #     抽象基类
│   │   │   ├── anthropic.ts     #     Anthropic 协议
│   │   │   ├── openai.ts        #     OpenAI 兼容协议
│   │   │   ├── sse.ts           #     SSE 流式解析
│   │   │   ├── prompts.ts       #     系统提示词
│   │   │   ├── code-extract.ts  #     代码块提取
│   │   │   ├── errors.ts        #     错误归一化
│   │   │   ├── factory.ts       #     createAdapter()
│   │   │   └── index.ts
│   │   ├── com/                 #   SolidWorks COM 桥接
│   │   │   ├── sw-bridge.ts     #     cscript/VBS 连接管理
│   │   │   ├── health.ts        #     心跳监控
│   │   │   └── tools.ts         #     AI 可调用的工具清单
│   │   ├── scripts/             #   脚本执行
│   │   │   ├── engine.ts        #     VBA / Python 执行器
│   │   │   ├── sanitizer.ts     #     安全校验
│   │   │   ├── generators/      #     VBA 脚本生成器(26 个 SW 工具)
│   │   │   │   ├── index.ts     #       注册表 + generateScript()
│   │   │   │   ├── vba-helpers.ts #     单位换算、字符串转义、包装
│   │   │   │   ├── document.ts  #       零件/装配体/工程图
│   │   │   │   ├── sketch.ts    #       草图 + 矩形/圆/线
│   │   │   │   ├── feature.ts   #       拉伸/切除/旋转/倒角/阵列/镜像/尺寸
│   │   │   │   ├── assembly.ts  #       插件/配合
│   │   │   │   ├── export.ts    #       STEP/PDF/STL/DXF
│   │   │   │   └── batch-query.ts #     批量重命名/干涉/质量/BOM
│   │   │   └── templates/       #     预置参数化脚本模板(示例)
│   │   ├── store/
│   │   │   └── config.ts        #   配置持久化(safeStorage)
│   │   └── ipc/
│   │       └── handlers.ts      #   IPC 处理器集中注册
│   ├── preload/
│   │   └── index.ts             # contextBridge 暴露 window.api
│   └── renderer/                # React 渲染进程
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx              # 纯编排:挂 hook、拼组件、路由标签
│       ├── preload.d.ts         #   window.api 类型声明
│       ├── components/          #   组件
│       │   ├── Sidebar.tsx      #     左侧栏(状态条 + 标签切换 + 主题/设置)
│       │   ├── StatusDot.tsx    #     连接状态小圆点
│       │   ├── Chat.tsx         #     消息列表容器 + 自动滚动
│       │   ├── ChatMessage.tsx  #     单条消息气泡(文本/代码/工具/执行结果)
│       │   ├── ChatInput.tsx    #     底部输入框(带取消按钮)
│       │   ├── SettingsModal.tsx#     设置面板(真 IPC 测试连接)
│       │   ├── Automations.tsx  #     快捷模板网格
│       │   ├── automations-data.ts # 模板数据(icon/label/prompt)
│       │   └── ToolsList.tsx    #     工具列表(按分类)
│       ├── hooks/
│       │   ├── useLLM.ts        #   聊天状态 + 流式
│       │   ├── useSWStatus.ts   #   SW 连接状态订阅
│       │   └── useTheme.ts      #   主题
│       ├── themes/
│       │   └── index.ts         #   浅色 / 深色 token
│       └── styles/
│           └── global.css
├── docs/
│   ├── ARCHITECTURE.md          # 设计文档
│   ├── USER-GUIDE.md            # 用户手册
│   ├── API-REFERENCE.md         # API 参考 / COM 速查
│   ├── CONTRIBUTING.md          # 贡献指南
│   ├── UI-PROTOTYPE.jsx         # 早期 UI 原型(参考)
│   └── DEVELOPMENT.md           # 本文档
├── tests/                       # node:test 单元测试(见下方测试章节)
│   ├── sse.test.mjs
│   ├── code-extract.test.mjs
│   ├── sanitizer.test.mjs
│   ├── errors.test.mjs
│   ├── factory.test.mjs
│   ├── sw-tools.test.mjs
│   ├── presets.test.mjs
│   ├── vba-helpers.test.mjs
│   └── generators.test.mjs
└── assets/                      # 图标等
```

## 开发环境

```bash
node >= 20.0.0
npm >= 10.0.0
# 运行期(可选):
python >= 3.10          # 如需执行 Python 脚本
SolidWorks 2017+        # 实际使用时必需,开发 UI 时可无
```

## 启动

```bash
npm install
npm run dev
```

`npm run dev` 会并行启动三件事:

1. `tsc -w` 监听编译主进程 TS → `dist/main/`
2. Vite dev server 在 :5173 启动渲染进程
3. 等待两者就绪后启动 Electron

## 构建

```bash
npm run build      # 编译 main + 打包 renderer
npm run pack       # 打包为未签名 exe(测试用)
npm run dist       # 生成 NSIS 安装包 + Squirrel 更新包
```

## 环境变量

复制 `.env.example` 为 `.env` 并按需填写。常用的开发变量:

| 变量 | 说明 | 默认 |
|------|------|------|
| `SKIP_SW_CONNECT` | 设为 `true` 跳过 COM 连接和心跳检测,纯 UI 开发时使用 | — |
| `DEBUG` | 设为 `sw-copilot:*` 开启详细日志 | — |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` | Anthropic fallback(UI 未配置时生效) | — |
| `OPENAI_API_KEY` + `OPENAI_MODEL` + `OPENAI_BASE_URL` | OpenAI fallback | — |
| `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL` | DeepSeek fallback | — |
| `DASHSCOPE_API_KEY` + `DASHSCOPE_MODEL` | 阿里百炼 fallback | — |
| `MINIMAX_API_KEY` + `MINIMAX_MODEL` | MiniMax fallback | — |

**API Key 优先级**(高到低):

1. UI 设置面板保存的值(`electron-store` + `safeStorage` 加密)
2. `process.env` 里的对应变量(shell 环境)
3. 项目根目录的 `.env` 文件
4. 空(需要用户在 UI 里配置)

Env fallback 只在内存里生效,不会写回 `electron-store`。多个协议同时配了按:Anthropic → OpenAI → DeepSeek → 百炼 → MiniMax 的顺序取第一个。

## 模块约定

### LLM 适配器

- 所有新协议必须继承 `BaseLLMAdapter` 并实现 `chat / chatStream / test`
- 错误统一通过 `errors.ts` 的 `toLLMError()` 归一化为 `LLMErrorInfo`,**永不直接抛原始 Error**
- 流式通过 `AsyncIterable<LLMStreamEvent>` 暴露,`start / delta / done / error` 四种事件
- 代码块提取由 `code-extract.ts` 统一负责,适配器只管把完整 `content` 传进来

### IPC

- **频道名只从 `shared/ipc-channels.ts` 导入**,不硬编码字符串
- 主进程一律用 `ipcMain.handle`(可 await),流式事件才用 `webContents.send`
- 渲染进程一律通过 `window.api.xxx()` 调用,不直接 `ipcRenderer.invoke`(preload 是唯一的边界)

### COM Bridge

- 通过 `cscript.exe` 执行 `.vbs` 脚本，无需任何原生模块，跨平台兼容
- 所有 `swApp.xxx()` 调用都要有 try/catch,SW 可能随时被用户关掉

### 脚本执行路径

`ScriptEngine` 在启动时 `detectRuntime()` 挑一个最合适的运行时执行脚本,按优先级:

| Runtime | 触发条件 | 优点 | 缺点 |
|---------|---------|------|------|
| **cscript**(VBS,默认) | Windows 平台 | 原生、快、稳;不依赖 SW RunMacro2 的 GUI 回调 | 需要把 VBA 转成 VBS(见下) |
| **python** | Python + pywin32 可用 | 最灵活,能做复杂控制流 | 需要用户装 Python 环境 |
| **com**(RunMacro2) | 前两者都不可用 | 直接在 SW 宏环境执行 | 要求 SW 已连接 + 宏文件格式对 |

**VBA → VBS 转换**(`vba-macro-writer.ts`)是 cscript 路径的核心。生成器输出的是标准 VBA 宏格式(`Sub main()` + `On Error GoTo`),cscript 执行需要:

1. 移除 `Option Explicit` / `As <Type>`(VBS 弱类型)
2. `Application.SldWorks` → `GetObject(, "SldWorks.Application")`(VBS 独立进程连接)
3. `On Error GoTo <label>` → `On Error Resume Next`(VBS 没 GoTo)
4. **`Exit Sub` → `WScript.Quit 0`**(VBS 顶层代码非法,必须替换)
5. 移除 `Sub main() ... End Sub` 包装(VBS 直接顶层执行)
6. 追加 JSON 结果写入 footer(给 engine.ts 读回)

任何对 `vba-helpers.ts` / `generators/*.ts` 的改动都要确保经过 `vbaToVbs()` 后仍是合法 VBS —— `tests/vba-macro-writer.test.mjs` 的端到端用例会覆盖所有 26 个生成器。

### 脚本生成器

- 每个 SW 工具对应 `scripts/generators/*.ts` 里的一个函数,入参匹配 `SWToolDefinition.parameters`
- **单位约定**:入参永远用 mm / 度,生成器用 `vba-helpers` 的 `mmToM` / `degToRad` 转成 SolidWorks API 需要的米/弧度
- **字符串嵌入**:路径、用户输入都要经过 `vbaString()`,自动转义双引号
- **包装**:所有生成器返回的代码通过 `wrapMain()` 得到完整可执行的 .swp 内容(含 `Sub main()` + `On Error` 错误处理)
- 新增一个工具的完整步骤:
  1. 在 `shared/sw-tools.ts` 的 `SW_TOOLS` 里加定义(name/description/parameters/category/exampleParams)
  2. 在 `scripts/generators/<category>.ts` 里加实现函数
  3. 在 `scripts/generators/index.ts` 的 `REGISTRY` 里映射 name → 函数
  4. `generators.test.mjs` 的"注册表覆盖所有 SW_TOOLS"测试会自动包含新工具

### 配置持久化

- API Key 必须经过 `safeStorage` 加密后再存
- 其它字段放 `electron-store`

## 测试

采用 Node 自带的 `node:test`(无外部依赖)。测试文件在 `tests/*.test.mjs`,
直接读取 `dist/` 下的 JS 产物。

```bash
npm run build:main    # 先编译主进程
npm test              # 运行全部测试
# 或只运行某一个:
node --test tests/sse.test.mjs
```

当前测试覆盖:

| 文件 | 模块 | 用例数 |
|------|------|--------|
| `tests/sse.test.mjs` | SSE 解析器(分块边界、CRLF、注释、多行 data) | 8 |
| `tests/code-extract.test.mjs` | 代码块提取(fenced、启发式、多块) | 12 |
| `tests/sanitizer.test.mjs` | 安全校验(VBA/Python 黑名单、语言隔离、去重) | 12 |
| `tests/errors.test.mjs` | 错误归一化(状态码映射、AbortError、网络错误) | 18 |
| `tests/factory.test.mjs` | 适配器工厂 + 配置验证 | 8 |
| `tests/sw-tools.test.mjs` | SW 工具清单不变式(名字唯一、分类、分组) | 9 |
| `tests/presets.test.mjs` | 预设数据一致性(URL、DEFAULT_CONFIG、OpenAI 兼容) | 8 |
| `tests/vba-helpers.test.mjs` | VBA 代码生成辅助(单位换算、字符串转义、包装、中英文基准面) | 24 |
| `tests/generators.test.mjs` | 26 个 SW 工具的脚本生成器(完整性 + 参数 + 单位 + 中文 fallback) | 21 |
| `tests/vba-macro-writer.test.mjs` | VBA→VBS 转换(7 条规则 + 端到端 + VBS 静态合法性) | 21 |
| `tests/env-fallback.test.mjs` | .env 解析 + 协议映射 fallback | 20 |
| **合计** | | **161** |

Phase 2 计划补充的:
- 适配器的集成测试(用 MSW 或本地 mock server)
- `sw-bridge` 的 Windows 下端到端测试
- `engine` 的脚本执行测试(需要 mock swApp + python 可执行文件)
