# SW Copilot — ARCHITECTURE.md 补丁说明

以下是需要在 `docs/ARCHITECTURE.md` 中修改的具体内容，按章节列出。

---

## §4.1 COM Bridge — 需替换 runVBAMacro / runPythonScript 代码

**删除**原有 `runVBAMacro` 和 `runPythonScript` 方法（使用 `RunMacro2` + `.swp` 的旧方案）。

**替换为：**

```typescript
// src/main/com/sw-bridge.ts
// 实际执行路径：cscript.exe > python > COM RunMacro2（三级 fallback）

class SolidWorksBridge {
  async connect(): Promise<boolean> {
    // 写入探测 VBS（UTF-16LE+BOM 编码解决中文兼容），通过 cscript.exe 执行
    // GetObject(, "SldWorks.Application") → 失败则 CreateObject
    const vbsPath = await vbsWriter.write(detectScript);
    const result = await runCscript(vbsPath);
    return result.success;
  }

  isConnected(): boolean {
    // 心跳检测：执行轻量 VBS 脚本读取版本号
    if (!this._connected) return false;
    try {
      return this.runHealthCheck(); // 见 health.ts
    } catch {
      this._connected = false;
      return false;
    }
  }

  async getContext(): Promise<SWDocumentContext> {
    // context-collector.ts：采集文件名、类型、特征树、尺寸等
    // 注入到每次 AI 请求的 system prompt
    return contextCollector.collect();
  }
}

// scripts/engine.ts — 三级执行路径
async function runScript(code: string, lang: 'vba' | 'python'): Promise<ScriptResult> {
  // 1. 执行前备份（backup.ts）
  const backupPath = await backup.save();
  try {
    if (lang === 'vba') {
      // VBA → VBS 转换（vba-macro-writer.ts，10 步规则）
      const vbs = vbaToVbs(code);
      // 写入 UTF-16LE+BOM 临时文件（vbs-writer.ts）
      const vbsPath = await vbsWriter.write(vbs);
      // cscript.exe 执行，结果通过临时 JSON 回传
      return await runCscript(vbsPath);
    } else {
      // Python 路径（需用户安装 pywin32）
      return await runPython(code);
    }
  } catch (err) {
    // 执行失败：保留备份，提示用户路径
    return { success: false, error: String(err), backupPath };
  } finally {
    // 清理临时 .vbs 文件
  }
}
```

---

## §6 项目结构 — 需更新为实际结构

将 §6 中的目录树替换为：

```
sw-copilot/
├── package.json
├── electron-builder.yml
├── tsconfig.json / tsconfig.main.json / tsconfig.renderer.json / tsconfig.preload.json
├── vite.config.ts
├── .env.example
├── CLAUDE.md                         # AI 开发规范
├── SECURITY.md                       # 安全策略
├── AUTHORS.md                        # 作者信息
├── src/
│   ├── shared/
│   │   ├── types.ts                  # 所有接口 & 类型
│   │   ├── ipc-channels.ts           # IPC 频道常量（唯一来源）
│   │   ├── presets.ts                # 模型预设 & DEFAULT_CONFIG
│   │   └── sw-tools.ts              # 26 个 SW 工具定义（元数据）
│   ├── main/
│   │   ├── index.ts                  # 应用入口、窗口管理
│   │   ├── ipc/
│   │   │   └── handlers.ts           # IPC 处理器集中注册
│   │   ├── llm/
│   │   │   ├── adapter.ts            # BaseLLMAdapter 抽象基类
│   │   │   ├── anthropic.ts          # Anthropic 协议（原生 fetch + SSE）
│   │   │   ├── openai.ts             # OpenAI 兼容协议
│   │   │   ├── sse.ts                # 手写 SSE 流式解析器
│   │   │   ├── factory.ts            # createAdapter() 工厂
│   │   │   ├── code-extract.ts       # 代码块提取
│   │   │   ├── context-window.ts     # token 估算 & 消息截断
│   │   │   ├── errors.ts             # 错误归一化 → LLMErrorInfo
│   │   │   └── prompts.ts            # 系统提示词（支持动态上下文拼接）
│   │   ├── com/
│   │   │   ├── sw-bridge.ts          # cscript/VBS 连接管理（非 winax）
│   │   │   ├── health.ts             # 心跳监控
│   │   │   ├── context-collector.ts  # 文档上下文采集
│   │   │   ├── tools.ts              # 工具元数据导出
│   │   │   └── vbs-writer.ts         # VBS 文件写入（UTF-16LE+BOM）
│   │   ├── scripts/
│   │   │   ├── engine.ts             # 脚本执行引擎（cscript > python > com）
│   │   │   ├── sanitizer.ts          # 安全校验（VBA/Python 分语言黑名单）
│   │   │   ├── backup.ts             # 执行前自动备份
│   │   │   ├── vba-macro-writer.ts   # VBA → VBS 10 步转换
│   │   │   ├── generators/
│   │   │   │   ├── index.ts          # 注册表 + generateScript() + checkCoverage()
│   │   │   │   ├── vba-helpers.ts    # mmToM / degToRad / vbaString / wrapMain
│   │   │   │   ├── sketch.ts         # 草图
│   │   │   │   ├── feature.ts        # 特征（拉伸/切除/旋转/倒角/阵列/镜像/尺寸）
│   │   │   │   ├── document.ts       # 文档操作
│   │   │   │   ├── assembly.ts       # 装配体
│   │   │   │   ├── export.ts         # 导出
│   │   │   │   └── batch-query.ts    # 批量查询
│   │   │   └── templates/
│   │   │       └── export-pdf.py     # 预置脚本模板
│   │   └── store/
│   │       ├── config.ts             # 配置持久化（safeStorage 加密 API Key）
│   │       ├── chat-store.ts         # 对话历史 CRUD
│   │       └── env-fallback.ts       # .env 文件解析 + 协议映射
│   ├── preload/
│   │   └── index.ts                  # contextBridge 暴露 window.api
│   └── renderer/
│       ├── index.html / main.tsx
│       ├── App.tsx                   # 纯编排层
│       ├── components/
│       │   ├── Sidebar.tsx / StatusDot.tsx
│       │   ├── Chat.tsx / ChatMessage.tsx / ChatInput.tsx
│       │   ├── SettingsModal.tsx
│       │   ├── Automations.tsx / automations-data.ts
│       │   ├── ToolsList.tsx
│       │   └── ErrorBanner.tsx
│       ├── hooks/
│       │   ├── useLLM.ts / useSWStatus.ts / useTheme.ts
│       ├── themes/index.ts
│       └── styles/global.css
├── tests/                            # node:test 单元测试（11 个文件，161 用例）
├── docs/
│   ├── ARCHITECTURE.md / DEVELOPMENT.md / USER-GUIDE.md
│   ├── API-REFERENCE.md / CONTRIBUTING.md
│   └── UI-PROTOTYPE.jsx              # v0.1 历史参考原型
└── assets/
    ├── icon.ico / icon-256.png
```

---

## §7.2 打包配置 — 修正 owner 占位符

将 `owner: yourname` → `owner: raylanlin`

---

## §8 路线图 — 与 README 对齐

将 Phase 1–4 替换为：

```
- [x] v0.1.0 — MVP 基础架构（Electron + LLM + COM + 26 Tools）
- [x] v0.2.0 — 稳定版（Bug 修复 + CI/CD + .env fallback + 文档完善）
- [ ] v0.3.0 — 高级特性（视觉感知 + Agent Loop + Function Calling）
- [ ] v1.0.0 — 生态建设（MCP Server + 多 CAD + 商业授权）
```

---

## §9 对比表 — COM 方式已正确，无需改动 ✅

## 附录 A — 移除 winax，保留正确依赖

```json
{
  "electron": "^28.3.3",
  "react": "^18.3.1",
  "typescript": "5.3",
  "electron-store": "^8.2.0",
  "uuid": "^9.0.1",
  "electron-builder": "^24.9.0"
}
```
注：LLM 通信使用原生 `fetch` + 手写 SSE，无任何 AI SDK 依赖。

---

## 文档头部版本号

将 `> 技术方案 v1.0` 改为 `> 技术方案 v0.2 · 2026-04-29`
