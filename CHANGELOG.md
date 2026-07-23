# Changelog

本文件记录 Millwright 的所有重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **项目重命名（v0.2.4）**：仓库从 `sw-copilot` 改名为 `Millwright`，本地目录 `projects/sw-copilot/` → `projects/millwright/`。所有历史版本链接保持指向旧仓库地址（GitHub 重定向生效），仅 `[Unreleased]` 链接更新到新仓库。

## [Unreleased]

## [0.2.8] - 2026-07-23

### Fixed (P9 — 连接判定最终修复 + 真 bug 顺修)

**输出通道第 4 版（终版）：纯 ASCII stdout + VBS 层转义**

`P8.1` 的 FSO 临时文件方案在部分环境被杀毒软件拦截（写文件
是常见诱因），`Sub Out` 无错误处理导致 `"OK"` 输出丢失 →
COM 附着成功也判"未连接"。P9 回到 `stdout + exec + utf8` 的最朴素
通道，但保证输出永远纯 ASCII：所有非 ASCII 字符在 VBS 层
转成 `\uXXXX`（`AscW` + 负值修正处理代理对），`JSON.parse` 原生
解码。ASCII 字节在任何代码页下都相同，编码问题物理上不可能再
发生。不用 `//U`、不写临时文件、不碰 FSO。

**老 bug 顺修：`CStr(True)` 输出大写 `True` 导致 JSON 解析炸**

`LCase(CStr(feat.IsSuppressed()))` 和
`LCase(CStr(comp.IsSuppressed()))` 修两处。**特征采集其实一直返回空**——
try/catch 吞掉了 JSON 解析异常。这是 P9 之前没人发现的真 bug，
现在终于有中文特征名能拿到非空结果。

**保留 v0.2.7 的 `AttachSW()` 函数内 `On Error Resume Next`**

### Files touched (1)
- `src/main/com/sw-bridge.ts` — P9 drop-in，hash `584cd8fe760b180ce474217e4c81611cd87b0a49`
  （drop-in 自带；v0.2.7 的 AttachSW On Error Resume Next 已包含在 patch 里）

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

### 如果 P9 还不行

通道问题已全部排除。剩下的必须跑 `diag.vbs`（之前给过）拿实际
输出，**不要再盲修代码**。

## [0.2.7] - 2026-07-23

### Fixed (P8.1 回归根因 + 真 bug)

**P8.1 exe 是旧缓存的问题** — v0.2.6 release 的 asset 名字是
`Millwright-Setup-0.5-x64.exe`，说明 Windows runner 的 npm 构建用了
旧的 node_modules 缓存（打包时 package.json 的 version 还是 0.2.5），
用户下载的 installer 根本不含 P8.1 代码。解决方案：打 v0.2.7 tag
全新触发器，强制重新 npm install，清缓存。

**真 bug: AttachSW() 缺少 On Error Resume Next** — VBScript 的错误
处理按过程隔离，被调函数内部的 `On Error Resume Next` 不会继承调用
者的设置。`Function AttachSW()` 体内没有任何错误处理，所以当裸
ProgID 失败时，第一个 `GetObject(, "SldWorks.Application")` 报错
后整个函数直接中断，`.34`～`.25` 根本轮不到。在只注册了带版本号
ProgID 的机器上，P4 的遍历修复实际完全失效。修法：在 `Function
AttachSW()` 函数体第一行加 `On Error Resume Next`。

### Files touched (1)
- `src/main/com/sw-bridge.ts` — `Function AttachSW()` 加 `On Error
  Resume Next`（一行改动），同时确认 P8.1 的 FSO Unicode 临时文件
  机制在位

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

## [0.2.6] - 2026-07-23

### Fixed (P8 — CJK hotfix)
- **Sidebar document title shows garbage for Chinese filenames** (e.g.
  `L10����II��-new.SLDASM` instead of `L10整机装配-new`). Root cause:
  `src/main/com/sw-bridge.ts` `runVBS` decoded cscript stdout as UTF-8,
  but cscript writes to the pipe in the OEM code page (Chinese Windows
  = GBK). P6 already fixed this for `engine.ts` by adding `//U` to force
  UTF-16 output; the short-query path in sw-bridge (status poll /
  feature collect) was missed. This hotfix applies the same fix to
  `runVBS`: cscript arg `//U`, decode with `encoding: 'buffer'` →
  `toString('utf16le')`, strip BOM. Drop-in patch, no manual edits.

### Fixed (cleanup from v0.2.5 review)
- `src/renderer/App.tsx`: moved the P4 greeting-sync `useEffect` to
  *after* the `useLLM` destructure. The previous placement closed over
  `messages` / `setMessages` before they were declared — runtime was
  fine because React resolves hooks top-to-bottom, but the ordering was
  TDZ-fragile during refactors. Added a placement-note comment so the
  reasoning survives future readers.
- `src/main/ipc/handlers.ts` SW_CONTEXT handler: now calls
  `formatContextForPromptAsync(bridge, await loadLocale())` instead of
  the sync `formatContextForPrompt(ctx)` without locale. UI-preview
  panel now matches the user's active language (this was the only
  context-collection path that hadn't been plumbed through `loadLocale`
  in P7).
- `src/main/ipc/handlers.ts`: removed the now-unused `formatContextForPrompt`
  import.
- Replaced the obsolete `// eslint-disable-next-line react-hooks/exhaustive-deps`
  comment in `App.tsx` with a plain `// INTENTIONAL:` note explaining
  why the effect intentionally lists only `[INITIAL_MESSAGES]` in its
  dep array. (`react-hooks` plugin isn't installed in `.eslintrc.json`,
  so the disable comment was a no-op anyway.)

### Files touched (3)
- `src/main/com/sw-bridge.ts` — P8 drop-in, hash identical to patch
- `src/renderer/App.tsx` — P4 effect reposition + intentional-dep note
- `src/main/ipc/handlers.ts` — SW_CONTEXT locale + unused-import cleanup

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

Backup before P8 apply: `backups/sw-copilot-pre-v0.2.6-p8-20260723-144520/`
(69 files in src/, restored verbatim — patch only ever touched
sw-bridge.ts, verified by `git status` after `cp`).

## [0.2.5] - 2026-07-22

### Changed
- **Visual brand refresh**: Raylan's new 1320×1320 M monogram (silver M
  plus semi-transparent blue-tinted M offset forming a 'm/m' letterform)
  now drives every brand surface:
  - `assets/icon.ico` regenerated at all required Windows sizes
    (16/24/32/48/64/128/256) from the v4 M monogram. The previous
    `icon.ico` was the original 256×256 mark from commit 949930e and was
    never touched through v0.2.x.
  - `assets/banner-hero.png` (1600×640) and `assets/social-preview.png`
    (1280×640) refreshed to v3.1 — Space Grotesk wordmark, M monogram,
    Navy `#060D1D` + Silver `#EAEDF4` + Electric Blue `#1E6BFF` + Cyan
    `#38CCFF` brand palette, subtle gradient + noise for depth.
  - `assets/README-hero.png` (1536×1024) refreshed to v3.1 as well.
  - `assets/icon-256.png`, `icon-512.png`, `icon-1024.png`,
    `logo-square-512.png` regenerated from the M monogram source.
- **`README.md` / `README.zh-CN.md`**: insert v3.1 `banner-hero.png` as
  the top hero image; swap header icon to v3.1 `icon-512.png` (96×96).
- **`.github/workflows/build.yml`**: artifact names updated from the old
  `SW-Copilot-*` slug to `Millwright-*` to match the new product name.

### Fixed
- v0.2.4 release still shipped the original Jun-14 256×256 icon (never
  refreshed) and the installer filename was still `SW.Copilot-Setup-…`.
  Both are addressed by this release.

## [0.2.3] - 2026-06-14

### Added
- 新增 `.github/workflows/ci.yml`: 快速质量门(PR / push 到主分支时跑
  `typecheck` + `lint` + `test` on ubuntu-latest)。与 `build.yml` 分工:
  `ci.yml` 轻量即时反馈,`build.yml` 仍负责 windows + NSIS 打包发版
  (tag 推送不触发 ci.yml,避免重复跑)

## [0.2.2] - 2026-06-14

### Fixed
- **错误提示丢失**: 非流式 `LLM_CHAT` 和 `LLM_TEST` 的 catch 分支直接返回原始
  `Error` 对象,过 IPC structured-clone 后 message/code 丢失,导致 ErrorBanner
  (依赖 `error.code`)无法正确展示认证/限流/网络类错误。现统一经 `toLLMError()` 归一化
  (流式路径本已正确处理)

### Changed
- 执行结果框 / 错误横幅的颜色改为主题 token(新增 successBg/dangerBg/warnBg 等),
  修复深色模式下出现浅绿/浅粉碎片的问题
- Chat 消息列表自动滚动改用容器 scrollTop(代替 scrollIntoView),消除流式输出时
  逐 token 触发的页面整体滚动抖动

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

[Unreleased]: https://github.com/raylanlin/Millwright/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/raylanlin/Millwright/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/raylanlin/Millwright/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/raylanlin/Millwright/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/raylanlin/Millwright/compare/v0.2.4...v0.2.5
[0.2.3]: https://github.com/raylanlin/sw-copilot/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raylanlin/sw-copilot/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raylanlin/sw-copilot/compare/v0.1.0...v0.2.1
[0.1.0]: https://github.com/raylanlin/sw-copilot/releases/tag/v0.1.0
