# Changelog

本文件记录 Millwright 的所有重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **项目重命名（v0.2.4）**：仓库从 `sw-copilot` 改名为 `Millwright`，本地目录 `projects/sw-copilot/` → `projects/millwright/`。所有历史版本链接保持指向旧仓库地址（GitHub 重定向生效），仅 `[Unreleased]` 链接更新到新仓库。

## [Unreleased]

## [0.2.14] - 2026-07-24

### Fixed (P16 — COM 属性/方法歧义修复：'str'/'tuple' object is not callable)

**诊断**

P15 早绑生效了——错误从 'int' 变成 'str'/'tuple'，`unsuppress_component`
也**能执行了**（`GetComponents(True)` 正常返回列表，只是模型没猜中
组件名才报 "not found"）。

剩下是镜像问题：早绑之后 SolidWorks 一批**无参 getter 在类型库里是
属性 (propget)**，代码却用 `()` 调：
- `list_components`：`c.GetPathName()` → propget 返回 str → `'str' object is not callable`
- `check_interference`：`mgr.GetInterferences()` → propget 返回 tuple → `'tuple' object is not callable`
- `list_features`：遍历里 `GetTypeName2()` / `IsSuppressed()` 同类问题（+ 少数版本成员名不同 → `找不到成员`）

**修复**

`bridge.py` 加公开助手 `sw_get(obj, name, *args)`：成员是方法就调用、
是属性就取值——无参 getter 不用再关心当前 SW 版本把它定义成方法还是
属性。把 `query.py` / `feature.py` 里所有无参 getter 读取全部走
`sw_get`，并给遍历套上逐项 try/except（一个别扭成员不再拖垮整个
查询）。`mass_properties` 增加 `CreateMassProperty` → `CreateMassProperty2`
回退。

带参成员（`GetComponents(True)` / `SelectByID2(...)` / `Get5(...)`）一定
是真方法，不动。

### Files changed (3)
- `sidecar/sw_agent/bridge.py` (OVR) — 含 P13/P15 + P16 `sw_get`
- `sidecar/sw_agent/tools/query.py` (OVR) — 所有无参 getter 走 sw_get + 逐项容错
- `sidecar/sw_agent/tools/feature.py` (OVR) — 含 P13 + 遍历套 sw_get + 逐项容错

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 装机回归（重点）
- "把动力套装解除压缩"：`list_components` **返回真实组件树** → 模型拿到准确 `Name2` → `unsuppress_component` 一步成功
- `list_features` / `check_interference` 不再报 not-callable
- `mass_properties` 若之前是 CreateMassProperty 缺失，现在走 CreateMassProperty2

### 备注
- 组件名格式：SolidWorks 里组件 `Name2` 通常是 `动力套装-1` 这种（实例后缀 `-1`）。有了 `list_components`，模型不用再猜。
- 首次工具调用仍会因 makepy 缓存生成慢几十秒（P15 已知项），之后正常。

## [0.2.13] - 2026-07-23

### Fixed (P15 — COM 绑定修复：'int' object is not callable + 找不到成员)

**诊断**

P14 已生效（Python 组件在跑、`rebuild_model` 成功）。现在跑期 COM
绑定 bug：

- `list_components` / `unsuppress_component` / `check_interference` 全部
  `'int' object is not callable`。三者都先调
  `ctx.require(DOC_ASSEMBLY, ...)` → `m.GetType()`；`rebuild_model`
  不走 require 所以正常。
- `list_features` / `mass_properties` 报 `-2147352573 找不到成员`
  （`DISP_E_MEMBERNOTFOUND`）。

**根因**

sidecar 用 win32com **动态（后期）绑定**，没有类型库信息，导致
SolidWorks 成员误解析——方法被当属性返回其 int 值（`GetType` 被
当属性 → `GetType()` = 调用 int → 崩），或干脆解析不到
（`FirstFeature` / `CreateMassProperty` → 找不到成员）。这是
pywin32 + SolidWorks 的经典坑。

**修复**

`bridge.py` 连接改为**早期绑定**：`gencache.EnsureDispatch(GetActiveObject(...))`
加载类型库，方法归方法、属性归属性，一次性修好全部这类误解析。
makepy 不可用时回退动态绑定（不比现状差）。额外加 `_member()`
容错助手兜底 `GetType`（早绑正常调用；万一回退动态、属性化也能
取到 int）。

### Files changed (1)
- `sidecar/sw_agent/bridge.py` (OVR) — 含 P13 全部内容 + P15 早绑

### 注意
- **首次工具调用会慢一下**（几十秒）：EnsureDispatch 第一次要生成
  SolidWorks 类型库的 makepy 缓存，之后走缓存恢复正常。握手不受
  影响（`ready` 在任何 COM 访问前就发了，不会误触发 VBS 回退）。
- gen_py 缓存写在 `%TEMP%\gen_py`，embeddable Python 可写。

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 装机回归（重点）
- "把动力套装解除压缩" → `list_components` 正常返回组件树 →
  `unsuppress_component` 一步成功
- `list_features` / `mass_properties` / `check_interference` 不再报错
- 若 `mass_properties` 仍 `找不到成员`：说明该 SW 版本是
  `CreateMassProperty2`，把报错发我，单独钉一行（早绑修不了不存在的
  成员名）

## [0.2.12] - 2026-07-23

### Fixed (P14 — Python 组件启动修复，截图问题的真因)

**诊断（已由源码坐实）**

用户截图里模型说"工具集中没有压缩/解压缩功能"+ 主动提议写 VBA
—— 这是 VBS 回退路径的行为。`src/shared/sw-tools.ts` 的 VBS 工具
目录里**根本没有 suppress/unsuppress**；而 Python 组件的
`sidecar/sw_agent/tools/assembly.py` 里**有** `suppress_component`
/`unsuppress_component`。
→ **Python 组件在装机版从未启动成功**，一直在用 VBS 回退，所以
少了一批只有 Python 侧才有的工具（含解压缩、analyze_view 等）。

**根因**

v0.2.11 内置的是 **embeddable 版 Python**，其 `._pth` 文件会
**禁止把当前目录加入 sys.path**。启动用的是 `python -m sw_agent`
（依赖 cwd 可导入）→ 在 embeddable 上必然 ModuleNotFoundError →
进程握手前就退出 → 静默回退 VBS。开发机（系统 Python）会自动加
cwd 所以从来没复现。

**修复**

不再用 `python -m sw_agent`，改为按脚本路径启动
`sidecar/_bootstrap.py` —— 它先把自己所在目录插进 sys.path，
再用 `runpy` 以 `__main__` 方式运行 sw_agent（与 `-m` 等价），
不依赖解释器是否自动加 cwd，embeddable / 系统 Python 都可靠。

启动失败时把 **Python 的真实 stderr 尾部**带进错误信息（原来只有
`code=1`，看不到 ModuleNotFoundError）。以后再出问题日志直接告诉
我们原因。

### Files changed (2)
- `sidecar/_bootstrap.py` (NEW) — 9 行 bootstrap，自己目录塞进 sys.path
  + runpy 启动 sw_agent
- `src/main/com/sw-sidecar.ts` (OVR) — spawn bootstrap + stderr 环形
  缓冲 + 失败原因透出（含 P10/P12 全部内容）

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13（本地 WSL 跑通）

### 装机回归
- 日志出现 `[sidecar] ... ready`（不是 `falling back to VBS`）
- "解压缩动力套装"一步完成（suppress_component 是 Python 侧工具）
- `analyze_view` 截图分析可用
- 若仍失败：错误信息现在带出 Python stderr（例
  `ModuleNotFoundError: No module named 'win32com'` → pywin32 没打进
  包；或路径问题），把那行发我

### 顺带确认（给打包环节）
- `resources/sidecar/_bootstrap.py` 和 `resources/sidecar/sw_agent/__main__.py` 都应存在
- `resources/python/python.exe` 存在（installer 105 MB 已说明 vendor/python 打进去了）

## [0.2.11] - 2026-07-23

### Fixed (P13 — API 规范性 + Python 测试 + 遗留清理)

5 处 API 修复（对应审查报告编号）：

| # | 修复 | 文件 |
|---|------|------|
| 1 | `select_plane` 真中文回退（前视/上视/右视基准面）—— 中文模板零件上 `start_sketch` 能用 | `sidecar/sw_agent/bridge.py` |
| 2 | `chamfer` 改距离-距离型（原来角度-距离配 0 度角必失败） | `sidecar/sw_agent/tools/feature.py` |
| 3 | `SetSystemValue3` 配置参数 1→2（真·所有配置），`modify_dimension` 和 `add_dimension` 两处 | `sidecar/sw_agent/tools/feature.py` + `sketch.py` |
| 4 | sidecar COM 附着加版本 ProgID 遍历（与 VBS 侧 `AttachSW` 同款） | `sidecar/sw_agent/bridge.py` |
| 5 | `fillet_edges` 加 try/except + 快照检测兜底，失败给**人话错误**而不是 COM 异常 | `sidecar/sw_agent/tools/feature.py` |

### Python 测试骨架

离线测试 15 个用例（schema / 必参 / 单位换算 / P13 回归点），mock Context
无需 SolidWorks — `pytest sidecar/tests -q` 即可跑。CI 新加 `Python
lint + tests` step（ubuntu runner 上跑 ruff + pytest）。

### 清理

- 删一次性脚本 `scripts/fix_vbs_encoding_bridge.py`（P8/P8.1 时代
  一次性修过 Bridge 编码，修复已合入源码，本地脚本无意义）

### 遗留（需真机验证，不在本补丁内）

`# VERIFY` 位置参数调用（`extrude` / `cut` / `revolve` / `pattern` /
`mirror`）—— 这些只能真机验证。装机时哪个工具报错把错误信息发我，
我按 SW 版本钉参数。

### Files changed (5)
- `sidecar/sw_agent/bridge.py` (OVR)
- `sidecar/sw_agent/tools/feature.py` (OVR)
- `sidecar/sw_agent/tools/sketch.py` (OVR)
- `sidecar/tests/test_sw_agent.py` (NEW)
- `scripts/fix_vbs_encoding_bridge.py` (DEL)

### Hand-edits (2)
- `.github/workflows/ci.yml` — 加 `Python lint + tests` step（pip install
  ruff pytest + ruff check + pytest sidecar/tests）
- 删除一次性脚本 `scripts/fix_vbs_encoding_bridge.py`

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

## [0.2.10] - 2026-07-23

### Fixed (P12 — 零依赖打包)

合并 P9 / P10 / P11 全部内容 + 三处同类问题清扫：

| 修复 | 内容 |
|------|------|
| P9 | 连接检查/文档采集输出编码问题 → VBS 输出纯 ASCII（`\uXXXX` 转义），`CStr(True)` 老 bug 修 |
| P10 | Python 组件起不来假成功 → `cleanup()` reject + `start()` 语义修正 + 文案「边车」→「Python 组件」 |
| P12a | `engine.ts` Python 路径硬编码 `'python'` → 统一走 `resolvePythonPath()` |
| P12b | `sw-sidecar` 开发模式下 resourcesPath 指错目录（开发时 sidecar 从来找不到） → `resolveSidecarCwd()` 实际探测 |
| P12c | 路径解析分散 → 收口到新模块 `src/main/python-path.ts`（唯一来源） |

**解释器解析优先级**：
内置 `resources/python/python.exe` → 系统 PATH `python` → 都没有则
自动回退 VBS 引擎（26 个工具照常，仅少 `analyze_view` 截图分析）。

### Files changed (8)
- `src/main/python-path.ts` (NEW) — 路径解析单一来源
- `src/main/com/sw-sidecar.ts` (OVR) — `cleanup()` reject + `start()` 语义修正 + 移除 dead import
- `src/main/com/sw-bridge.ts` (OVR) — 纯 ASCII stdout + `\uXXXX` 转义 + AttachSW On Error Resume Next
- `src/main/scripts/engine.ts` (OVR) — Python 路径统一走 `resolvePythonPath()`
- `scripts/prepare-python.ps1` (NEW) — 打包前下载 embeddable + 装 pywin32 + 自验证，幂等
- `electron-builder.yml` (hand-edit) — extraResources 补 `vendor/python`
- `.github/workflows/build.yml` (hand-edit) — 加 "Prepare bundled Python runtime" step
- `package.json` (hand-edit) — `dist` script 先 `prepare-python.ps1` 再 build
- `.gitignore` — `vendor/`（构建产物）

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

### 装机回归（Raylan 在 Windows 跑）
- 干净虚拟机（无 Python、无网络）装新 exe：绿点 + 中文标题正常 + 发消息 agent 调工具正常 + `analyze_view` 可用
- 删掉 `resources/python/` → 自动回退，不崩
- `npm run dev` 开发模式 → sidecar 能找到

## [0.2.9] - 2026-07-23

### Fixed (P10 — "边车未运行"回退失效)

**真 bug**：`sw-sidecar.ts` 的 `cleanup()` 用 **resolve** 解除 `start()`
的等待。当 python 不存在或边车秒退（缺 pywin32 / sidecar 目录没
打进安装包）时，`start()` 返回成功，handlers 标记 `sidecarReady = true`
跳过 VBS 回退，第一个 RPC 才报「边车未运行」并作为 agent 错误抛给
用户。

修复：
- `cleanup()` 改为 **reject** 所有等待中的 `start()`——死掉的
  边车不可能再「看起来就绪」
- `start()` 语义修正：已就绪→立即返回；握手进行中→加入等待
  （原实现 `if (this.proc) return` 会在握手期间直接假成功）；
  未启动/已死→重新 spawn
- 每个 waiter 带自己的超时清理，避免泄漏

修复后 handlers 现有代码不用动：`start()` 抛错 → `sidecarReady = false`
→ 自动走 VBS agent 回退，**26 个生成器工具照常可用**。

### 文案清理：「边车」→「Python 组件」

所有用户可见文案改干净：
- 「Python 组件未运行——请安装 Python + pywin32，或忽略此错误
  （将自动使用内置 VBS 引擎）」
- 「Python 组件启动超时——请确认已安装 Python 并执行过
  pip install pywin32」
- 「Python 组件已退出」
- 「Python 组件调用超时」

「边车」只留在代码注释里。

### Files touched (1)
- `src/main/com/sw-sidecar.ts` — P10 drop-in，hash
  `0c8d7ecf1ff8377e16cfa25fca5a13f8111ea039`

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

### 装机版额外隐患（不在本补丁内）

`electron-builder.yml` 是否把 `sidecar/` 打进了 `extraResources`
——如果没打包，装机版的边车路径永远不存在，所有用户都走 VBS
回退。想让边车在装机版可用需要：

```yaml
extraResources:
  - from: sidecar
    to: sidecar
```

且用户机器需要 python + pywin32（README 应写明；没有也不影响使用，
只是走 VBS 路径）。

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

[Unreleased]: https://github.com/raylanlin/Millwright/compare/v0.2.14...HEAD
[0.2.14]: https://github.com/raylanlin/Millwright/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/raylanlin/Millwright/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/raylanlin/Millwright/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/raylanlin/Millwright/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/raylanlin/Millwright/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/raylanlin/Millwright/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/raylanlin/Millwright/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/raylanlin/Millwright/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/raylanlin/Millwright/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/raylanlin/Millwright/compare/v0.2.4...v0.2.5
[0.2.3]: https://github.com/raylanlin/sw-copilot/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raylanlin/sw-copilot/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raylanlin/sw-copilot/compare/v0.1.0...v0.2.1
[0.1.0]: https://github.com/raylanlin/sw-copilot/releases/tag/v0.1.0
