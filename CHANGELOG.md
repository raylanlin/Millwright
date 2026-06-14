# Changelog

本文件记录 SW Copilot 的所有重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.1] - 2026-06-13

> 主题:彻底修复「显示执行完成 ✓ 但 SolidWorks 里什么都没发生」的假成功问题。

### Fixed
- **严重 · 隐形实例**: 所有 VBS(脚本执行/心跳/状态采集/备份)在 `GetObject` 失败时会
  fallback 到 `CreateObject("SldWorks.Application")`,启动一个**不可见的新 SolidWorks 实例**。
  脚本在用户看不见的窗口里"成功"执行,可见窗口毫无变化,UI 却显示执行完成。
  现已**彻底移除所有 CreateObject fallback**,统一收口到 `SWCP_ConnectSW()`(只 `GetObject`),
  连不上时明确报错(含权限提示),连到隐形实例时强制 `Visible = True`
- **严重 · Empty/Nothing 误判**: `GetObject` 失败时返回 Empty 而非 Nothing,
  `If swApp Is Nothing` 判断本身报错被 `On Error Resume Next` 吞掉,连接检测彻底失控。
  改用 `Err.Number + IsObject` 判断
- **严重 · 假成功**: 前置条件不满足(无活动文档/不在草图中)时,旧版 `vbaToVbs` 把
  `Exit Sub` 转成 `WScript.Quit 0` 并且不写结果文件,engine 把"无结果文件"当成功。
  现在保留 `Sub main()` 结构由顶层调用,所有退出路径(成功/失败/前置不满足)都写结果文件,
  engine 把"无结果文件"一律视为**失败**
- **MsgBox 阻塞**: cscript 下 `MsgBox` 是真实弹窗,阻塞到超时。失败类(vbExclamation/
  vbCritical)→ `SWCP_Fail`(写失败结果+退出码1);其余 → `WScript.Echo`。永不弹窗
- **中文乱码**: 结果文件以 UTF-16(Unicode) 写入,engine 按 BOM 自动识别 UTF-16/UTF-8
- **特征静默失败**: 拉伸/切除/旋转/倒角/阵列/镜像等创建类 API 失败时返回 Nothing 而不报错,
  旧版未检查返回值导致失败被误报为成功。现在全部 `Set f = ...` 后判断 `If f Is Nothing`
- **VBScript 不兼容语法**: 导出/BOM 生成器里用了 VBScript 不存在的 `Dir()`/`MkDir`/`FreeFile`/
  `Open`/`Print #`/`GoTo`/`Format()`,转换后 cscript 报编译错误。改用 FileSystemObject +
  FormatNumber + If 块;`vbaToVbs` 新增 `Next i→Next`、`Format()→SWCP_Format()` 转换

### Added
- **对话历史持久化**: 侧边栏新增「对话历史」列表,对话内容在每轮生成结束后自动保存
  (`useChatSessions` hook + Sidebar 历史 UI),支持新建/切换/删除会话。后端 chat-store
  早已就绪,此前一直缺前端接线导致刷新即丢,现已补全
- `checkVbsCompatibility()`: 执行前静态检查 VBA 代码中无法转 VBScript 的语法,
  提前给出可操作的错误信息,而不是让 cscript 报一堆看不懂的编译错误
- `ensureParentDir()`: 用 FileSystemObject 递归创建目录的通用辅助(替代 Dir/MkDir)
- 系统提示词新增「执行环境」章节:明确禁止 CreateObject/GoTo/Dir/Format/InputBox 等
  VBScript 不兼容语法,要求检查创建类 API 的返回值

### Changed
- `vbaToVbs` 重写:保留 `Sub main()` 结构由顶层 runner 调用,错误统一捕获并写结果文件
- VBS 脚本执行超时 30s → 60s(适配大模型重建/复杂导出)
- SolidWorks 文档上下文采集收口到主进程单点注入:移除渲染层 `useLLM` 的重复 `getContext()`
  调用,避免每条消息触发两次昂贵的 cscript 文档特征采集

### Fixed (上一轮 Unreleased 内容并入)
- vbaToVbs 漏处理 `PRELUDE_ACTIVE_DOC` / 各生成器防御性分支里的 `Exit Sub`(本次重写已彻底解决)

### Added
- `vba-macro-writer` 模块单元测试(21 个用例,覆盖每条 regex + 端到端 + VBS 语法静态检查)
- `.env` fallback 实装(`src/main/store/env-fallback.ts`):支持 Anthropic/OpenAI/DeepSeek/百炼/MiniMax 五种协议的 env 变量,`loadConfig()` 在 UI 未配置时自动使用
- `env-fallback` 单元测试(20 个用例)
- 基准面选择自动兼容中英文 SolidWorks 模板(`selectPlane` / `selectPlaneAppend`)
- `.env.example` 环境变量模板
- `CHANGELOG.md` 版本变更记录
- 镜像特征使用独立的 `selectPlaneAppend` 辅助函数,不再依赖脆弱的字符串替换
- Preload 路径兼容打包后环境(`app.isPackaged` 分支)
- `SKIP_SW_CONNECT` 环境变量支持,纯 UI 开发时跳过 COM 连接
- 脚本执行超时保护(默认 30 秒)
- VBA 宏执行后自动清理临时 `.swp` 文件(finally 块保证)
- `DEVELOPMENT.md` 新增"脚本执行路径"章节,说明 cscript/python/com 三种 runtime 的选择逻辑和 VBA→VBS 转换规则

### Changed
- `selectPlane()` 输出格式变更:先尝试英文基准面名,失败自动 fallback 中文名
- 镜像生成器 `mirrorFeature()` 使用 `selectPlaneAppend()` 替代 `.replace()` hack
- `electron-builder.yml` 的 `files:` 加上对 `src/`、`tests/`、`docs/`、`*.md`、`tsconfig*.json`、`vite.config.ts`、`.env*` 的排除,避免打包时带入源码和环境文件
- `vba-macro-writer.ts` 转换规则重新编号 1-10,每条给出必要性说明;特别标注 header 的 `On Error Resume Next` 看似冗余但必需(footer 依赖 `Err.Number`)

## [0.1.0] - 2026-04-23

### Added
- Electron 28 应用骨架 + React 18 渲染层
- 双协议 LLM 适配器（Anthropic / OpenAI 兼容）
- 手写 SSE 解析器，支持流式输出
- SolidWorks COM 桥接（winax）+ 心跳检测
- 26 个 SolidWorks 工具的 VBA 生成器（完整覆盖 `SW_TOOLS`）
- 脚本安全校验（VBA / Python 分语言规则）
- 脚本执行引擎（VBA 宏注入 + Python subprocess）
- 代码块提取（fenced code block 解析 + 语言启发式推断）
- 错误分类体系（HTTP 错误 / 网络错误 / 超时 / 取消）
- 浅色 / 深色双主题 UI
- 设置面板（协议 / URL / Key / 模型 / 系统提示词）
- 聊天界面（对话 + 代码预览 + 执行按钮 + 复制按钮）
- 快捷自动化模板面板（6 个常用操作）
- 工具列表展示页
- Preload 安全桥接（contextIsolation + contextBridge）
- IPC 通信协议（类型安全的频道常量）
- 配置持久化（electron-store 加密存储）
- 主题持久化
- 流式请求取消（AbortController）
- 启动时生成器覆盖率自检
- 9 个测试文件（Node.js 原生 test runner）
- 完整文档（架构 / 用户手册 / API 参考 / 贡献指南 / 开发指南）

[Unreleased]: https://github.com/raylanlin/sw-copilot/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/raylanlin/sw-copilot/compare/v0.1.0...v0.2.1
[0.1.0]: https://github.com/raylanlin/sw-copilot/releases/tag/v0.1.0
