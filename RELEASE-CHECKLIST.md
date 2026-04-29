# SW Copilot — 开源发布准备清单

> 版本：v0.2.0 · 作者：Raylan LIN (林日朗)

## 作者信息 / Author

| 项目 | 内容 |
|---|---|
| 姓名（中文） | 林日朗 |
| 护照英文 | LIN RILANG |
| 英文名 | Raylan LIN |
| GitHub | [@raylanlin](https://github.com/raylanlin) |
| 主要邮箱 | raylanlin@gmail.com |
| 备用邮箱 | linrion101@gmail.com / 848373656@qq.com |

---

## 发布前检查清单 / Pre-release Checklist

### 仓库文件 Repository Files

- [x] `README.md` — 中英双语，badges，对比表，架构图
- [x] `LICENSE` — GNU GPLv3，署名 Raylan LIN
- [x] `SECURITY.md` — 安全策略，联系邮箱
- [x] `CHANGELOG.md` — Keep a Changelog 格式
- [x] `AUTHORS.md` — 作者信息
- [x] `CODE_OF_CONDUCT.md` — 行为准则
- [x] `.gitignore` — 完整版
- [x] `.env.example` — 环境变量模板
- [x] `CLAUDE.md` — AI 开发规范
- [x] `.github/ISSUE_TEMPLATE/bug_report.md`
- [x] `.github/ISSUE_TEMPLATE/feature_request.md`
- [x] `.github/PULL_REQUEST_TEMPLATE.md`
- [x] `.github/workflows/build.yml` — 含 lint + test

### 文档 Documentation

- [x] `docs/CONTRIBUTING.md` — 中英双语，难度分级
- [x] `docs/USER-GUIDE.md`
- [x] `docs/DEVELOPMENT.md`
- [x] `docs/API-REFERENCE.md`
- [ ] `docs/ARCHITECTURE.md` — 需修正过时章节（见 ARCHITECTURE-patches.md）
- [ ] `docs/UI-PROTOTYPE.jsx` — 头部加注释 "Historical reference, v0.1"

### package.json 更新建议

```json
{
  "name": "sw-copilot",
  "version": "0.2.0",
  "description": "开源 SolidWorks AI 自动化助手 — 支持任意 AI 后端",
  "author": {
    "name": "Raylan LIN",
    "email": "raylanlin@gmail.com",
    "url": "https://github.com/raylanlin"
  },
  "license": "GPL-3.0-only",
  "homepage": "https://github.com/raylanlin/sw-copilot",
  "bugs": {
    "url": "https://github.com/raylanlin/sw-copilot/issues"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/raylanlin/sw-copilot.git"
  }
}
```

### electron-builder.yml 更新建议

```yaml
publish:
  provider: github
  owner: raylanlin          # 已正确
  repo: sw-copilot
```

---

## GitHub 仓库设置 / GitHub Repo Settings

登录 GitHub → Settings → 以下项目建议开启：

| 设置 | 建议 |
|---|---|
| Description | 开源的 SolidWorks AI 自动化助手，支持任意 AI 后端 |
| Website | （可填 Roadmap 页面 URL，待部署后填写） |
| Topics | `solidworks`, `ai`, `automation`, `vba`, `electron`, `cad`, `llm`, `openai` |
| Sponsorships | 可开启 GitHub Sponsors（后续） |
| Issues | ✅ 开启 |
| Discussions | 建议 v0.3 前开启，社区运营 |
| Wiki | 建议关闭，统一用 docs/ |

---

## 发布 v0.2.0 Tag 流程

```bash
# 确认 CHANGELOG.md [Unreleased] 内容移入 [0.2.0]
git tag v0.2.0
git push origin v0.2.0
# → GitHub Actions 自动触发 build + dist + 创建 Release
```

Release Notes 建议包含：
- 主要变更摘要（中英）
- 下载链接说明
- 系统要求
- 联系方式

---

## 开源许可声明 / Open Source License

> SW Copilot 基于 GNU GPLv3 许可证发布。
> 自由软件，允许个人和商业使用，衍生作品须以相同许可证开源。
>
> SW Copilot is released under the GNU GPLv3 license.
> Commercial use is permitted; derivative works must also be GPLv3.

---

## 联系方式汇总 / Contact Summary

| 用途 | 联系方式 |
|---|---|
| 安全漏洞报告 | raylanlin@gmail.com （标题 `[SECURITY]`） |
| 商业合作 | raylanlin@gmail.com |
| 技术讨论 | GitHub Issues / Discussions |
| 个人联系 | linrion101@gmail.com / 848373656@qq.com |
