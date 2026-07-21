# Millwright — 落地实施计划

> ⚠️ **归档文件**：本计划 8/8 步骤已全部完成（v0.2.0，2026-04-28）。保留供历史参考，不再维护。

> 从"原型"到"能在真实 SolidWorks 环境中稳定使用"的完整步骤
> 
> **状态**: 8/8 步骤已全部实现 ✅（v0.2.0）
> 每个步骤对应具体的文件变更，标注 [新增] / [修改] / [删除]

---

## 总览

共 8 个步骤，按依赖关系排序：

| # | 步骤 | 解决的核心问题 | 涉及文件 |
|---|------|---------------|----------|
| 1 | ✅ VBA 宏执行方式重写 | .swp 格式不兼容，宏无法执行 | engine.ts, vba-macro-writer.ts [新增] |
| 2 | ✅ 文档上下文采集 | AI 不知道当前打开了什么，生成的脚本靠猜 | context-collector.ts [新增], sw-bridge.ts, prompts.ts, handlers.ts |
| 3 | ✅ 上下文注入到对话流 | 采集的信息要自动拼入每次 AI 请求 | useLLM.ts, handlers.ts |
| 4 | ✅ 脚本执行结果回传 | 宏执行完没有反馈，用户不知道发生了什么 | engine.ts, vba-helpers.ts, types.ts |
| 5 | ✅ 对话历史持久化 | 关闭应用对话丢失 | chat-store.ts [新增], useLLM.ts, App.tsx, Sidebar.tsx |
| 6 | ✅ 上下文窗口管理 | 长对话超出 token 上限 | context-window.ts [新增], useLLM.ts |
| 7 | ✅ 执行前自动备份 | 脚本搞坏文件无法回退 | backup.ts [新增], engine.ts, App.tsx |
| 8 | ✅ 错误恢复 UI | 断连/报错后 UI 没有重试入口 | ErrorBanner.tsx [新增], App.tsx |

---

## 步骤 1：VBA 宏执行方式重写

### 问题
SolidWorks 的 `.swp` 宏文件是 OLE 复合文档格式，不是纯文本。当前 `engine.ts` 直接
`fs.writeFileSync(tempPath, code, 'utf8')` 写纯文本到 `.swp`，在大多数 SW 版本上无法执行。

### 方案
改用 **COM 直接执行** 方式：通过 `swApp.RunMacro2` 运行预写好的桩宏，桩宏读取临时 `.bas`
文件并 `Application.Run` 执行。或者更简单——直接用 COM 的 `SendMsgToUser` + `IModelDocExtension.RunCommand`
逐条执行。最可靠的方案是用 SolidWorks 的 **VSTA 宏**（.dll）或干脆走 Python win32com 替代 VBA。

**最终选择**：双轨方案
- 主路径：改成 Python win32com 执行（用户机器上有 Python 时）
- 备用路径：用 `cscript.exe` 运行 VBScript（.vbs）代替 VBA（.swp）

### 文件变更
- [新增] `src/main/scripts/vba-macro-writer.ts` — 将 VBA 代码转为可执行的 .vbs 脚本
- [修改] `src/main/scripts/engine.ts` — 重写 runVBA，加 runVBS 备用路径
- [修改] `src/main/scripts/generators/vba-helpers.ts` — wrapMain 输出 VBS 兼容格式

---

## 步骤 2：文档上下文采集

### 问题
AI 不知道用户当前打开了什么文件、有哪些特征、尺寸是多少。生成的脚本是"盲猜"的。

### 方案
在每次发送消息前，通过 COM 读取当前文档的：
- 文件名、类型（零件/装配体/工程图）
- 特征树（名称 + 类型列表）
- 自定义属性
- 活动配置名称
- 尺寸列表（名称 + 当前值）

注入到 system prompt 中。

### 文件变更
- [新增] `src/main/com/context-collector.ts` — 文档上下文采集器
- [修改] `src/main/com/sw-bridge.ts` — 暴露 getContext() 方法
- [修改] `src/main/llm/prompts.ts` — 支持动态拼接上下文到 system prompt
- [修改] `src/main/ipc/handlers.ts` — 新增 SW_CONTEXT channel
- [修改] `src/shared/ipc-channels.ts` — 新增 channel 常量
- [修改] `src/shared/types.ts` — 新增 SWDocumentContext 类型
- [修改] `src/preload/index.ts` — 暴露 sw.getContext()

---

## 步骤 3：上下文注入到对话流

### 问题
步骤 2 采集的上下文需要在每次 AI 请求中自动附带。

### 方案
在 `useLLM.ts` 的 `send()` 中，发消息前先调 `window.api.sw.getContext()`，
把上下文拼到 system prompt 尾部。这样 AI 每次都能看到最新的文档状态。

### 文件变更
- [修改] `src/renderer/hooks/useLLM.ts` — send 前获取上下文，拼入 config.systemPrompt

---

## 步骤 4：脚本执行结果回传

### 问题
VBA 宏执行后只有成功/失败，没有具体结果（如"修改了 8 个圆角"）。

### 方案
脚本执行完将结果写入临时 JSON 文件，engine 读取后解析返回。
在 vba-helpers 里加一个 `writeResult` 辅助函数，生成器在脚本末尾自动追加结果写入代码。

### 文件变更
- [新增] `src/main/scripts/result-bridge.ts` — 临时文件读写结果的桥接
- [修改] `src/main/scripts/engine.ts` — 执行完后读取结果文件
- [修改] `src/main/scripts/generators/vba-helpers.ts` — 新增 writeResult 辅助
- [修改] `src/shared/types.ts` — ScriptResult 增加 data 字段

---

## 步骤 5：对话历史持久化

### 问题
关闭应用后对话丢失。

### 方案
用 electron-store 存储对话列表。每个会话独立存储，侧边栏显示历史会话列表。

### 文件变更
- [新增] `src/main/store/chat-store.ts` — 对话 CRUD
- [修改] `src/main/ipc/handlers.ts` — 新增 chat:* channels
- [修改] `src/shared/ipc-channels.ts` — 新增 channel 常量
- [修改] `src/shared/types.ts` — 新增 ChatSession 类型
- [修改] `src/preload/index.ts` — 暴露 chat.* API
- [修改] `src/renderer/hooks/useLLM.ts` — 消息变化时自动持久化
- [修改] `src/renderer/components/Sidebar.tsx` — 显示会话列表
- [修改] `src/renderer/App.tsx` — 会话切换逻辑

---

## 步骤 6：上下文窗口管理

### 问题
长对话会超出模型 token 上限，导致 API 报错。

### 方案
发送前对消息列表做截断：保留 system prompt + 最近 N 轮对话。
用简单的字符数估算 token（中文 ≈ 1.5 token/字，英文 ≈ 0.75 token/word）。

### 文件变更
- [新增] `src/main/llm/context-window.ts` — 消息截断 + token 估算
- [修改] `src/main/ipc/handlers.ts` — 在 LLM_CHAT / LLM_CHAT_STREAM 中截断

---

## 步骤 7：执行前自动备份

### 问题
脚本执行出错可能破坏当前文件，无法回退。

### 方案
在执行脚本前，自动调用 `swModel.SaveAs` 保存一份 `.bak.sldprt` 备份到临时目录。
执行成功则删除备份，失败则保留并提示用户备份路径。

### 文件变更
- [新增] `src/main/scripts/backup.ts` — 文件备份与恢复
- [修改] `src/main/scripts/engine.ts` — 执行前调 backup，执行后根据结果处理
- [修改] `src/shared/types.ts` — ScriptResult 增加 backupPath 字段

---

## 步骤 8：错误恢复 UI

### 问题
API 断连、COM 断开、脚本执行失败时，UI 只显示一行错误文字，没有操作入口。

### 方案
顶部显示错误横幅，带"重试"/"重新连接"/"关闭"按钮。

### 文件变更
- [新增] `src/renderer/components/ErrorBanner.tsx` — 错误横幅组件
- [修改] `src/renderer/App.tsx` — 集成 ErrorBanner

---

## 实施顺序

```
步骤 1 (宏执行) ─┐
                  ├→ 步骤 4 (结果回传) ─→ 步骤 7 (自动备份)
步骤 2 (上下文) ─┤
                  ├→ 步骤 3 (注入对话)
                  │
步骤 5 (持久化) ──┤
                  ├→ 步骤 6 (窗口管理)
                  │
步骤 8 (错误 UI) ─┘
```

步骤 1 和 2 可以并行，是最高优先级。
步骤 5-8 可以在前 4 步完成后再做。
