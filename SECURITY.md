# Security Policy / 安全策略

## Supported Versions / 支持的版本

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅ |
| < 0.2   | ❌ |

## Reporting a Vulnerability / 报告漏洞

**请勿通过公开 Issue 报告安全漏洞。**
**Do NOT report security vulnerabilities through public issues.**

请发送邮件至项目维护者，邮件标题注明 `[SECURITY] SW Copilot`。我们会在 48 小时内确认收到，并在 7 个工作日内给出初步评估。

Please email the maintainer with subject `[SECURITY] SW Copilot`. We will acknowledge within 48 hours and provide an initial assessment within 7 business days.

## Security Design / 安全设计

SW Copilot 的安全机制：

1. **数据隔离**：不上传任何 CAD 文件到外部服务器。AI 对话仅发送文本描述，不发送模型数据。
2. **密钥加密**：API Key 通过 Electron `safeStorage` 加密后存储，不明文持久化。
3. **脚本校验**：所有 AI 生成的脚本在执行前经过 `sanitizer.ts` 黑名单检查（禁止文件删除、注册表修改、网络请求等）。
4. **用户确认**：脚本执行前展示代码预览，危险操作需要二次确认。
5. **自动备份**：脚本执行前自动备份当前文档，失败时可回退。
6. **超时保护**：脚本执行超时 30 秒自动终止。
7. **进程隔离**：Renderer 通过 `contextBridge` 访问主进程，不直接暴露 `ipcRenderer`。
