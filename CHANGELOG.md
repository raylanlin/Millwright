# Changelog

本文件记录 Millwright 的所有重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **项目重命名（v0.2.4）**：仓库从 `sw-copilot` 改名为 `Millwright`，本地目录 `projects/sw-copilot/` → `projects/millwright/`。所有历史版本链接保持指向旧仓库地址（GitHub 重定向生效），仅 `[Unreleased]` 链接更新到新仓库。

## [Unreleased]

## [0.2.103] - 2026-08-04

### Changed (P110 v3 — zip distribution instead of portable exe)

The portable single-file .exe hung on startup (several seconds with no window),
so releases now ship an extract-and-run .zip — same content as the old
win-unpacked directory users preferred.

- `electron-builder.yml`: win.target `portable` → `zip`; artifactName back to
  plain `Millwright-<ver>-x64.zip`.
- `.github/workflows/build.yml`: upload artifact + Create Release now ship
  `release/*.zip`; the Verify step inspects the zip name instead of the exe.

### Changed

- `electron-builder.yml` — zip target
- `.github/workflows/build.yml` — zip artifacts + release
- `package.json` — 0.2.103

## [0.2.102] - 2026-08-04

### Changed (P110 — retire the NSIS setup installer, ship portable only)

The Windows setup installer (Millwright-Setup-*.exe) was repeatedly reported
unusable, so tag builds now ship ONLY the portable single-file build.

- `electron-builder.yml`: win.target `nsis` → `portable`; artifactName now
  `Millwright-Portable-<ver>-x64.exe`; the nsis config block was removed.
- `.github/workflows/build.yml`: dropped the `Package (NSIS installer)` step
  and the `Millwright-Setup` artifact upload; the remaining package step runs
  `npm run dist` which now produces the portable exe; the release uploads
  `release/*.exe` (the portable build).
- The verify step still checks `release/win-unpacked/resources` + a version-
  carrying exe name — both are produced by the portable target, so the gate
  stays intact.

### Changed

- `electron-builder.yml` — portable target only
- `.github/workflows/build.yml` — drop NSIS steps, upload portable exe
- `package.json` — 0.2.102

## [0.2.101] - 2026-08-04

### Fixed (P109 — 重试提示等很久才出现，重试后仍失败)

症状：v0.2.100 开始出现「（网络波动，自动重试 1/2…）」提示，但每条
提示之间要等很久，重试完仍失败。

根因：llmFetch 的两个栈（net.fetch / undici）都受外层 120s idle timeout
保护——DNS 解析失败 / 连接拒绝时，每次尝试要挂 120s 才放弃。两个栈
× 三轮重试 = 好几分钟，用户看到的就是「等很久才出第一条重试提示」。

修法（net.ts）：
- 新增 fetchWithConnectTimeout：**连接阶段 20s 短超时**——fetch()
  resolve 意味着响应头已到，之后才是 SSE body（那是外层 idle timeout
  的职责，长思考不受影响）；连接阶段 20s 内失败立即放弃切栈。
- isTransient 识别自有 'connect timeout' 错误，纳入重试。
- 效果：DNS/连接失败从「挂 120s」变成「20s 快速失败」，两个栈每轮
  最多 40s，重试提示按时出现，总等待从分钟级降到秒级。

### Changed

- `src/main/llm/net.ts` — 连接阶段短超时 + connect timeout 识别

## [0.2.100] - 2026-08-04

### Fixed (P108 — 流式工具调用失败: net::ERR_NAME_NOT_RESOLVED)

症状：v0.2.96 切到 net.fetch（Chromium 网络栈）后，DNS 失败报
`net::ERR_NAME_NOT_RESOLVED`，且不重试、不分类，裸抛英文。

根因有两个：

1. **llmFetch 结构性 bug**：net.fetch 非瞬态失败时 `break` 直接跳出
   整个循环——注释说“给 undici 一次机会”，但 break 把 undici fallback
   永远跳过了。两个栈（Chromium 走系统代理 / undici 直连）行为不同，
   一个能通时另一个可能不通，必须每轮都试两个。
2. **Chromium 错误格式没被识别**：net.fetch 的失败不带 Node 风格的
   `code`（EAI_AGAIN / ENOTFOUND 等），诊断全在 message 里
   （net::ERR_NAME_NOT_RESOLVED）——TRANSIENT 集合和
   NETWORK_ERROR_CODES 都匹配不上，于是不重试、不分类。

修法：
- `net.ts`：新增 CHROMIUM_TRANSIENT 正则（net::err_name_not_resolved /
  connection_refused / timed_out / dns_ 等），isTransient() 同时看
  code 和 message；每轮尝试先 net.fetch、失败立即试 undici（不再 break）。
- `errors.ts`：解析 net::ERR_* 消息——DNS 类（name_not_resolved/dns_）
  归 LLM_NETWORK_ERROR 并附提示「检查本机网络/代理/hosts 或 API 地址
  拼写」；超时类归 LLM_TIMEOUT。

### Changed

- `src/main/llm/net.ts` — Chromium 错误识别 + 双栈 fallback 修复
- `src/main/llm/errors.ts` — net::ERR_* 分类 + DNS 提示

## [0.2.99] - 2026-08-04

### Added (P107 · issue #1 ② — run_shell 工具 + 默认关闭的开关)

在 search_files（只读）之上补真正的 shell 能力，但**默认关闭**，
需要的人打开并自担风险：

- **`enableShell` 配置**：默认 `false`。关闭时 run_shell 被折叠进
disabledTools，模型既看不到也调不到（同 Tools 页开关通道）——
攻击面为零。
- **run_shell 工具**（sidecar）：执行 shell 命令，自带护栏：
  - 超时 30s 硬限制（超时 kill 进程树）
  - 输出截断 4000 字符
  - 工作目录白名单：仅临时目录 / 当前文档目录，不接受任意路径
  - 非交互：stdin 关闭、无终端
- **确认门**：run_shell 归入 IRREVERSIBLE——任何审批模式（含
permissive/auto 之外的所有）每次执行都弹确认卡。
- **设置页开关 + 风险说明**：勾选开启，附中文/英文说明。

### Changed

- `src/shared/types.ts` — LLMConfig 加 enableShell
- `src/shared/presets.ts` — DEFAULT_CONFIG.enableShell = false
- `sidecar/sw_agent/tools/shell.py`（新增）— run_shell 受限执行
- `sidecar/sw_agent/server.py` — 注册 shell 模块
- `src/main/agent/agent-loop-sidecar.ts` — run_shell 进 IRREVERSIBLE
- `src/main/ipc/handlers.ts` — enableShell=false 时过滤 run_shell
- `src/renderer/components/SettingsModal.tsx` — 开关 + 说明
- `src/renderer/i18n/strings.ts` — enableShell 文案（zh/en）

## [0.2.98] - 2026-08-04

### Added (P107 · issue #1 ② — search_files 只读搜索工具)

需求：agent 需要找到本机 SolidWorks 模板文件（.prtdot/.asmdot/.drwdot），
但没有搜索手段。

设计决策（安全第一）：**不做通用 shell 工具**。命令黑名单防不住绕过
（cmd /c、powershell -enc、for 循环、环境变量展开都是口子），且工具
输出/文件名/文档描述都是提示注入面——通用 shell 等于把整台机器交给
可能被注入的模型。真正的需求是「找模板文件」，一个只读搜索就够。

`search_files` 安全边界（硬规则）：
- **只读**：只做 glob 匹配 + 目录遍历，不执行命令、不写、不删，
  永远不改系统状态
- **根目录白名单**：root 参数只能是 templates / programdata /
  programfiles / user 四个枚举，不接受任意路径
- **模式白名单**：pattern 只允许文件名 glob 字符（* ? [] 字母数字
  _-.() 空格），拒绝路径分隔符、盘符、..、绝对路径——不可能越出根目录
- **深度限制**：遍历最多 6 层，防止意外扫全盘
- **结果截断**：默认 20 条、上限 50 条，防刷爆上下文
- **权限错误静默跳过**：用户目录下常有不可读子目录，不能因此整体失败

### Changed

- `sidecar/sw_agent/tools/search.py`（新增）— search_files 只读搜索
- `sidecar/sw_agent/server.py` — 注册 search 模块

## [0.2.97] - 2026-08-04

### Fixed (P107 — GitHub issue #1：liaozhi0520 反馈的 9 个问题，8 个已修)

#### ⑨ 达到最大轮数后继续执行报错（tool_calls 没有响应消息）

症状：会话达到最大轮数（24）停止后，点继续时报
`assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'`（如 list_features:1）。

根因：工具执行循环里单个调用抛异常（RPC 超时 / SW 卡顿）会直接跳出
循环，剩余 tool_calls 没得到响应，history 残留不完整的协议——下一次
请求被 API 拒绝。

修：
- 每个工具调用包 try-catch——失败也 push toolMsg（错误结果），循环继续
- 收尾 summary 前扫描 history，孤儿 tool_calls 自动补「未执行」响应

#### ⑦ API timeout 后 agent loop 不重试直接退出

根因：runTurn 抛错无 catch，一次瞬态网络错误（timeout/DNS/reset）就
杀死整个会话。

修：runTurnWithRetry——LLM_TIMEOUT / LLM_NETWORK_ERROR 等瞬态错误
自动重试 2 次（800ms 退避），期间发「网络波动，自动重试」提示；
持久失败才传播。

#### ① new_part 在无默认零件模板时失败

根因：`GetUserPreferenceStringValue` 返回空就 raise，没尝试安装目录的
标准模板。

修：_fallback_template——扫描常见模板位置（ProgramData / ProgramFiles，
含中英文模板名），找到就用；找不到才报错。

#### ⑤ 信息流中输入图片没有渲染

根因：ChatMessage.tsx 全文没有 images 引用——用户带图消息在消息流里
根本不显示图片（输入框有预览，发送后消失）。

修：user 消息渲染 images 数组（内联缩略图）。

#### ⑧ SSE 返回时始终滑到底部，上滑被中断

根因：Chat.tsx 每次消息变化强制 scrollTop = scrollHeight。

修：检测用户是否在底部（48px 内）——在底部才自动跟随，上滑阅读时
不打扰。

#### ③ 设置窗口保存按钮不在 Footer

修：Actions 行 sticky 定位到窗口底部，滚动设置内容时按钮始终可见。

#### ④ 确认操作没有铃声提醒

修：ConfirmCard 出现时播放两音提示（Web Audio 合成，无需音频文件）。

#### ⑥ 权限模式改动不能应用到 running 会话

根因：approvalMode 是会话启动快照，运行中改设置不生效。

修：saveConfig 缓存最新模式，wantsConfirm 每次调用动态读取
（getApprovalMode）——设置保存后下个工具调用立即生效。

#### ② shell 工具（未做）

安全敏感：给 agent 任意 shell 能力风险大。已用①的模板 fallback 覆盖
「找不到模板」场景；如需真 shell 工具需确认范围（只读搜索 vs 完整
执行）。

### Changed

- `src/main/agent/agent-loop-sidecar.ts` — ⑨⑦⑥
- `src/main/ipc/handlers.ts` — ⑥ 传 getApprovalMode
- `src/main/store/config.ts` — ⑥ approvalMode 缓存
- `src/renderer/components/Chat.tsx` — ⑧ 智能滚动
- `src/renderer/components/ChatMessage.tsx` — ⑤ 图片渲染
- `src/renderer/components/ConfirmCard.tsx` — ④ 确认铃声
- `src/renderer/components/SettingsModal.tsx` — ③ Footer 按钮
- `sidecar/sw_agent/tools/document.py` — ① 模板 fallback

## [0.2.96] - 2026-08-03

### Fixed (P106 — 网络连接失败 EAI_AGAIN：应用不走系统代理)

症状：升级后报「⚠️ 网络连接失败 (EAI_AGAIN)」，重新配置也不行。
浏览器正常，只有应用连不上。

根因：所有 LLM 请求走全局 `fetch`（undici），**不走系统代理**。
机器上开 Clash/VPN（系统代理模式）时，应用绕过代理直连 DNS，
解析失败就报 EAI_AGAIN（DNS 临时故障）——浏览器走系统代理所以
正常。另外 Node 18+ 默认 DNS 按 verbatim 顺序解析，IPv6 路由
损坏也会表现成 EAI_AGAIN。

修法（新增 `src/main/llm/net.ts` 统一网络层）：

- **llmFetch()**：优先用 Electron `net.fetch`（Chromium 网络栈，
  自动遵循系统代理 / PAC / Windows 注册表代理配置），非 Electron
  环境（测试）回退全局 fetch。
- **重试**：EAI_AGAIN / ENOTFOUND / ECONNREFUSED / ECONNRESET /
  ETIMEDOUT 等瞬时错误自动重试 2 次（400ms 退避）——DNS 抖动
  一次重试通常就过了。
- **initNetStack()**：启动时 `dns.setDefaultResultOrder('ipv4first')`，
  避免 IPv6 优先解析触发 EAI_AGAIN。
- openai.ts / anthropic.ts / vision.ts 共 5 处 fetch 全部换成 llmFetch。

### Changed

- `src/main/llm/net.ts`（新增）— llmFetch + initNetStack
- `src/main/llm/openai.ts` / `anthropic.ts` / `vision.ts` — 换 llmFetch
- `src/main/index.ts` — 启动时 initNetStack()

## [0.2.95] - 2026-08-03

### Fixed (P105 — 电机支架测试抓出的三个真问题)

#### ① build_part 报「attempted relative import beyond top-level package」

打包解释器用 runpy.run_module("sw_agent", run_name="__main__") 启动，
函数体内的 `from ..verify import` 相对导入在深层相对跳转时 __package__
损坏，build_part 直接报废（模型只能退回单步）。

修：改为模块级绝对导入 `from sw_agent.verify import ...`——启动时加载，
任何问题在启动暴露而不是第一次 build_part 调用才炸。

#### ② create_plane 负偏移失效（基准面2 建在了 front 面上）

offset=-45 的 InsertRefPlane(8, -0.045, ...) 在这台机器上负号被丢弃，
基准面2 落在 Z=0（front 面），不是 Z=-45。不管 MiniMax 还是 DeepSeek
都踩同一个坑——工具问题，不是模型问题。

修：负偏移改用「正值 + Flip 约束」——InsertRefPlane(8, abs(offset),
15, 0, 0, 0)，15 = swRefPlaneReferenceConstraint_Flip，这是文档化的
距离约束反向方式。

#### ③ delete_feature 静默撒谎（报告成功但一个都没删）

模型连续删十个特征全报 `{"deleted": name}`，实际零删除——SolidWorks
弹「非当前激活特征无法删除」。两个原因：
  1. 激活草图阻止删除其他特征——删除前没退出；
  2. EditDelete() 的拒绝被当成成功返回。

修：删除前退出激活草图；删除后验证特征树——名字还在就报错（含常见
原因提示），绝不再假装成功。

### Changed

- `sidecar/sw_agent/tools/batch.py` — verify 改为模块级绝对导入
- `sidecar/sw_agent/tools/reference.py` — 负偏移用 Flip 约束
- `sidecar/sw_agent/tools/feature.py` — delete_feature 退出草图 + 删除后验证

## [0.2.94] - 2026-08-03

### Fixed (P104 — thinking 被截断报错后，思考图标一直转)

症状：流式调用中途报错（P102/P103 那种 terminated/timeout），
ThinkingBlock 旁边的「工作中」图标永远在转。

根因：agent 事件流里 `done` 分支会调 `settleReasoning()` 清掉
reasoning step 的 streaming 标记（停掉图标），但 `error` 分支漏了
——它只清了全局思考指示器（setThinkingRound(null)）和 pending，
reasoning step 的 `streaming: true` 保留，ThinkingBlock 就一直转。

修：error 分支补 `settleReasoning()`，与 done 对齐。

### Changed

- `src/renderer/hooks/useLLM.ts` — error 分支 settleReasoning

## [0.2.93] - 2026-08-03

### Fixed (P103 — 思考吃光 maxTokens → 流被服务器掐断 terminated)

症状：首次回答思考 61807 chars 后「流式工具调用失败: terminated」。

根因：`terminated` 是服务器端掐断连接——推理模型的思考与回答共用一个
max_tokens 预算（P54 注释早就警告过），61k 字符思考 ≈ 30-40k tokens，
撞上默认 32768 上限后服务器直接断开。P102 修好后思考能跑更久，于是
撞上下一堵墙。

修法：

- `openai.ts` maxTokens()：按 provider 给合理默认——
  - minimax → 131072（M3 推荐输出上限，硬上限 524288）
  - deepseek → 65536
  - 其他 → 32768（安全兜底）
  用户仍可在设置里覆盖。
- `env-fallback.ts`：4096 → 65536（4096 是前推理时代的默认，思考模型
  第一段 scratchpad 就烧完）
- `errors.ts`：识别 undici 的 `terminated` / UND_ERR_SOCKET，报错明确
  指向「思考可能超出 maxTokens，去设置里调大」，不再是裸 terminated

### Changed

- `src/main/llm/openai.ts` — maxTokens 按 dialect 提高默认
- `src/main/store/env-fallback.ts` — 默认 4096 → 65536
- `src/main/llm/errors.ts` — terminated 识别 + 明确提示

## [0.2.92] - 2026-08-03

### Fixed (P102 — 流式工具调用 timeout：思考到一半被固定总超时杀掉)

症状：长任务里「流式工具调用失败: timeout」，发生在模型思考期间。

根因：withTimeout 是**固定 120 秒总超时**——不管流里有没有输出，到点就
abort。推理模型（MiniMax M3 / DeepSeek）思考可能超过 120 秒，第一个
token 还没出来就被杀。

修法：流式路径改用 **idle timeout**——每个 SSE 事件都 reset 计时器，
只有流长时间完全静默（默认仍 120s）才算超时。思考中的 reasoning_delta
本身就是流量，天然续命。

- adapter.ts：新增 withIdleTimeout（idle 语义 + reset()），withTimeout
  改为其包装（非流式路径语义不变）
- openai.ts：chatStream / chatWithToolsStream 改用 idle timeout，
  循环内每个事件 reset()
- anthropic.ts：chatStream / chatWithToolsStream 同样处理

### Changed

- `src/main/llm/adapter.ts` — withIdleTimeout + reset
- `src/main/llm/openai.ts` — 两个流式循环 reset
- `src/main/llm/anthropic.ts` — 两个流式循环 reset

## [0.2.91] - 2026-08-03

### Fixed (P101 — thinking 回传：DeepSeek/MiniMax 要求历史里带推理)

之前的策略是「reasoning 永不回传」（thinking.ts 注释：resending thousands of
"let me reconsider" tokens eats the context window）。查证官方文档后发现这
与两家主用提供商的 API 要求相反：

- DeepSeek（thinking_mode 指南）：两个 user 消息之间如果有工具调用，中间
  assistant 的 reasoning_content **必须**参与上下文拼接并回传给 API
- MiniMax M3（工具使用 & 交错思维链）：核心最佳实践是回传每次 Response 的
  全部信息，尤其是 thinking/reasoning_details；OpenAI 兼容模式下 content
  会包含 <think> 标签，需完整保留
- OpenAI 风格（reasoning_effort）：不暴露 reasoning，无需回传

修法（按 dialect 区分）：

- `ChatMessage` 新增 `reasoning?: string` 字段，与 content 分开存
- agent-loop 主循环 + P46 nudge 分支：assistant 消息带 reasoning 入历史
- `openai.ts` 请求构造：assistant 消息按 dialect 回传——
  - deepseek → `reasoning_content: <推理文本>`
  - minimax/qwen/zhipu → 把推理重新包回 `<think>…</think>` 拼进 content
  - 其他 → 不回传（未知网关乱猜字段是硬 400）
- `context-window.ts`：msgTokens 把 reasoning 计入估算（否则裁剪会低估占用）
- anthropic 路径保持现状：thinking blocks 需要签名才能回传，纯文本塞回
  content 会被当普通文本，不如不回传（不带不报错，带了签名无效才报错）

### Changed

- `src/shared/types.ts` — ChatMessage 加 reasoning 字段
- `src/main/agent/agent-loop-sidecar.ts` — 两处 history.push 带 reasoning
- `src/main/llm/openai.ts` — reasoningHistory() 按 dialect 回传
- `src/main/llm/context-window.ts` — msgTokens 计入 reasoning

## [0.2.90] - 2026-08-03

### Fixed (P100 — Benchmark #1 电机支架抓出的问题)

#### ① build_part 批量静默失败的根因：验证只看特征树，被草图骗了

Benchmark 里 build_part 报 10 步 ok、实际零几何。根因：start_sketch
每步都会在特征树加「草图N」，特征数一直涨，verify 只看特征树增长
就判 ok —— 而 extrude 没建成时没有任何信号。

修：snapshot 加实体数（bodies），实体特征必须让实体数增长
（切除豁免，只验特征树）；包围盒退居次位当兜底。

#### ② sketch_rounded_rectangle 不在验证表里

P97 加了工具但 verify 的 _SKETCH_ADDERS 没同步 → 批量里画没画进去
无人验证。已加入。

#### ③ precheck 不查必填参数

benchmark 里 create_plane plane=front（缺 base）过了预检、执行到
第 11 步才炸，前 10 步白跑。precheck 现在用 registry schema 检查
整个计划的必填参数，开跑前拦截。

#### ④ create_plane 返回值不传递 → 模型猜「基准面1」

create_plane 现在把平面名写进 scratch["last_plane"]，start_sketch
支持 plane="last"，后续步骤不用猜名字。

#### ⑤ fillet_edges 加 feature 参数（horizontal 命中过宽）

多特征零件上 horizontal 会命中所有水平边（底板顶边+侧板交线同类）。
fillet_edges(feature="凸台-拉伸2") 把范围限定到指定特征；新增
edge_select.select_feature_edges 按特征取边（优先创建时快照）。

#### ⑥ save_document 的 Save3 类型不匹配

Save3 在不同版本签名不同（tuple vs int），benchmark 里报类型不匹配。
改走 com_call 防御路径。

#### ⑦ 提示词：拉伸前显式 exit_sketch

批量模式下 ActiveSketch 可能没接续上（实测「每步 ok 但零几何」），
引导模型在草图工具后、extrude 前显式 exit_sketch。

### Changed

- `sidecar/sw_agent/verify.py` — bodies 计数 + _SKETCH_ADDERS + precheck 必填参数
- `sidecar/sw_agent/edge_select.py` — 新增 select_feature_edges
- `sidecar/sw_agent/tools/feature.py` — fillet_edges 加 feature 参数
- `sidecar/sw_agent/tools/reference.py` — create_plane 存 last_plane
- `sidecar/sw_agent/tools/sketch.py` — start_sketch 支持 plane="last"
- `sidecar/sw_agent/tools/document.py` — save_document 走 com_call
- `src/main/llm/prompts.ts` — exit_sketch 引导

## [0.2.89] - 2026-08-03

### Added (P99 — feature_map + 按需规则段 + 装配体约束)

#### ① feature_map: 创建时记录特征拓扑

「倒这个特征的哪条边」一直靠事后 GetFaces 实时枚举 —— 后续特征可能
重塑或隐藏那些面,事后读不到就退化。现在 extrude/cut_extrude/revolve
创建成功时立即快照该特征的 faces/edges 指纹(包围盒坐标,与引用无关),
存进 scratch["feature_map"][feature_name]。edge_select 的 feature 策略
优先读快照,快照缺失才回落实时枚举。

这也是对 Mecagent 差距的正面回应之一:复杂模型死于模型手算几何,生成器
+ 创建时拓扑记录是把几何算术从模型手里拿走的第一步。

指纹函数统一移到 bridge.py(edge_fingerprint),feature 记录与 edge_select
匹配用同一个实现 —— 修掉 P96 之前那个"同一件事两个实现分叉"的隐患。

#### ② 按需规则段: read_guidance(section)

长段静态规则(工具用法/建模要点/宏细则/工程图/生成器/装配体)从
AGENT_SYSTEM_PROMPT 移出,每轮不再必付这几百 token。模型需要时调
read_guidance 按段读取,提示词只留一行索引。和 SolidPilot 把近静态
规则放 resource 侧是同一思路:工具描述每轮必付,规则正文用到才读。

#### ③ 装配体工具移出 build_part

build_part 自动创建的是零件文档(P94),insert_component/add_mate/
suppress/unsuppress/list_components 放进去必然失败。现在进 _FORBIDDEN,
装配体只能走独立调用序列。

### Changed

- `sidecar/sw_agent/bridge.py` — record_feature_map + edge_fingerprint
- `sidecar/sw_agent/tools/feature.py` — 四个创建点挂 feature_map
- `sidecar/sw_agent/edge_select.py` — feature 策略优先读快照;指纹统一
- `sidecar/sw_agent/guidance.py` + `tools/guidance.py` — 新增 read_guidance
- `sidecar/sw_agent/server.py` — 注册 guidance 模块
- `sidecar/sw_agent/tools/batch.py` — 装配体工具进 _FORBIDDEN
- `src/main/llm/prompts.ts` — 长段规则换成 read_guidance 索引

## [0.2.88] - 2026-08-02

### Fixed (P98 — 装机验证抓出的四个真问题)

#### ① edges="top"/"bottom" 永远找不到边（最严重）

P97 在 `_bucket_edges` 里加了 top/bottom 桶,但 `_faces_buckets` 的
buckets 字典只建了三个键 —— `for k, value in buckets.items()` 只复制
存在的键,top/bottom 的边在合并时被悄悄丢掉。圆柱上 `edges="top"`
永远报「找不到顶面的边」,`circular` 又把顶底两圈一起倒。

修: `_faces_buckets` 的键与 `_bucket_edges` 完全对齐(加 top/bottom)。

#### ② cut_extrude 被验证层误报 verified_failed

通孔/内腔切除不改变外包围盒 —— 这是正常行为,不是静默失败。
验证层对 cut_extrude 也要求包围盒变化,验④ 的圆角板中心孔因此
被误报 verified_failed(实际几何完全正确)。

修: cut_extrude 豁免包围盒检查,只验特征树新增。

#### ③ extrude depth 负值报错信息误导

depth=-10 落到 FeatureExtrusion3 里失败,报的却是「make sure there
is a closed sketch」—— 预检只在 build_part 里拦,单步调用没拦。

修: extrude 工具自身拒绝 depth<=0,报「extrude depth 必须 > 0」。

#### ④ steps_text-only 调用被必填校验拦截

build_part 的 steps 参数没有 default,registry 的 required-parameter
门禁在只传 steps_text 时直接拒绝 —— 模型日志里出现过
「missing required parameter: steps」,模型以为是自己的错,其实
是 schema 的 bug。

修: steps 加 default []。

### Changed

- `sidecar/sw_agent/edge_select.py` — _faces_buckets 键对齐 _bucket_edges
- `sidecar/sw_agent/verify.py` — cut_extrude 豁免包围盒检查
- `sidecar/sw_agent/tools/feature.py` — extrude 拒绝 depth<=0
- `sidecar/sw_agent/tools/batch.py` — steps 加 default

## [0.2.87] - 2026-08-02

### Fixed (P97 — 一个把 build_part 废掉的预检 bug,以及三处真问题)

#### ① 预检拒绝了每个零件的第一步(最要紧)

`extrude` 被列进 `_REQUIRES_BODY` —— 可拉伸创建的正是第一个实体,
这条规则等于拒绝掉最基本的序列 `start_sketch → 画轮廓 → extrude`。
实测 build_part 连拒两次完全正确的计划,模型只能退回单步。
`extrude` / `revolve` 移出;`cut_extrude` 留着(没有实体确实无从切除)。

#### ② 会话暂存跨文档泄漏

新建零件后 `_state` 仍报上一个文档的 `last_feature`。`ctx.scratch`
从没在换文档时清过 —— extrude 缺省会去选 `last_sketch`,fillet 的
feature 策略会去找 `last_feature`,在新文档里都指向不存在的名字。
`new_part` / `new_assembly` / `new_drawing` / `open_document` 以及
复用空零件那条路,统一清 `last_sketch` / `last_feature` /
`edge_strategy` / `edge_probe`。

#### ③ 圆柱只想倒顶面,却把底面一起倒了

`count: 4` 不是重复计数 —— SolidWorks 把整圆柱面拆成两个半圆柱面,
顶圈底圈各是两段圆弧边。问题在语义:`circular` = 所有圆形边,没法
说"只要顶面那圈"。新增 `edges="top"` / `edges="bottom"`:盖面外法向
指向 +Y / -Y,据此分上下。fillet_edges 描述写清圆柱倒角用 `top`。

#### ④ 80×50 的板做出来是 80.196×52.794

模型用 sketch_polyline 的 r10: 语法但切点算错(角点用 25 而非 30),
圆弧不与直边相切、鼓出角外。工具忠实地画了它要的东西 —— 这类错误
不会响亮失败,只有量包围盒才看得出来。新增
`sketch_rounded_rectangle(width, height, radius)`:四条直边各让出一个
r,四段真圆弧接上,端点共用同一组坐标。切点是算术题,该由工具算。

### Changed

- `sidecar/sw_agent/verify.py` — extrude/revolve 移出 _REQUIRES_BODY
- `sidecar/sw_agent/tools/document.py` — 换文档清 scratch
- `sidecar/sw_agent/edge_select.py` — 新增 top / bottom 边
- `sidecar/sw_agent/tools/sketch.py` — 新增 sketch_rounded_rectangle
- `sidecar/sw_agent/tools/feature.py` — fillet_edges 暴露 top/bottom

## [0.2.86] - 2026-08-02

### Fixed (hotfix — CI lint)

prompts.ts 模板字符串里 `status="verified_failed"` 的双引号被转义成
`\"`,在反引号模板里是不必要转义 —— eslint no-useless-escape 报错,
v0.2.84/v0.2.85 的 Build 都挂在这。去掉多余转义。

## [0.2.85] - 2026-08-02

### Fixed (P96 — 审 P92–P95 的实现: 五个真 bug)

#### ① 验证层的草图检查是死代码(最要紧)

`_SKIP` 里放了 start_sketch / exit_sketch,而 verify_step 开头第一句就把
_SKIP 全return 了 —— 下面两个专门为它们写的分支永远走不到。
「草图到底开没开」恰恰是最该抓的静默失败。两个都已移出 _SKIP。

#### ② 两个零件生成器也被跳过

create_spur_gear / create_stepped_shaft 在 _SKIP 里 —— 可「齿轮报告成功
但零件没成型」是追过好几轮的问题。新增 _PART_GENERATORS 分支,按实体
特征验: 特征树必须增长、包围盒必须变化。

#### ③ 预检不知道拉伸会消耗草图

has_sketch 置 True 后永不清。extrude/cut_extrude/revolve 后 SolidWorks
自动退出草图,所以「start_sketch → sketch_rectangle → extrude →
sketch_circle」能过预检、到运行时才炸。新增 _CONSUMES_SKETCH,三个
特征执行后清掉 has_sketch。(顺带注掉 _REQUIRES_BODY 里的死条目
start_sketch。)

#### ④ 视图旋转角度不能为负

angle 在 _POSITIVE_PARAMS 里,rotate_view 没进豁免表 —— 「往回转 30 度」
这种正确计划被预检拒掉。已加豁免(连同 chamfer 的角度)。

#### ⑤ P93 只堵了一个入口

selected_count() 数任意选中实体这个坑,P93 在 feature.py 的 fillet_edges
堵了,但 edge_select.select() 的 selected 分支还开着 —— 拉伸后的残留
选中会让它返回 1。选择只在 edge_select 一个模块做,校验也在这里:
现在也走 selected_edge_count(),没有边就明说当前选中了什么;混有
面/特征则拒绝,不悄悄多做。

#### 顺带: _probe_feature 是 _feature_strategy 的复制粘贴

两份各自走「找特征 → 取面 → 取边 → 去重」约 30 行重复,已分叉过一次
(8 对 4 双重计数两条路径分别修)。抽成 _feature_edges(),诊断和真实
选择从此同一个答案。

### Changed

- `sidecar/sw_agent/verify.py` — _SKIP 移出四项 + _PART_GENERATORS +
  _CONSUMES_SKETCH + 角度豁免
- `sidecar/sw_agent/edge_select.py` — selected 分支走 selected_edge_count
  + 抽出 _feature_edges

## [0.2.84] - 2026-08-02

### Added (P95 — build_part 满血验证层 + 伪宏模式)

目标: 同时拿到「一次性长宏的一体性」和「单步驱动的可验证性」—— 模型
一口气写完整个零件（伪宏，steps_text），执行走加固工具，每步用几何
验证兜底，宏出错不再「找不到在哪」。

#### 验证层（新增 verify.py）

- `snapshot(ctx)` — 执行前/后各拍一张: 特征名列表 / 包围盒 / 草图实体数
- `verify_step(name, params, before, after)` — 按工具类别对比快照:
  - 特征类: 特征树必须新增（工具说成功但没建成 = 静默失败，当场抓住）
  - 实体特征: 包围盒必须变化
  - 草图实体类: 草图段数必须增加
  - start/exit_sketch: 激活状态必须切换
- `precheck(plan)` — 开跑前静态检查整个计划:
  - 序列依赖: 草图工具前必须有 start_sketch；实体工具前必须有实体
  - 数值合理性: depth/radius/count/spacing 等必须 > 0

#### build_part 三个新状态

- `rejected` — 预检拦下（计划本身有错，整批重提还会被拦）
- `verified_failed` — 工具没报错但几何验证不通过（静默失败）→ 换建模
  方式，不是重试同样步骤
- `ok` — 每一步的 result 都带 `_verified` 字段（证据，不是门禁）

#### 伪宏模式（prompts.ts）

- 优先用 steps_text 写整段宏式序列（每行一步，像写宏一样一口气写完），
  一体性最强
- 失败只重发剩余步骤（steps 列出已成功的）
- verified_failed = 换一种建模方式（sketch_fillet 代替 fillet_edges）的信号

### Changed

- `sidecar/sw_agent/tools/batch.py` — 接入 precheck / snapshot / verify_step
- `src/main/llm/prompts.ts` — 伪宏模式引导 + 验证状态说明

## [0.2.83] - 2026-08-01

### Changed (P94 — 交互逻辑五项优化)

#### ① build_part 无文档时自动新建零件

之前: 模型先 build_part 报 "No document is open" → new_part → 整批重发,
白烧一轮。现在 build_part 执行前检测到无文档,直接自动 new_part 再跑整批。

#### ② feature 策略回归(几何指纹去重)

P91 删掉 feature 是因为身份去重(IsSame / COM 指针 / 相邻面对)在这台
机器上全部失效,每条边被数两次。P94 换成**几何去重**:一条边的包围盒
坐标与引用无关,从哪个面拿到同一条边 hash 到同一个 key。

feature 现在是最准的策略 —— 范围限定到最近特征创建的边:
- 用户说「圆柱顶面边」= 最近特征(凸台-拉伸)的边,不再把整个文档
  18 条圆边全捞进来(circular 的老问题)
- 策略顺序: feature → faces → box(probe 也会报告 feature)

#### ③ 每个工具结果附带 _state 文档快照

模型反复用 list_features / analyze_view 确认"我在哪"。现在每个工具返回
都带 \`_state\`:{文档名/类型, 特征数, last_feature, 当前选中}。定位自己
用它,不再每轮查询。快照失败降级为部分字段,不会让工具失败。

#### ④ 提示词: 能结构化确认的别截图

- 收尾核对优先 list_features / 查询 / 包围盒,只有"形状像不像"才用
  analyze_view 截图
- 明确 circular 会选中全文档所有圆边,复杂零件想倒"某个特征自己的边"
  直接说清特征;edges="selected" 会校验选中的确实是边(混面/特征拒绝)

#### ⑤ 工具返回结构化统一(承 ③)

build_part 失败已带机器可读 steps 清单;fillet 失败带 attempts;现在
统一补上 _state 快照,模型不再需要猜"当前状态是什么"。

### Changed

- `sidecar/sw_agent/tools/batch.py` — build_part 无文档自动 new_part
- `sidecar/sw_agent/edge_select.py` — feature 策略回归(几何指纹去重)+ probe 报告
- `sidecar/sw_agent/bridge.py` — 新增 doc_state()
- `sidecar/sw_agent/server.py` — call 结果附带 _state
- `src/main/llm/prompts.ts` — 结构化确认优先 + circular/selected 语义

## [0.2.82] - 2026-08-01

### Fixed (P93 — edges="selected" 不再静默倒错边)

装机验证圆柱题时抓到:新建零件后**没有任何人手动选边**,
`fillet_edges(edges="selected")` 却报 count=1 成功,而且顶面+底面
两条边都被圆角了。

根因: `selected_count()` 数的是**任意选中实体**(边/面/特征/草图都算)。
拉伸完后 SolidWorks 保留残留选中状态(拉伸特征或轮廓),count 到 1 →
走 selected 分支 → FeatureFillet3 对那个面/特征作用 → 它的所有边全被
圆角。这正是 P45.1 注释里记录过的同款坑,当时只在非 selected 分支堵了,
selected 分支既不清残留也不校验类型。

修:
- `bridge.py` 新增 `selected_edge_count()` — 只数 `swSelEDGES`(2),
  同时返回选中里的其它类型
- `fillet_edges` selected 分支: 无边 → 报错(带当前选中类型详情);
  边混面/特征 → 拒绝并提示只选边,而不是悄悄多做

### Changed

- `sidecar/sw_agent/bridge.py` — 新增 `selected_edge_count()`
- `sidecar/sw_agent/tools/feature.py` — selected 分支类型校验

## [0.2.81] - 2026-08-01

### Fixed (P92 — 木匠审代码发现的两个 bug)

#### ① `edges="all"` 绕过 faces,永远选不全

`_faces_strategy` 用 `buckets.get(which, [])`,但 buckets 只有
vertical/horizontal/circular 三个键 —— `"all"` 永远取到空 → faces
返回 0 → 落到 box。而 box 的底面点在等轴测视角下不可见,
`fillet_edges(edges="all")` 在箱体上最多选 8/12,非箱体直接失败,
尽管 faces 明明能一次给出全部边。

修: `which == "all"` 时合并三个桶。

#### ② 部分成功被静默当作成功

`select()` 只检查 `Picked.__bool__`（selected > 0）就缓存策略并返回,
不校验 selected == found。找到 4 条只选中 3 条时会静默倒 3 个角、
用户以为 4 个都圆了 —— 十轮前「只有两个角是真圆角」的精确复发路径。

修: selected < found 时不缓存、清空选择、把差异记进错误继续试下一个
策略,全部失败时错误信息里带上「找到 X 只选中 Y」。

### Changed

- `sidecar/sw_agent/edge_select.py` — `_faces_strategy` 支持 `all` 合并;
  `select()` 部分成功不再静默

## [0.2.80] - 2026-08-01

### Removed (P91 — 删掉会说错的那条策略)

#### `feature` 策略删除

连续两轮报 `vertical: 8`(方块只有 4 条竖棱)。相邻面统计说明原因:

```
feature: {'side': 32, 'cap': 16}    ← 正好是 faces 的两倍
faces:   {'side': 16, 'cap': 8}
```

它逐个面收集边,每条边进来两次;去重在这台机器上做不到 —— 同一条
边的两个引用是两个不同的 COM 包装,指针不同,`IsSame` 又静默失败。
P90 的三级去重全部失效。

不修第三次了,删掉。`faces` 走 `body.GetEdges()`,每条边只访问一次,
根本不需要去重。一个会悄悄说错的策略比不存在更糟。

#### 诊断不再超时

`probe()` 原来对 3 条策略 × 3 类边各跑一次完整选择流程,9 次选中再
清空,其中 box 每次还要切视图 —— 上一轮它超时了一次。

现在拓扑只遍历一遍,三类边一起分出来;box 只在 faces 一条都没选中
时才试(它本来就是兜底)。faces 可用时诊断写 `"skipped": "faces 策略
已可用，未测试坐标兜底"`。

### Result

- `faces` 正确:vertical 4/4 + horizontal 8/8,方块 12 条边全部正确归类
- 倒角可用了

### Changed

- `sidecar/sw_agent/edge_select.py` — 删除 feature 策略 + probe 不再超时
  + box 仅在 faces 全 0 时才试

## [0.2.79] - 2026-08-01

### Fixed (P90 — `faces` 通了;修 `feature` 的重复计数;宽容无法触达的接口)

#### `feature` 策略 8/16,正好翻倍

和 P89 揭穿的 24 = 12×2 同一个根因:`feature` 这条仍走「把每个面的边收
集起来再归类」,而一条边属于两个面,所以每条都进来两次。P89 改对了
`faces`,`feature` 漏改了。

现在先按边去重再归类。去重用三级判定:
- `IsSame`(这台机器静默失败,不能只靠它)
- COM 指针(`id()` 一致)
- 相邻面对(同一实体上,指向同两个面的两个引用就是同一条边)

#### `face.GetSurface/IsPlane` 访问不可用 → 从法向推断

`ISurface` 在这台机器上访问不上,`faces` 能对是因为 `Normal` 兜住了。
现在明确:能问就问(精确),问不到从法向推断(平面有确定法向,圆柱面
没有 —— 返回零长度或无意义向量)。不再当异常报告 —— 那两行重复的
「找不到成员」刷满了 `why`,把真正的发现挤掉了。

### Result

```
faces:   vertical  4 / 4
         horizontal 8 / 8    ← 顶面 + 底面各四条,正确
feature: vertical  4 / 4     ← P89 的 8 现在去掉重复
         horizontal 8 / 8    ← P89 的 16 现在去掉重复
```

### Note

十轮之后倒角应该可用了 —— 关键回归项 (判据) 「给方块四角倒 R5 圆角」
→ 四个角都要完整。`box` 策略的两条漏选是固有限制(底面在等轴测视角
下不可见),不再追;`box` 现在只是兜底,真正通用靠 `faces`。

### Changed

- `sidecar/sw_agent/edge_select.py` — `feature` 三级去重 + `ISurface` 不可达
  时从法向推断 + 不再刷「找不到成员」

## [0.2.78] - 2026-07-31

### Fixed (P89 — found:24 揭穿两个 bug,顺带说清坐标法的固有限制)

#### 「把失败悄悄变成一个看似合理的默认值」

`feature` / `faces` 报 `horizontal: found 24`,方块只有 12 条边。
这个说不通的数字同时暴露了两个 bug:

① `IsSame` 去重完全没生效。24 = 12 条边 × 2 个相邻面 —— 每条边
被数了两次,一次都没去重成功。

② 六个面全被判成了 `cap`。所以没有一条边的相邻面集合是
`{side}`,全部落进 horizontal。`_face_kind` 里 `except: return "cap"`
把失败伪装成「这是个水平面」 —— 于是「读不到法向」和「这个面
真的水平」在上层完全一样。

#### 修法: 不再走面,改为走边

原来「走每个面 → 收集它的边 → 跨面去重」,改成:

```
body.GetEdges()  →  每条边问 GetTwoAdjacentFaces2  →  按两个面的类型归类
```

每条边只访问一次,没有任何东西需要去重,也没有任何身份比较。
两个 bug 一起消失。`body.GetEdges()` 是已被证明可用的。

`_face_kind` 改了:读不到法向时返回 `"unknown"` 而不是 `"cap"`,
真实异常记进报告。相邻面出现 unknown 时明确说「无法判断这条边」。
诊断里附相邻面类型统计,一眼看出法向读没读到。

#### `box` 策略:一个能修一个不能

能修:第一次点选总是失败(P88 改探测点之前/之后都失败的是同一个
角、同一个第一次探测)。原因是视图切换后没稳定就开始点选。先发
一次丢弃的探测,再开始正式选。

不能修:底面的边在等轴测视角下不可见。8 条水平边选中 6 条,漏掉
的两条都在底面。坐标点选只能选到当前视角看得见的实体 —— 这是
这个 API 的固有限制。报告里现在会明确说明。

这确认了 box 只能是兜底:箱体的竖棱够用,水平边天然不全。
真正通用的是 feature / faces,所以本包重点在它们。

### Changed

- `sidecar/sw_agent/edge_select.py` — feature/faces 策略从走面改成走边;
  _face_kind 失败不再伪装成 cap;box 策略首次探测改为丢弃式预热
- 报告附带相邻面类型统计

## [0.2.77] - 2026-07-31

### Fixed (P88 — 修我自己的三个 bug)

#### ① `_steps_from_text() got an unexpected keyword argument 'steps'`

`_steps_from_text` 插进了 `@tool("build_part", ...)` 装饰器和 `def build_part`
之间,装饰器注册的是助手函数。这和 P78/P79 是同一个错误,犯了第二次。
助手函数移到装饰器之前,并在打包脚本加了断言:`@tool` 与 `def build_part`
之间出现任何 `def`/`class` 就直接失败,不让它再溜出去一次。

#### ② `feature.GetFaces: 'tuple' object is not callable`

`GetFaces` 在这台机器上解析成**属性**而非方法。这个坑修过好几次
(`GetTypeName2` / `EditSuppress2`),但 `edge_select.py` 是新写的又直接调用了。
现在这个模块里**每一个** COM 成员都走 `sw_get()`:`GetFaces` / `GetLoops` /
`GetEdges` / `GetSurface` / `IsPlane` / `Normal`,不再逐个踩坑逐个修。

#### ③ `box` 策略漏边(4 选中 3、8 选中 6)

上一轮首次拿到非零结果但有 1–2 条边选不中。原因是**探测点正落在角上**
—— `SelectByID2` 选离该点最近的实体,而角上是「边 + 终结它的顶点 +
交汇的两个面」的三方平局,有的边就输掉了。

这也解释了很早之前那个现象:**「四个角只有两个是真圆角」** —— 不是
倒角失败,是有的角没选中。

两处调整:
- 探测点取棱上 **40% 位置**(而不是正中),把顶点排除出竞争
- 向外偏移一丝(最小尺寸的 1%),打破与面的平局
- 万一偏移在薄壁件上过冲,**回落到精确表面点重试一次**才算失败

### Changed

- `sidecar/sw_agent/tools/batch.py` — 助手函数移到 `@tool` 装饰器之前
- `sidecar/sw_agent/edge_select.py` — 全模块走 `sw_get()` + 探测点避开角点 + 失败回落

## [0.2.76] - 2026-07-31

### Fixed (P87 — 把诊断修对 + 给 build_part 一条标量路)

#### 诊断报告从「几」改为「几 + 为什么没拿到」

上一轮 `edge_strategies` 三条全 0。但 `bounding_box` 正常返回了
40/10/30,说明 `GetPartBox` 可用——那 `box` 策略返回 0 就只能是**选择那一步**
失败,而不是「找不到边」。

问题是 `probe()` 只数最终选中数:
- 找不到任何边 → 0
- 找到 12 条但一条都选不中 → 也是 0

两种情况修法完全不同,报告却分辨不出来。这正是反复犯的同
一个错:报结果不报步骤,于是每次都只能猜下一条路线。所以本
轮**不加第四条策略**,先把报告修对。

#### `Select4` / `SelectByID2` callout 参数从裸 `None` 改 `VARIANT(VT_DISPATCH, None)`

`Select4(append, callout)` 的第二个参数是接口指针,新模块里传
了 Python 的裸 `None` — pywin32 有时会拒。`select_face` 之前就是这样
修的,新模块里又写回了裸 `None`。如果这就是元凶,那三条策略
会一起恢复 —— 它们都走同一个 `_select()`。

#### `build_part` 标量路:不再让 MiniMax 抹平数组

P78 加了 `items` schema、P79 加了容错解析、P81 加了 XML 兼容
—— 对 MiniMax 全都没用。这家厂商就是不会忠实序列化
array-of-objects,再怎么声明都一样。

新增 `steps_text` 参数,每行一个步骤,标量字符串不会被篡改:

```
start_sketch plane=top
sketch_rectangle x=-20 y=-15 width=40 height=30
extrude depth=10
```

- `steps` 为空(或没传)而 `steps_text` 有内容时自动走这条
- 值仍交给已有的 `_coerce_values` 定型,`depth=10` 到达时是数字
- 报错文案也改了:不再说「重发一次同样的结构」(那必然同样失败),
  而是直接告诉模型改用 `steps_text`

### Changed

- `sidecar/sw_agent/edge_select.py` — `found` / `selected` 分离 + `VARIANT`
  null + 探测坐标落进 `notes`
- `sidecar/sw_agent/tools/diagnose.py` — `edge_strategies` 报告新结构
- `sidecar/sw_agent/tools/batch.py` — `steps_text` 标量路 + 报错指向它

## [0.2.75] - 2026-07-31

### Refactored (P86 — 边选择收束:删 200 行八条路线,三策略各可验证)

P75–P83 在 `_edge_kind` 一个函数里堆了八条 fallback 路线,某条
返回错分类时工具会安静地倒错边。把手段当目的,困在"再加一条路线
也许这次能成"里。

新增 `edge_select.py`,三条策略:
- **feature**:最近特征的 `GetFaces` → 环 → 边(范围最小最准)
- **faces**:整个实体,按面归属推断(任意形状)
- **box**:包围盒角点坐标点选(箱体类,摆正视图后极稳)
- **selected**:用户在 SolidWorks 里自己选好(永远可用)

`probe()` 在当前模型上实际跑一遍数出各策略能选几条,失败时说人话
列出每条试过什么,告诉用户可手动选边用 `selected`。全程用对象
自己的 `.Select2()`,只有 `box` 不得不用坐标点选。

### Added

- `sidecar/sw_agent/edge_select.py` — 三策略 + probe() + select()

### Removed

- `bridge.py` 删 `_classify_by_faces` + `_edge_kind`(全部 Route A/B/C/D/0/E)
- `bridge.py` 删 `select_edges` 旧实现

### Changed

- `bridge.py` — `select_edges` 委派到 edge_select.select()
- `diagnose.py` — 三个碎片字段 → 一个 `edge_strategies`
- `feature.py` — extrude/cut_extrude/revolve 成功时记 `last_feature`
- `prompts.ts` — 撤销"圆角不许画进草图"禁令,改为优先 `sketch_fillet`

## [0.2.74] - 2026-07-31

### Fixed (P82 — 边分类换方向:靠面的归属,完全不碰边的几何)

七轮路线全挂 — ICurve 属性、顶点访问器、GetCurveParams2 任一接口
都不可达。但诊断一直显示 `bodies=1 faces=6 edges=12`,面、面的法向、
从面枚举边都可用,只有「边自己的几何」这一类 API 在这台机器上死。

不要问边「你朝哪个方向」,问「你属于哪两个面」:
- 两侧面交接 = 竖直边
- 侧面 + 顶/底面交接 = 水平边
- 圆柱面 = 圆形边

### Changed

- `sidecar/sw_agent/bridge.py` — 新增 `_classify_by_faces()`,select_edges 优先走这条路
- `sidecar/sw_agent/tools/diagnose.py` — 加 `edge_kinds_by_faces` 字段(判据)

## [0.2.73] - 2026-07-31

### Fixed (P81 — 边分类的真正答案:GetCurveParams2 在 ICurve 上,不在 IEdge 上)

诊断宏跑通,答案明确:`GetCurveParams2` 是 **ICurve** 的方法,不是 IEdge 的。
P76 找错了对象,Route 0 必然全灭。同时排除了旧猜测:`edge.GetCurve()`
在这台机器上是好的 — Route A 失败的原因是 `curve.IsLine()`/`LineParams`
这些属性在 pywin32 下取不到,而 `GetCurveParams2()` 这个方法可以。

① bridge.py Route 0 重写:edge → ICurve → GetCurveParams2,
  真机验证过的路径。曲线类型 4=LINE 2=ARC,起点终点直接算方向。
② batch.py:`build_part` 收到的是 XML 不是 JSON(MiniMax 序列化方式),
  新增 `_steps_from_xml()` 容错。
③ engine.ts:run_macro 只报「退出码 1」不给错误原文 — cscript 把
  语法错误写到 stdout 不是 stderr。stderr 空时回落取 stdout 末尾。
④ prompts.ts:不许编造工具输出 — MsgBox 弹在 SW 里模型看不到,
  要如实说「宏已执行,内容请看弹窗」,不以推算冒充真实读数。

### Changed

- `sidecar/sw_agent/bridge.py` — Route 0 改走 curve.GetCurveParams2
- `sidecar/sw_agent/tools/batch.py` — XML 步骤容错
- `src/main/scripts/engine.ts` — 失败时回落读 stdout
- `src/main/llm/prompts.ts` — 不许编造工具输出

## [0.2.72] - 2026-07-31

### Fixed (P80 — 让「未知错误」不可能出现 + 处理只有推理的一轮)

模型思考了 9443 字然后整轮崩掉 `Agent execution failed: 未知错误` ——
推理模型一轮只产出 reasoning、没有 content 也没有 tool_calls,循环没为它准备。

① handlers.ts:永不显示「未知错误」 — 新增 `describeError()` 助手,把
任何抛出的对象挖出可读信息(含 cause / stack 位置),报错必带具体类型和位置。

② agent-loop-sidecar.ts:处理「只有推理」的一轮 — 推理不为空但正文为空
且无工具调用时,nudge 一次让模型把思考转成动作,不再空转或崩掉。

③ 循环末尾兜底 — 区分「连续多轮无产出」(只有思考 / 返回为空)
与「达到轮数上限仍在工作」,分别给出可操作建议。

### Changed

- `src/main/ipc/handlers.ts` — describeError + catch 块换掉 toLLMError
- `src/main/agent/agent-loop-sidecar.ts` — 只有推理的一轮 nudge + 末尾兜底分类

## [0.2.71] - 2026-07-31

### Fixed (P79 — 修 P78 落位 bug + lint 误报 + 失败行为约束)

① `_coerce_step() got an unexpected keyword argument 'steps'` — P78 把
助手函数插进了 @tool 装饰器和 def 之间,注册错函数。助手移到装饰器前。

② 参数被当成字符串传 — 新增 `_coerce_values()`:字符串数字/布尔还原。

③ macro-lint 误判位掩码 — `FLAG_ARGS` 跳过标志位(FeatureFillet 第 0 位等),
上限 10000(超过 10 米不是可信尺寸)。

④ `suppress_feature failed: 'bool' object is not callable` —
EditSuppress2/EditUnsuppress2 走 sw_get() 容忍两种绑定形式。

⑤ 提示词:失败是报告不是即兴创作 — 同一工具最多重试一次,
失败停下报告工具名+报错原文;禁止删特征重来/new_part 另起/画进草图。

### Changed

- `sidecar/sw_agent/tools/batch.py` — 助手函数移到装饰器前 + 字符串值还原
- `sidecar/sw_agent/tools/feature.py` — EditSuppress2/EditUnsuppress2 走 sw_get
- `src/main/scripts/macro-lint.ts` — FLAG_ARGS 跳过标志位 + 10000 上限
- `src/main/llm/prompts.ts` — 失败时的行为约束

## [0.2.70] - 2026-07-31

### Fixed (P78 — build_part 参数被抹空的根因:schema 缺 items 声明)

上一轮日志里模型三次提交 build_part 都失败,参数到达时变成 `["", "", ""]`,
第四步放弃批量退回单步调用——零件7的来路。

**根因**:`steps` 参数声明成了 `type: "array"` 但没写 `items`。
厂商 function-calling 层依据 schema 序列化参数,看到一个无元素类型的数组,
就把每个嵌套对象压成了空字符串。

**修法(两层)**:
① 补 `items` schema(治本):`{type:object, properties:{tool, params}, required:[tool]}`
② 容忍被压平的形式(防复发):新增 `_coerce_step()` — 解析 JSON 字符串、
收拢平铺参数、接受多种键名,只在意图不可读时才报错。

### Changed

- `sidecar/sw_agent/tools/batch.py` — build_part steps 加 items schema + _coerce_step() 容错

## [0.2.69] - 2026-07-31

### Fixed (P75-77 合包: 边分类 + 零件堆积 + 全量 API 核对)

#### 边分类:两条新路线

**P76: GetCurveParams2/3** — 之前四次尝试失败都是因为入了 SolidWorks API 的
`I` 前缀陷阱:带 `I` 前缀的版本是给 C++ 直调接口用的(返裸指针,pywin32 拿不到),
不带前缀的返回 VARIANT 数组才是 VBA/pywin32 该用的。GetCurveParams2 的 6 元素
数组 `[0..2]起点 [3..5]终点` 可直接算方向,不需要 ICurve/IVertex。

**P75: 相邻面** — 所有读边自身几何的路由此机器全失败,但面一直可读。
一条边是两个面的交界,两侧面法向都水平 = 竖边,一个面 Y 向 > 0.9 = 水平边。

#### 零件不再堆积(P75)

`new_part` 加护栏:活动文档已是没有实体特征的零件时直接复用。
提示词:任何一步失败都不许 `new_part` 另起一份。

#### 圆角不许画进草图(P75 提示词)

`fillet_edges` 失败要报告失败原文,不许退回草图画圆角;孔用 `cut_extrude`。

#### 全量 API 核对(P77)

- `AddMate5`:对齐方向 `swMateAlign_e` 默认改 `CLOSEST`(不是反的 1),暴露 `align` 参数
- `InsertReferencePoint`:补齐 `along_curve` 类型 + `count`/`distance` 参数
- `export_stl`:STL 精度 best-effort(设不上继续导出),扩展名检查
- 其余全部正确(AddComponent5/InsertRefPlane/SetSuppression2/SaveAs 等)

### Changed

- `sidecar/sw_agent/tools/document.py` — new_part 空零件复用
- `sidecar/sw_agent/tools/assembly.py` — 配合对齐方向 + align 参数
- `sidecar/sw_agent/tools/reference.py` — 参考点 along_curve
- `sidecar/sw_agent/tools/export.py` — STL best-effort + 扩展名检查
- `src/main/llm/prompts.ts` — 一个任务一个文档 + 圆角用特征
- `sidecar/sw_agent/bridge.py` — _edge_kind 新路线(P76 在前 + P75 在后)

## [0.2.67] - 2026-07-30

### Fixed (_edge_kind Route D: IGetCurveParams2 → IEdge.IGetCurve)

v0.2.66 的路由 D 用了 `IGetCurveParams2()`——这是 **ICurve** 接口的方法,
需要先 `edge.GetCurve()` 拿到 ICurve,而 GetCurve 在 Route A 已经失败了,
所以 Route D 同样全灭,12 条边仍为 unclassified。

正确方法: `IEdge.IGetCurve()`,直接在 IEdge 上调。返回 SAFEARRAY,
第一个双精度数是曲线类型(0=直线, 1=圆, ...),后续是几何参数。
不走 COM ICurve / IVertex 接口,应在这台 SW 上跑通。

### Changed

- `sidecar/sw_agent/bridge.py` — Route D: IGetCurveParams2 → IEdge.IGetCurve

## [0.2.66] - 2026-07-30

### Fixed (P73 后续: _edge_kind 加 IGetCurveParams2 路由)

`fillet_edges` 在涉及 ICurve 接口的 SolidWorks 上失败了所有三条
分类路径（GetCurve、GetStartVertex/GetEndVertex、
GetStartVertexParams/GetEndVertexParams），导致"read 12 edges but
none could be classified"。

第四条路由 `IGetCurveParams2()` 返回纯双精度 SAFEARRAY——
不需要 ICurve 或 IVertex COM 对象。线段的开始/结束点和圆的
半径直接从双精度参数中提取。

这条路径在 ICurve/IVertex 接口均不可用的场合有效。

### Changed

- `sidecar/sw_agent/bridge.py` — `_edge_kind` 新增路由 D（IGetCurveParams2）

## [0.2.65] - 2026-07-30

### Fixed (P73 补 2: Dispatch 提到 GetActiveObject 前面)

v0.2.64 的 Dispatch 回落虽然能连上,但放在 GetActiveObject 遍历全部
ProgID **之后**才调用。这台装机 ROT 里没有注册 SW,所以先等 11 个
GetActiveObject 逐个超时(~5s),才到 Dispatch(~5s)。用户看到的是:
1. ~5s「无法连接」(边车冷启动 + GetActiveObject 排队失败)
2. ~5s VBS 0x1AD 假权限错误(回落到 bridge.refresh)
3. 再过 ~5s Dispatch 连上 → 正常

Dispatch 内部先试 GetActiveObject 再试 CoCreateInstance —— 它是
GetActiveObject 的超集。提到前面直接省掉 10s。GetActiveObject 循环
降级为回落(捕捉那些只注册版本 ProgID 不注册 bare ProgID 的装法)。

### Changed

- `sidecar/sw_agent/bridge.py` — Dispatch 提到 GetActiveObject 前

## [0.2.64] - 2026-07-30

### Fixed (P73 补: GetActiveObject → Dispatch 回落)

P73 把状态栏改为先问边车,方向对了,但边车自己的 `_connect()` 只走 `GetActiveObject`。
这台装机的 SolidWorks 不在 ROT 里注册(即便 SW 开着),所以 `ctx.sw` 持续
`MK_E_UNAVAILABLE`。`sw_status` 永远 `connected: false`,handlers.ts 落到
VBS 探针那条错的 0x1AD。

修法:`_connect()` 的 `GetActiveObject` 全失败后,加一档 `Dispatch`。
`Dispatch` 走 COM class factory,不依赖 ROT — SW 是 singleton,连回去不开新实例。

### Changed

- `sidecar/sw_agent/bridge.py` — `_connect()` 加 `Dispatch` 回落

## [0.2.63] - 2026-07-30

### Fixed (P73 — 状态栏该听边车的,而不是听那个次要探测)

上次 `sw_diagnostics` **成功返回了真实数据**(报出 feature_ids、报出"没有打开文档")—— 说明 **Python 边车连得上 SolidWorks**。真正失败的只有 `sw-bridge.ts` 里那个独立的 cscript/VBS 探测。

所以 P72 修 makepy 修错了方向:连接从来没断,断的是**次要探测**,而 UI 状态栏偏偏用它的结论把用户挡在门外,还给了一个错误的诊断(去检查 UAC 权限)。

**根本问题是架构上的:同一件事有两套独立探测,而界面信的是信息更少的那一个。** 边车持有的是工具真正跑在上面的那条连接 —— 它能读到 ActiveDoc,应用就是连上的,不管另一个探测怎么说。

#### 修法

##### ① 边车成为状态的权威来源

新增 `sw_status` 工具(Python 侧):报告连接状态与当前文档。**它永不抛异常** —— "没连上"和"没开文档"都是正常状态,应该作为数据返回而不是抛出。

`handlers.ts` 的状态处理器改为:**先问边车,边车不可用才回落到 VBS 探测**。返回里带 `source: 'sidecar' | 'vbs'`,便于以后排查。

##### ② 探测报出真实 COM 错误,不再猜

原来的逻辑是「进程在跑 + attach 失败 → 一定是 UAC 权限不一致」。这只是个推断,而它把你送去查权限,真正的 COM 错误码却从没被读出来。

现在 VBS 把第一次 `GetObject` 的 `Err.Number`/`Err.Description` 带出来(`PROC|0x… 描述`),状态里存为 `comError`,横幅括号里显示。**猜出来的诊断比原始错误码更糟。**

### Added

- `sidecar/sw_agent/tools/status.py` — `sw_status` 工具(永不抛异常)

### Changed

- `sidecar/sw_agent/server.py` — 注册 status(含 P72)
- `src/main/com/sw-bridge.ts` — 带出真实 COM 错误
- `src/shared/types.ts` — `SWStatus` 加 `comError` / `source`
- `src/renderer/components/ErrorBanner.tsx` — 横幅显示真实错误码
- `src/main/ipc/handlers.ts` — `SW_STATUS` 处理器改为优先问边车(手改)

## [0.2.62] - 2026-07-30

### Fixed (P72 — 连不上 SolidWorks 的根因:启动路径被拖死) 紧急修复

报错说的是权限,**但这台机器没有任何权限问题** —— 是被我们自己饿死的:

```
启动预热线程调用 ensure_typelib()
  → makepy 处理 sldworks.tlb(极大的类型库),几十秒到几分钟
    而且旧代码对每个注册版本都试一遍 EnsureModule,再对每个 .tlb 跑一遍 makepy
  → COM 与磁盘在这期间被打满
  → sw-bridge.ts 那边独立的 cscript 探测在 15 秒超时内 attach 不上
  → attach 失败后回落查进程,发现 SLDWORKS.exe 在跑
  → 于是报出「SolidWorks 正在运行但 COM 被拒绝,请检查权限级别」
```

报错文案对症状的描述是准的,对原因的判断完全错 —— 这也是它误导人的地方。**任何后台优化都不该有能力做到这件事。**

#### 修法:生成改为按需,启动路径不再碰它

而且这件事**本来就不必做**。P69 同时加了硬编码枚举表(`swFmCut = 6` 等),`CreateDefinition` 那条不依赖参数个数的路径**已经可用** —— 类型库只是拿到同样数字的另一种方式。拿它换掉连接可用性,买卖不划算。

- `ensure_typelib()` → 改名 `build_typelib_cache()`,**只在显式调用时才跑**,启动路径不再调用
- 只尝试**最新一个**注册版本(旧代码遍历所有版本 × 两条路线,把一个本来就慢的操作乘上了装机版本数)
- 枚举表升级为**主来源**而非兜底 —— 现在它才是 definition 路径的依据
- 诊断文案改准:类型库没生成**是正常状态**,不再暗示有问题

上一版让你去查的那个 `tried` 列表现在没意义了 —— 我们不再在启动时尝试生成,这条线索不用追了。

### Changed

- `sidecar/sw_agent/typelib.py` — 生成改按需 + 只试最新版本 + 枚举表为主来源
- `sidecar/sw_agent/server.py` — 启动预热不再生成缓存(只暖连接)
- `sidecar/sw_agent/tools/diagnose.py` — 文案改准(类型库未生成 = 正常)

## [0.2.61] - 2026-07-30

### Changed (P71 — 诊断报出 typelib 失败原因)

`sw_diagnostics` 只报 `constants_loaded: false`,查不下去 —— 三条生成路(注册表 EnsureModule / makepy / EnsureDispatch)哪条失败、为什么失败,全看不到。启动是在后台线程跑的,原因只进了日志,等某个工具出问题时早就滚没了。

#### 改动

- `typelib.py`:记住最后一次生成结果,新增 `typelib_state()`
- `diagnose.py`:输出 `tried` 列表(每条路各自的失败原因)

#### 顺带修一句误导文案

原来 `constants_loaded: false` 时会说 "CreateDefinition is unreachable" —— **这句已经不准了**。P69 加了硬编码枚举表,`feature_id("cut")` 返回 6,所以 definition 路径依然可用。现在分三种情况说清:

- 类型库加载成功
- 类型库没生成,但枚举表补上了同样的值 → **definition 路径仍可用**
- 两者都没有 → 才需要退化成猜参数个数

新增 `enum_ids_available` 字段,这个才是判断「干净路径能不能走」的依据。

### Changed

- `sidecar/sw_agent/tools/diagnose.py` — 覆盖(输出 `tried` + `enum_ids_available`)
- `sidecar/sw_agent/typelib.py` — 覆盖(`typelib_state()` + 记住最近一次结果)

## [0.2.60] - 2026-07-30

### Changed (P70 — Tools 页重做:实时工具清单 + 逐个开关)

#### ① 它显示的是错的那一套

Tools 页读的是 `sw-tools.ts` 里 26 条**写死在代码里的静态清单** —— 那是 VBS 回退引擎的目录。真正在跑的 ~50 个 sidecar 工具来自运行时的 `sidecar.list_tools()`,Tools 页**从来没连上它**。页面既不完整,连名字都对不上(`draw_rectangle` vs 实际 `sketch_rectangle`)。

现在改成读实时清单:按 category 分组、显示友好名 + raw 名 + 真实描述 + 参数列表(必填参数带 `*`)。Python 组件没起来时明确提示"当前是 VBS 引擎、工具较少",而不是拿一份假清单糊过去。

#### ② 点一下只能"预览 VBA",不能开关

预览 VBA 在纯 VBS 时代有意义,现在主路径是 sidecar,这个功能已经没有对象了 —— 去掉。

**开关是这个页面真正该有的东西**:
- **风险**:`run_macro`、`delete_feature` 可彻底禁掉(带「高风险」红标)
- **准确率**:工具列表越短,模型选工具越准

关掉的工具**在构造请求前就被滤掉** —— 模型根本看不到它存在。万一凭记忆硬造已关闭的工具名,会收到明确回复(告知已被关闭、请改用别的或让用户开启),而不是被执行。

分类标题旁有「全开/全关」。

### Added

- `src/renderer/components/ToolsPanel.tsx` — 实时清单 + 开关(取代 ToolsList.tsx)

### Removed

- `src/renderer/components/ToolsList.tsx` — 已被 ToolsPanel 取代

### Changed

- `src/main/agent/agent-loop-sidecar.ts` — 按 `disabledTools` 过滤 + 拒绝已关闭工具调用
- `src/shared/ipc-channels.ts` — 加 `TOOLS_LIST` 通道
- `src/main/ipc/handlers.ts` — 提供实时工具清单 + `runSidecarAgent` options 加 `disabledTools`
- `src/preload/index.ts` — 暴露 `window.api.tools.list()`
- `src/shared/types.ts` — `LLMConfig` 加 `disabledTools?: string[]`
- `src/renderer/App.tsx` — 换 `ToolsPanel` 渲染

## [0.2.59] - 2026-07-30

### Fixed (P69 — 早绑缓存生成不了 / 所有切除与圆角失败的共同根因)

那份日志把根因钉死了——一百轮里每次失败都带着同一行：

```
constants load: This COM object can not automate the makepy process
```

**gen_py 早绑缓存从来没生成成功过。** 后果是一条完整的因果链，末端症状离病因非常远：

```
EnsureDispatch(活动的 swApp) → 拒绝提供类型信息
  → 没有 gen_py 模块
  → win32com.client.constants 是空的
  → swFmCut 取不到
  → IFeatureManager.CreateDefinition(swFmCut)（唯一不依赖参数个数的切除写法）不可用
  → 退化成猜 FeatureCut4/27 → "接受了但不生成特征"
并且 SelectByID2(name, "SKETCH") 也解析不了 → "failed to select sketch: 草图2"
```

所以「cut_extrude 有时候好有时候不好」的真正原因，是**类型库从来没装载过**。模型花一百轮在下游试参数个数、试草图状态、试宏，全猜不到上游。

#### 修法：从注册表的 .tlb 生成，而不是从活动对象

`EnsureDispatch` 是向**活着的 COM 对象**要类型信息，这台机器的 SolidWorks 不给，而且没办法让它给。但类型库本身就在磁盘上、而且注册过——SolidWorks 装的时候就把 `sldworks.tlb` 写进了 `HKEY_CLASSES_ROOT\TypeLib`。**读注册表 + 从 .tlb 生成，完全不需要运行中的应用配合。**

新增 `sidecar/sw_agent/typelib.py`，三条路依次尝试：注册表 `EnsureModule` → `makepy.GenerateFromTypeLibSpec` → 老的 `EnsureDispatch`。注册表里的版本号是**十六进制**（"1f.0"），按十进制读会静默选错版本——单独处理了。

启动时在预热线程里跑（那个线程本来就是干这个的），失败会在日志里明说「typelib cache unavailable」，不再静默。

**兜底**：`swFmCut` 等枚举值硬编码进表里。即使类型库在某台机器上真的生成不了，definition 路径（不需要猜参数个数）依然可用。

#### 顺带修两个日志暴露的问题

**① 画完的圆没落到草图里，却报告成功。** 多次出现「圆不可见」而 `sketch_circle` 返回 ok，紧接着 `cut_extrude` 报「轮廓与实体不重叠」—— 报错听起来像规划错了，实际几何根本没到位。现在画完立刻比对草图外廓与请求的直径，不符就当场报错，并明说「不要拿这张草图去切」。

**② 新增 `sw_diagnostics` 工具。** 这个项目里每个硬 bug 都是「文档上有、这台机器上没有」：GetBodies2 挂在别的接口、ICurve 取不到、类型库拒绝生成——每次都表现为一个误导性的下游错误，都要花一轮才追回来。这个工具直接问：早绑缓存在不在、实体/面/边能不能读、边能分成几类、哪条特征创建路径可用。以后遇到「工具的失败方式不符合模型」，一次调用就有答案。

### Added

- `sidecar/sw_agent/typelib.py` — 注册表生成早绑缓存 + 枚举硬编码兜底
- `sidecar/sw_agent/tools/diagnose.py` — `sw_diagnostics` 工具

### Changed (P69 顺带覆盖 P67/P68)

- `sidecar/sw_agent/server.py` — 启动时生成缓存 + 注册 diagnose
- `sidecar/sw_agent/tools/feature.py` — definition 路径改用硬编码枚举（含 P67 切除重试）
- `sidecar/sw_agent/tools/sketch.py` — 圆落地校验（含 P65/P67）
- `sidecar/sw_agent/bridge.py` — 边分类三条路线（P67）
- `src/main/llm/prompts.ts` — 圆角矩形走 fillet_edges（P67）
- `src/shared/sw-tools.ts` — Tools 页英文化（P68）
- `src/renderer/components/ToolsList.tsx` — 同上（P68）

## [0.2.58] - 2026-07-30

### Fixed (P68 — Tools 页面英文化补齐)

英文界面下 Tools 页仍显示中文：分类标题（文档管理 / 草图 / 特征 / 装配体 / 导出 / 批量操作 / 查询）和 26 个工具的描述。

根因：`src/shared/sw-tools.ts` 里 `CATEGORY_LABELS` 和每条 `description` 都是硬编码中文，`ToolsList` 直接取用。旁边的 Automations 页早就本地化了，唯独这份数据漏了。

修法：不动 `description` 字段的类型（主进程用它当能力清单，改类型会牵连），而是**新增**并列字段 `descriptionEn`，26 条全部补齐；新增 `CATEGORY_LABELS_EN`；新增 `categoryLabel()` / `toolDescription()` 两个取值函数。`ToolsList` 改用这两个函数（三处：分类标题、按钮 title、预览弹窗副标题）。

工具名本身（`create_part` 等）是 API 标识符，不翻译。

### Changed

- `src/shared/sw-tools.ts` — `descriptionEn` ×27 + `CATEGORY_LABELS_EN` + `categoryLabel()` / `toolDescription()` 两个取值函数
- `src/renderer/components/ToolsList.tsx` — 改用 locale 取值（分类标题 / 按钮 title / 预览弹窗副标题三处）

## [0.2.57] - 2026-07-30

### Fixed (P67 — 边分类兜底 + 面草图切除 + 轮廓尺寸自检)

第 4 题（80×50×10 板四角 R10 + φ20 通孔）暴露的三个真 bug：

**① `fillet_edges` 边分类全军覆没**

`read 12 edges but could not classify any (GetCurve unavailable?)` —— `ICurve` 在这台机器上取不到，12 条边全归不了类，倒圆角直接不可用。

修法（与 P46 修 `GetBodies2` 同源）：走顶点路线。读每条边的 `GetStartVertex/GetEndVertex` → `GetPoint`，以及 `GetStartVertexParams/GetEndVertexParams`，用 p2−p1 的方向做 vertical/horizontal 判断。纯 IDispatch，**你的测试已经证明这条路走得通** —— 模型写的宏正是用 `GetStartVertexParams` 筛出了 4 条竖直边。工具没走这条路是我漏的。

**② 模型面上的草图切不动**

`FeatureCut4/27: accepted but produced no Cut feature` —— 参数被接受但没生成特征。原因是草图开在**模型面**上（`start_sketch(face="top")`）且切除时还开着。

最后一层重试：**退出草图 → 按名字选中 → 再试三个方向**。这是 SolidWorks 真正会响应的形式。

（第 4 题第一次尝试确实只差这个孔 —— 板和圆都画对了。）

**③ 带弧轮廓画出了 7940mm 的怪东西**

`bounding_box` 显示 7940×7940 而输入是 80×50。**拉伸"成功"了**，一直到量尺寸才发现不对。

修：画完立刻比对草图实际外廓与输入点的范围，超出容差就删掉重来并报出两组数字。报错里直接给可靠替代方案。

**顺带改提示词**：圆角矩形板应该 `sketch_rectangle` + `extrude` + `fillet_edges`，而不是把圆角画进草图。不只是绕开 bug —— 圆角作为独立特征，改半径只改一个数；画进轮廓里只能重画。`r<半径>:` 弧语法留给真正的异形轮廓（凸轮、连杆）。

### Changed

- `sidecar/sw_agent/bridge.py` — 边分类三条路线（ICurve → 顶点 → 顶点参数）
- `sidecar/sw_agent/tools/feature.py` — 切除新增「退出草图+按名选中」重试层
- `sidecar/sw_agent/tools/sketch.py` — 轮廓尺寸自检 + 失败清理
- `src/main/llm/prompts.ts` — 圆角矩形走 fillet_edges（含 P56/57/58/64/65）

## [0.2.56] - 2026-07-30

### Added (P66 — 一键复制 + 会话导出)

一次建模跑完，**真正有价值的是那份记录** —— 哪个工具、什么参数、SolidWorks 回了什么。现在只能一张张展开折叠卡片去看，复制不出来。

#### ① 每条消息一键复制

消息悬停时（用户消息左侧、助手消息右侧）出现一个小复制按钮，点击变成对勾。复制内容是**可读形式**：叙述文字 + 工具调用（含参数 JSON 和返回结果），不是原始对象。思考过程默认不含（太长，事后基本没用）。

#### ② 会话导出菜单（App.tsx 工具栏）

三个动作：
- **导出 Markdown** —— 按角色分节、带时间戳、工具调用是缩进代码块
- **导出 JSON** —— 完整 `AgentStep` 结构，不做任何扁平化
- **复制全部到剪贴板** —— 同 Markdown 内容

一个勾选项「包含思考过程」，默认关。工具调用默认**包含** —— 那才是这份记录的意义。空会话时菜单项灰掉。

导出用临时 object URL 触发下载，不走主进程。文件名 `millwright-YYYYMMDD-HHMM.{md,json}`。

### Added

- `src/renderer/session-export.ts` — 消息/会话 → Markdown / JSON + 剪贴板 + 下载
- `src/renderer/components/ExportSessionMenu.tsx` — 导出下拉菜单

### Changed

- `src/renderer/components/ChatMessage.tsx` — 悬停复制按钮（覆盖）
- `src/renderer/App.tsx` — 工具栏挂 `ExportSessionMenu`（手改）

## [0.2.55] - 2026-07-30

### Fixed (P66 — Verify packaged payload PowerShell ParserError)

v0.2.54 Build 在 Verify packaged payload 步骤 X 在 ParserError：脚本里 `Write-Host "installer name carries $version: OK"` —— PowerShell 把 `$version:` 当作 scope 限定符（像 `$env: $global:`），紧跟冒号时报错 "Variable reference is not valid"。

P63 加进 Verify packaged payload 时三处用了 `$version` 字面量，三处都修成 `${version}` 包起来避免歧义。门禁把自己拦住了 —— 一个语法错的校验步骤如果静默通过，比没有校验更糟，所以这次直接 bump v0.2.55 重发。

### Changed

- `.github/workflows/build.yml` —— `Verify packaged payload` 步骤三处 `$version` 改成 `${version}`

## [0.2.54] - 2026-07-30

### Added (P65 + P64 — 草图几何:真圆弧、防推断吸附、失败不留残骸)

P64 齿轮样条化折入，P64 单独分包作废。

#### 草图几何四处同源问题

**① `sketch_polyline` 也缺 `AddToDB`** — 与齿轮完全同一个病。多条 `CreateLine` 唤醒 SolidWorks 的自动几何关系推断，端点被吸附合并、加水平/竖直约束。所有多实体绘制统一走 `_direct_geometry` 上下文管理器（`AddToDB=True` + `DisplayWhenAdded=False`，退出时恢复原值）。

**② 只能画直线** — 轮廓里需要圆弧时模型只能用短直线拟合或者干脆失败。现在点可以带弧：

```
"0,0 60,0 r10:60,20 0,20"     三条直边 + 一段 R10 真圆弧
"0,0 r-8:40,0"                单段圆弧，反向凸
```

`r<半径>:` 前缀 = 从上一点沿该半径圆弧走到该点。正半径向行进方向右侧凸、负向左凸，**始终取劣弧**。

新增 **`sketch_slot`** — 腰形槽/键槽，两端是真 180° 圆弧，4 个实体一次画完。以前只能用矩形拼两个圆，既不闭合也不是真圆柱面。

**③ 失败留残骸** — `sketch_polyline` 画到一半失败只报错不清理，草图里留下断线，下次拉伸撞坏轮廓。现在记录调用前实体集合，失败时删掉本次新增的全部实体，并在报错里说明清理了几个。

`create_spur_gear` 同理：草图是它自己建的，拉伸失败时**把这张草图删掉**再抛错，不给下一次尝试留一个 20 齿坏轮廓。

**④ `sketch_arc_center` 方向不再甩给模型** — `direction` 默认从 1 改为 **0 = 自动取劣弧**。原来模型得自己猜扫描方向，猜错就得到优弧（要 60° 得到 300°），profile 直接不可用。想强制方向仍可传 1/-1。

### Changed

- `sidecar/sw_agent/tools/sketch.py` — 圆弧段 + sketch_slot + AddToDB 上下文 + 失败回滚 + 默认劣弧
- `sidecar/sw_agent/tools/machine.py` — P64 样条齿轮 + 失败自清理草图
- `src/main/llm/prompts.ts` — 圆弧语法 + 禁止折线拟合 + 腰形槽（含 P56/57/58/64）

## [Unreleased]

### Added (P63 — CI / 打包门禁加固)

发版时的两道质量门是虚设的：tag 推送不触发 ci.yml（注释明确写了），而 build.yml 里 lint/test 都是 `continue-on-error: true` —— 所以发版时测试失败照样出包。同时 sidecar 走 extraResources，TS 工具链一行都不读它，P36 那次 Python 语法错就是这么进了装机版。

三处改动落位：

- **build.yml 门禁实化** —— Lint/Test 去 `continue-on-error`，新增 Sidecar syntax check + Sidecar lint + tests，Typecheck/Lint/Test 全部 fail the build
- **两个 workflow 都加 Python 语法检查** —— `python -m compileall -q sidecar/sw_agent` 排第一步，几秒就能拦下 P36 那类语法错误
- **build.yml 新增 Verify packaged payload** —— 校验打包后必需文件齐全（sidecar/python.exe/win32com/PIL）+ 包内 sidecar 与仓库一致 + installer 文件名带正确版本号。三类历史事故（P31 旧 sidecar / 缺 Python 运行时 / electron-builder 缓存导致版本错）全在这一步现形

顺带：删了 Debug version + cache state 那步（注释里自己写着 v0.2.13 后该删）；`prepare-python.ps1` 移到质量门之后（门禁不过就别浪费时间）。

### Added

- `scripts/precommit-check.sh` 新增 `--ci-only` 旗标：跳过 package.json bump + CHANGELOG [V] 段两项检查，其余全跑（污染/compileall/握手）。白名单：`.github/**`、`scripts/*.ps1`、`scripts/*.sh`、`.ruff.toml`、`.eslintrc*`、`.prettierrc*`、`tsconfig*.json`；出现 `src/`、`sidecar/(非 *.md)`、`package.json`、`electron-builder.yml` 任一即失败。与 `--docs-only` 互斥，同时传报错。

## [0.2.53] - 2026-07-30

### Fixed (P62 — 齿轮生成器修复)

#### 两个真因

**① 齿坯拉伸失败（`failed to select sketch: 草图2`）**

`InsertSketch()` 后从未写 `ctx.scratch["last_sketch"]`，但代码又去读它 —— 拿到的是上次调用留下的旧草图名，于是 `extrude` 选了不存在的草图。

修：当场读 `ActiveSketch.Name` 写入 scratch。

**② 齿廓公式符号推反**

渐开线向前展开，要让齿向外收窄必须往回转：δ = −(π/(2z) + inv α)。

原版写成 `+π/(2z) − inv α`，数值验证（m=2, z=20, α=20°）齿根 3.6° / 分度圆 9.02° / 齿顶 **14.38°** → 齿顶宽超齿距一半，相邻齿顶粘连成圆环。

修正后齿根 10.7° → 分度圆 **9.00°**（正好齿距一半 = 标准齿）→ 齿顶 3.6°，单调收窄。

#### 顺带去掉三个失败点

原来三步：齿坯拉伸 → 单齿拉伸 → 圆周阵列（需要圆柱面当轴）。任一步失败整个齿轮就没了。

现在**一次画完整圈齿廓（20 齿 ≈ 460 个点的闭合折线）→ 一次拉伸**。不需要齿坯、不需要单齿、不需要圆周阵列、不需要选圆柱面当轴。齿顶/齿根用同半径圆弧离散连接保证轮廓闭合。

阶梯轴同样把 `last_sketch` 读取改成当场取名（同一类隐患）。

### Changed

- `sidecar/sw_agent/tools/machine.py` — 覆盖（齿轮整圈拉伸 + 阶梯轴 last_sketch 修正）

## [0.2.52] - 2026-07-29

### Added (P58–P61 — 工具词汇 + 宏逃生舱 + 工程图 + 机械件生成器)

P56/P57 折入。P56/P57 两个分包作废。

#### P58-A: 工具描述贴 SW API 名

45 个工具的描述全部加上对应 SolidWorks API 名称（如 `extrude → FeatureExtrusion3`），让模型的宏训练知识直接迁移到工具上，不冲突。

#### P58-B: `run_macro` 逃生舱 + macro-lint

- 新增 `src/main/scripts/macro-lint.ts`，对 VBScript 做四类静态检查
- 毫米值传给米制 API / `On Error Resume Next` → **错误，拒绝执行**（这两条可拦下整份 DeepSeek 宏）
- 臆造面名/返回值未接收/参数个数写死 → 警告
- lint 在确认卡之前跑，不让用户批准注定静默失败的宏
- `run_macro` 除 AUTO 外所有档位强制确认

#### P59: 工程图工具组

`sidecar/sw_agent/tools/drawing.py`，7 个工具：
- `create_drawing_of` — 三步视图+等轴测，未保存文档自动先存
- `add_drawing_view` / `add_section_view` / `list_drawing_views`
- `insert_model_dimensions` — 模型自带尺寸导入视图
- `insert_bom` — 装配图明细表
- `add_drawing_note` — 标题栏文字/公差/技术要求

#### P60/P61: 机械件生成器

`sidecar/sw_agent/tools/machine.py`，3 个工具：
- `create_spur_gear(module, teeth, thickness, bore)` — 真渐开线齿形（ISO 53），单齿镜像+圆周阵列，可啮合
- `gear_pair_geometry(module, teeth_1, teeth_2)` — 纯算术，算中心距，必须先调这个再放轴孔
- `create_stepped_shaft(steps)` — 半轮廓一次旋转成形，肩部对齐

#### 提示词更新

Y-UP 坐标系（Y=高度、X=左右、Z=前后）写入提示词开头，解决 MiniMax 把 SW 当 Z-up 笛卡尔系导致的零件躺倒问题。新增 `build_part` 用法、标准件用生成器、工程图收尾、`run_macro` 使用边界四节。

#### 新增文件

- `sidecar/sw_agent/tools/drawing.py`
- `sidecar/sw_agent/tools/machine.py`
- `sidecar/sw_agent/tools/batch.py`
- `src/main/scripts/macro-lint.ts`

#### 覆盖文件

- `sidecar/sw_agent/server.py` — 注册新增工具模块
- `sidecar/sw_agent/tools/feature.py` — 14 处 API 名词描述
- `sidecar/sw_agent/tools/sketch.py` — 9 处
- `sidecar/sw_agent/tools/document.py` — 8 处
- `sidecar/sw_agent/tools/query.py` — 5 处
- `sidecar/sw_agent/tools/assembly.py` — 4 处
- `sidecar/sw_agent/tools/reference.py` — 2 处
- `sidecar/sw_agent/tools/export.py` — 1 处
- `sidecar/sw_agent/tools/view.py` — 2 处
- `src/main/agent/agent-loop-sidecar.ts` — `run_macro` 虚拟工具 + 强制确认
- `src/main/llm/prompts.ts` — Y-UP + build_part + 生成器 + 工程图 + 宏边界

### Changed

- `src/main/ipc/handlers.ts` — `runSidecarAgent` options 加 `runMacro` 把 VBS 引擎传入

## [0.2.49] - 2026-07-26

### Fixed (P54 + P55 — 各厂商推理参数修正 + 上下文可配 + 预设 ID 更新)

接 P53 之后。**打 v0.2.49**。P54/P55 分包作废，冲突文件取最新版。

#### 截断的两个真因

1. **MiniMax 推理方言错了** — MiniMax M3 用 `thinking: {type: enabled|adaptive|disabled}`，P51 的 `detectDialect` 把它归进 `effort` 发了 `reasoning_effort`，它不认。**400 降级重试兜着所以不报错，但推理设置完全没生效**，一直跑厂商默认。
   - 修：新增 `minimax` 方言；推理等级新增 `adaptive` 档（M3 独有，模型自行判断是否需要深思）
2. **8192 输出上限太小** — 你那次推理写了 15196 字（约 5–7k token），8192 预算被吃光，回答断在半路。
   - 修：默认 8192 → **32768**（对所有厂商安全且宽裕），上限可调 512000
3. **上下文窗口现在可配置** — 设置面板新增输入（4096–2,000,000，默认 128000）。**MiniMax M3 建议 512000**（标称 1M，但 >512K 走更贵长上下文档且效果下降）

#### 各厂商参数对照（按官方文档核实，2026-07）

| 厂商 | 参数 | 说明 |
| --- | --- | --- |
| **OpenAI / Kimi** | `reasoning_effort: low/medium/high` | 标准形式 |
| **DeepSeek** | `thinking:{type}` **+** `reasoning_effort` | 两个都要发：只发 toggle 深度仍是默认 high，只发 effort 关不掉。V4 把 low/medium 都映射成 high，xhigh 映射成 max |
| **GLM / 智谱** | `thinking:{type: enabled/disabled}` | **不是 `enable_thinking`**（Roo Code / pi 报过同一个 bug） |
| **Qwen / 百炼** | `enable_thinking` + `thinking_budget` | 自建 vLLM/SGLang 部署要放进 `chat_template_kwargs` |
| **MiniMax M3** | `thinking:{type: enabled/adaptive/disabled}` | 独有 adaptive 档 |
| **Anthropic** | `thinking:{type, budget_tokens}` | 开启时按 API 要求去掉 temperature |

三处修正：① MiniMax 之前错发 `reasoning_effort`；② DeepSeek 之前只发 `thinking`、深度控制无效；③ DeepSeek 思考模式下不再白发 temperature。

#### OpenAI 自家 GPT-5 / o 系列此前必 400（必修）

两条硬规则：

- **必须用 `max_completion_tokens`**，发 `max_tokens` 直接 400
- **不接受 `temperature`**（只允许默认值）

按「host 是 openai.com / azure.com 且模型名匹配 `^(o\d|gpt-5)`」自动切换字段并省略 temperature。第三方 OpenAI 兼容网关（DeepSeek / MiniMax / GLM）不受影响，仍走 `max_tokens`。

#### Anthropic Mythos / Fable 5 常开思考

Claude Fable 5 / Mythos 5 是**常开自适应思考**，发 `thinking: {type: disabled}` 会被拒。按模型名识别，这类模型一律走厂商默认，不发 thinking 字段。

#### 预设 ID 更新（截至 2026-07 核对）

| 服务商 | 推荐模型 | contextWindow | maxTokens |
| --- | --- | --- | --- |
| OpenAI | `gpt-5.6-sol` | 1,000,000 | 32,768 |
| Anthropic | `claude-fable-5`（旗舰）/ `claude-opus-4-8` | 1,000,000 / 200,000 | 32,768 |
| DeepSeek | `deepseek-v4-pro`（强）/ `deepseek-v4-flash`（快） | 1,048,576 | 32,768 |
| MiniMax | `minimax-m3` | 512,000 | 32,768 |
| Kimi | `kimi-k2.5` | 262,144 | 32,768 |
| GLM | `glm-4.6` | 200,000 | 32,768 |
| Qwen | `qwen3.7-max` | 262,144 | 32,768 |
| SiliconFlow | — | 128,000 | 32,768 |
| Ollama | — | 32,768 | 8,192 |

**DeepSeek 旧别名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用**，预设已替换为 `deepseek-v4-pro` / `deepseek-v4-flash`。

#### 关键稳妥设计

万一方言猜错，请求返回 400 且报错文本提到我们加的字段名，**自动去掉这些字段重试一次**。猜错只会退化成"没有推理控制"，不会变成打不开的死请求。选「自动」时不发任何字段，走厂商默认。

#### 文件落位（4 覆盖 + 5 手改）

```
src/main/llm/thinking.ts                  覆盖（含 P51 + 六家方言核对 + adaptive 档 + dropsTemperature）
src/main/llm/openai.ts                    覆盖（含 P51/P54 + max_completion_tokens + 推理模型免 temperature）
src/main/llm/anthropic.ts                 覆盖（含 P53/P54 + Mythos 常开思考识别 + 默认 32768）
src/renderer/components/SettingsModal.tsx 覆盖（含 P51 + 上下文窗口 + adaptive 档 + 上限放宽）
src/shared/types.ts                       手改①（LLMConfig）
src/main/llm/context-window.ts            手改②（已支持 contextWindow，2 个 agent loop 传 opts.contextWindow，handlers 传 payload.config.contextWindow）
src/shared/presets.ts                     手改③（10 家厂商新 ID + 上下文/输出 + 替换 DeepSeek 旧别名）
src/renderer/i18n/strings.ts              手改④（contextWindow + adaptive 词条 + maxTokensHint 32768）
README.md / README.zh-CN.md               手改⑤（服务商表同步）
```

bump 0.2.47 → 0.2.49

## [0.2.47] - 2026-07-26

### Added (P51 + P52 + P53 — 真流式 + 推理可折叠块 + 工具调用提示)

一轮装完三件事：真 token 级流式、推理内容独立可折叠、推理开关/方言 + 最大输出 token。

#### ① 真流式（核心）

适配器新增 `chatWithToolsStream` —— **边收 SSE 边解析工具调用**。工具调用分片按 `index` 累加，**流结束才解析**（早解析必然拿到坏 JSON）。

新增流式帧类型 `text` / `reasoning` / `tool` / `done`。agent 循环优先走流式，适配器没实现就回落到一次性调用。

- **OpenAI 兼容**（DeepSeek / MiniMax / GLM / Qwen / Kimi / SiliconFlow / Ollama）：按 `index` 累加 `delta.tool_calls` 分片
- **Anthropic**（P53）：块结构流式——`content_block_start` 宣告块（tool_use 块带 id + name）、`content_block_delta` 携带 `text_delta` / `thinking_delta` / `input_json_delta`（工具参数）、`content_block_stop` 收尾。工具参数按块索引累加，**到 stop 才解析**。接上 Anthropic 原生 extended thinking（`thinking.budget_tokens`），推理内容走 `thinking_delta`

#### ② 推理内容独立成块，可折叠

两种投递方式都已处理：
- **独立字段** `delta.reasoning_content`（DeepSeek / Qwen / MiniMax / GLM）
- **正文内联** `<think>…</think>`（多数开源模型）—— 用增量分离器 `ThinkSplitter` 处理，连**标签被切在两帧之间**的情况也能拼回

推理走独立通道 → 独立 step → `ThinkingBlock` 组件渲染：默认折叠的一行条，流式时转圈 + **实时字数**，点开可读、自动滚到最新。**推理内容不进历史** —— 只作展示。

#### ③ 工具调用头帧后切「正在调用」提示（P52）

流式只用于**思考块和正文**。检测到工具调用头帧（函数名已确定、参数还在逐字传输）时，立刻停掉正文流式指示，显示一条 **「正在调用 · 友好工具名 · raw 名」** 转圈条；参数收完、工具开始执行时被真正的工具卡替换。清理时机覆盖 `tool_start` / `done` / `error` / 点终止。

#### ④ 推理等级 + 最大输出 token

设置面板新增：
- **推理深度**：自动 / 关闭 / 低 / 中 / 高
- **最大输出 token**：默认 8192（可调 1024–131072）

各厂商参数名不同，按 baseURL **自动识别方言**，识别不准可手动指定：

| 方言 | 参数 | 适用 |
| --- | --- | --- |
| `effort` | `reasoning_effort: low/medium/high` | OpenAI · MiniMax · Kimi |
| `deepseek` / `zhipu` | `thinking: {type: enabled/disabled}` | DeepSeek · GLM |
| `qwen` | `enable_thinking` + `thinking_budget` | 阿里百炼 |
| `none` | 不发任何字段 | 未知网关 |

Anthropic 协议走原生格式：`thinking: {type: enabled, budget_tokens: N}`（低 1024 / 中 4096 / 高 16384，自动压到 `max_tokens - 1024` 以内）；开启时按 API 要求去掉 `temperature`。

**关键稳妥设计**：万一方言猜错，请求返回 400 且报错文本提到我们加的字段名，**自动去掉这些字段重试一次**。猜错只会退化成"没有推理控制"，不会变成打不开的死请求。选「自动」时不发任何字段，走厂商默认。

#### 文件落位（10 覆盖 + 3 手改）

```
src/main/llm/thinking.ts                    覆盖（P50 + splitThinking/ThinkSplitter/方言参数）
src/main/llm/adapter.ts                     覆盖（加可选 chatWithToolsStream + ToolStreamChunk）
src/main/llm/openai.ts                      覆盖（流式工具调用 + 推理分流 + 400 降级重试）
src/main/llm/anthropic.ts                   覆盖（P53 块结构流式 + extended thinking + maxTokens 8192）
src/main/agent/agent-loop-sidecar.ts        覆盖（优先流式，含 P46/P47/P50）
src/renderer/hooks/useLLM.ts                覆盖（含 P47/P48 + 流式 delta + reasoning step）
src/renderer/components/ChatMessage.tsx     覆盖（含 P48 + 渲染 ThinkingBlock）
src/renderer/components/ThinkingBlock.tsx   新增
src/renderer/components/PendingTool.tsx     新增（P52）
src/renderer/components/SettingsModal.tsx   覆盖（含 P43 + 推理等级/方言/maxTokens）
src/shared/types.ts                         手改①（LLMConfig + AgentStep + LLMResponse）
src/renderer/i18n/strings.ts                手改②（13 zh + 13 en 词条）
src/main/ipc/handlers.ts                    手改③（无需改动）
```

Anthropic 的 `max_tokens` 默认从 4096 提到 8192。

bump 0.2.45 → 0.2.47

## [0.2.45] - 2026-07-26

### Added (P47 + P48 + P49 — 几何双路由 / 内联工具条 / 空气泡与双提示)

#### P49：几何读取双路由（核心：修倒角/面草图全线失败）

上一轮 `edges="all"` 和 `face="top"` 双双落空。两者都没有报 "could not read the part's solid bodies"，说明 P46 实体枚举成功了，但**这台机器的 `IBody2.GetFaces()` / `GetEdges()` 返回空**。`list_features` 一直好使。

修：新增 `bridge.geometry()` 返回 `(faces, edges, trace)`，两条独立路线——
- **路线 A**：实体 → `GetFaces`/`GetEdges`（原路）
- **路线 B**：拿不到面就走**特征树**（`GetFeatures(True)` → 每个特征 `GetFaces()`），边再从这些面上取
- `trace` 记录每条路线实际计数，**所有报错都带上它**（`bodies=1 faces=0 edges=0` / `features=16 faces=6` / `edges-from-faces=24`），下次失败一眼定位

`select_edges` / `select_face` / `select_axis_edge` / `select_cylindrical_face` 全部改用。顺带：面法向读不到时改用 `GetSurface().PlaneParams`；所有边都分类不了会单独报"读到 N 条边但一条都分类不了（GetCurve 不可用?）"。

#### P47：输入框内联工具条 + 图片上传

- 工具条移进输入框内：`+` 附图 · 审批模式（图标+文字+▾），无边框悬停浅底；AUTO 档文字变琥珀色
- 图片三种方式：点 `+` / **Ctrl+V 粘贴截图** / 拖进输入框；最多 4 张带缩略图；只发图不打字也能发
- 贯通 agent：多模态主模型直接读图；**纯文本主模型**先送备用视觉模型转描述再折进消息；两者都没配会明确提示，不静默丢图

#### P48：空气泡 / 双提示重叠 / 终止后还转圈

- 空 assistant 消息不渲染，并在 `done`/`cancel` 时从历史移除（不留脏数据进会话存档）
- `cancel()` 同时清 `thinkingRound`（转圈的是它）
- 双提示：删掉旧的「正在生成…」，只留带轮次的「正在思考…」

#### 文件落位（6 覆盖 + 5 手改）

```
sidecar/sw_agent/bridge.py                      覆盖（P49 双路由）
src/main/agent/agent-loop-sidecar.ts            覆盖（P46 nudge + P47 图片预处理）
src/renderer/hooks/useLLM.ts                    覆盖（P47 send(images) + P48 清理）
src/renderer/components/ChatMessage.tsx         覆盖（P48 空消息不渲染）
src/renderer/components/ChatInput.tsx           覆盖（P47 内联工具条 + 附图）
src/renderer/components/ApprovalPicker.tsx      覆盖（P47 内联样式 + SVG 图标）
src/renderer/i18n/strings.ts                    手改①（input.attachImage/removeImage + 删 chat.generating）
src/renderer/App.tsx                            手改②④（删独立 ApprovalPicker → 传 prop；handleSend 接受 images）
src/shared/types.ts                             手改③（已存在 ChatMessage.images，无需修改）
sidecar/sw_agent/tools/sketch.py                手改⑤（pairwise 兼容层 — P46 已修，本包验过）
.ruff.toml                                      手改⑤（target-version = "py39" — P46 已修，本包验过）
```

bump 0.2.42 → 0.2.45

## [0.2.42] - 2026-07-25

### Fixed (P46 — 实体枚举修复 + 写完方案自动开工 + Python 3.9 兼容)

#### 1. 「找不到竖边」的真因：实体一个都没枚举到

`GetBodies2` 声明在 **`IPartDoc`** 上，而 `ctx.model` 被定型为 `IModelDoc2`，该接口/`Extension` 上都没有该成员。P45 的 try/except 把失败吞掉返回空列表，伪装成"找不到竖边"。

修：`solid_bodies()` 三段路依次尝试——`CastTo(model, "IPartDoc")` → 纯 IDispatch 动态调度 → 原样调用；全失败时明确报错（带真实原因），不再静默返回空。`fillet_edges` 报错也区分了"读不到实体"和"没有边匹配此描述"。

#### 2. 写完方案就停，要人喊 continue

模型习惯性停下等确认。两处修：
- **提示词**：明确"写完立刻在同一轮继续调用工具开工，不要停下来等用户说继续"
- **循环层自动续跑**：首轮若只有文字（>80 字）且无工具调用，把方案压进历史 + 追加"按上述方案继续执行"再跑一轮。只在第一轮、只做一次——模型真要问问题时仍正常结束。

#### 3. Python 3.9 兼容（装机版不受影响）

`itertools.pairwise` 需要 Python 3.10+。内置 embeddable 是 3.11.9 所以装机版没事，但从源码跑或用系统 3.9 的用户会边车启动失败 → 静默回退 VBS。

修：加 try/except 兼容层，.ruff.toml 加 `target-version = "py39"` 避免 ruff 再提超版本建议。

#### 4. 修复隐患

`DEFAULT_SYSTEM_PROMPT` 模板边界反引号被 escape 脚本误伤（4186fc1），连带 `agent-loop-sidecar.ts` `opts.confirmTool!` 断言被 P46 覆盖。本包一并修正。

#### 文件落位（4 文件覆盖）

```
sidecar/sw_agent/bridge.py             (P45.1 + IPartDoc 枚举修复)
sidecar/sw_agent/tools/feature.py      (P45.1 + 报错区分)
src/main/agent/agent-loop-sidecar.ts   (P44 + 首轮自动续跑)
src/main/llm/prompts.ts                (P45 + 立即开工)
```

bump 0.2.41 → 0.2.42

## [0.2.41] - 2026-07-25

### Fixed (P45 — 考题暴露的真因：补齐"选择几何"能力 + 自选几何 + 闭合轮廓)

考题失败暴露了三类根因，本包全部修掉。同时回补了 P43 误增的 P45 评审问题（坐标轴映射、Select4 不接 mark、fillet_edges 选择未清空 + 集合名校验位置错、方向名宽容性）。

#### 1. `start_sketch(face=...)` 从头就没生效（修）

报错 `<unknown>.GetBodies2` —— 之前挂在 `ModelDocExtension` 上，实际在 **`IPartDoc`**。整个面草图失效，模型只能回退建 `基准面1`/`基准面2`（截图里那两个飘着的面）。

修：`bridge.solid_bodies()` 依次在 `model` / `Extension` 上找 `GetBodies2`，拿到实体再继续。

#### 2. 三个工具自己完成选择（最关键）

`fillet_edges` / `linear_pattern` / `mirror_feature` 原本假设用户已经在 SolidWorks 里点好边/特征。日志里看得清清楚楚：连试三次全失败，模型只能删掉单孔手画四个孔绕路，把 65 轮预算烧光。

修：三个工具自选几何。

| 工具 | 新用法 | 内部做法 |
| --- | --- | --- |
| `fillet_edges` | `edges="vertical"`（竖边/水平/圆形/全部/已选） | 遍历实体边，按曲线类型+方向分类后逐条 Select |
| `linear_pattern` | `feature="切除-拉伸1", direction="x"` | 特征按名选 (mark 4) + 找一条沿该轴的直边作方向 (mark 1) |
| `circular_pattern` | `feature="…"` | 特征 (mark 4) + **圆柱面当旋转轴** (mark 1)，不需要先建参考轴 |
| `mirror_feature` | `features="凸台-拉伸3,切除-拉伸2"` | 按名多选 (mark 1) + 基准面 (mark 2) |

新增底层能力（`bridge.py`）：`select_edges` / `select_axis_edge` / `select_cylindrical_face` / `select_feature` / `_select_entity`。

#### 3. 闭合轮廓的新工具 `sketch_polyline`

三次 `sketch_line` 端点不会自动焊接，profile 不闭合 → 拉伸必失败。

```
sketch_polyline(points="30,15 30,50 55,15")
```

自动闭合回起点。提示词已改为"闭合轮廓一律用它"。

顺带修了一个真 bug：删掉草图后 `last_sketch` 指向已不存在的名字，导致 extrude 选不到东西却报"没有闭合草图"（误导性报错）。现在会校验缓存的草图是否还在。

#### 4. 审批选择器在输入框旁（`ApprovalPicker.tsx`）

P43 把审批档位埋在设置里不对——这是**每个任务临时决定**的事，不该是全局设置。新增紧凑按钮在输入框旁：显示当前档位，点开是四档弹层（带说明），AUTO 档整个按钮变琥珀色以示醒目。设置面板保留作为默认值。

#### 5. 自查修正（P45.1 已合入本包）

复核时发现会让上述修复全部白改的三个问题：

- **坐标轴映射错了**：SolidWorks 世界坐标是 **Y 轴朝上**（Front=XY/法向 +Z, Top=XZ/法向 +Y, Right=YZ/法向 +X）。之前按 Z 朝上写导致 `face="top"` 找错面。已改为 Y-up：`top=(0,1,0)` / `front=(0,0,1)`；竖边判据改用 `abs(dy) > 0.95`。
- **`Select4` 不接受 mark**：`IEntity::Select4(Append, Callout)` 没有 mark 参数。带 mark 时优先 `Select2(append, mark)`，不带 mark 时才用 `Select4`。
- **`fillet_edges` 没清选择 + 边集合名校验位置错**：每次先 `clear_selection()`；校验提到函数开头。
- **阵列方向名更宽容**：`direction` 除 x/y/z 也接受 `up`(=Y) / `width`(=X) / `depth`(=Z)。

#### 6. UI：补回 P43 zh 段漏加的审批词条

P43 那一轮 zh 段 edit 表面上成功但实际没加到 zh Dict（en 段有、zh 段空）。本包一并补上 `settings.approval.*` zh 词条 + 短标签 + `chat.thinking*` + `chat.thinkingRound*`。

#### 文件落位（6 个文件覆盖 + 3 处手改）

```
sidecar/sw_agent/bridge.py                     覆盖（修 GetBodies2 + 选择能力）
sidecar/sw_agent/tools/feature.py              覆盖（三个工具自选几何 + 陈旧草图守卫）
sidecar/sw_agent/tools/sketch.py               覆盖（+ sketch_polyline）
src/main/llm/prompts.ts                        覆盖（工具用法要点）
src/renderer/components/ApprovalPicker.tsx     新增
src/renderer/i18n/strings.ts                   手改①（zh 段补 P43 漏的 + P45 Short 词条；en 段 P45 Short）
src/renderer/App.tsx                           手改②（挂 ApprovalPicker + onChange → setConfig + save）
```

#### 仍未做（需要真机测）

`create_reference_point` / `export_stl` —— 参数少、失败模式明显（文件在或不在），没加自适应搜索。测到报错发我。

bump 0.2.40 → 0.2.41

## [0.2.40] - 2026-07-25

### Added (P43 — 待办清零：面草图 + 审批分级 + confirm 双发根治)

一次装完 7 项交付。所有手改走主进程 / 类型层，UI 默认行为不变。

#### 1. 模型面上开草图（复杂件质量的关键）

`start_sketch` 新增 `face` 参数：`face="top"`（也可 bottom/front/back/left/right）直接在实体的**最外侧对应朝向平面**上开草图，等于在 SolidWorks 里点一下那个面。

实现：`bridge.select_face()` 遍历实体所有面，取法向与请求方向一致（dot ≥ 0.95）且沿该轴最外侧的平面，用 `Select4/Select2/Select` 三段兜底选中，再 `InsertSketch`。

**为什么重要**：之前每个高一层的特征都得手算高度建偏移面。提示词也同步改为"直接在面上开草图，不要为此建基准面"。

#### 2. 审批严格度分级（含 AUTO）

| 档位 | 行为 |
| --- | --- |
| `strict` 严格 | 每个工具都要批准 |
| `normal` 标准（默认） | 仅破坏性操作 |
| `permissive` 宽松 | 仅不可逆操作（删特征/保存/导出） |
| **`auto` AUTO** | 全程零打扰，完全自主 |

AUTO 的安全底座是执行前自动备份照跑，整段任务可回滚。

#### 3. confirm 双发根治（不再靠 UI 兜）

根因找到：`agent-loop` 发一次 `confirm_request`，`handlers.ts` 的 `requestUserConfirm` 里**又发一次**——两处各发一次，UI 靠去重才没炸但主进程里其实跑了两次事件。

现在 agent 循环是唯一发送方，`requestUserConfirm` 只保留 pending map + timer + sender void 占位避免 unused 警告。

#### 4. 思考指示（体感）

模型思考那几十秒界面不再冻住：新增 `thinking` 事件（带轮次），`useLLM` 暴露 `thinkingRound`。UI 在 `<Chat>` 和 `<ChatInput>` 之间挂转圈 + 轮次文案。

> 真正的 token 级流式需要给适配器加 `chatWithToolsStream`（SSE 边收边解析工具调用），那是独立一块，没做。

#### 5. 建模质量提示词（先规划再动手）

六条硬要求：先写完整方案（尺寸/基准面/坐标/顺序）再动工；同张草图画完所有轮廓；中空件 `shell` 失败要改走"大轮廓+内腔切除"而**不是留实心**；收尾必须倒角+材料+`analyze_view` 核对；不许攒基准面；总结不许描述与屏幕不符的零件。

#### 6. P42 合并（多参 API 自适应）

`revolve`（新增 `cut` 旋转切除）/ `fillet_edges` / `shell` / 两种阵列 / `mirror_feature`（支持任意基准面）全部走 `com_call()` 参数个数搜索，不再需要逐个录宏验证。

#### 7. `cut_extrude missing required parameter: depth`

`depth` 加 `"default": 0`，只传 `through_all: true` 即可。

#### CI 优化：纯文档提交不再跑 CI

`ci.yml` 加 `paths-ignore: '**/*.md' docs/** LICENSE .gitignore`——README/CHANGELOG/docs 修订不打断 CI。`build.yml` 仍只在 tag 触发，零回归。

#### 文件落位（8 覆盖 + 5 手改）

```
sidecar/sw_agent/bridge.py                        (含 P24/P26/P29 + select_face)
sidecar/sw_agent/tools/feature.py                 (含 P13…P42 + depth 默认值)
sidecar/sw_agent/tools/sketch.py                  (含 P13/P32/P37 + face 参数)
src/main/agent/agent-loop-sidecar.ts              (含 P18/19/29/30/33 + 审批分级 + thinking)
src/main/agent/agent-loop.ts                      (含 P35 + 注释)
src/main/llm/prompts.ts                           (含 P7/P34/P37 + 规划优先 + 面草图)
src/renderer/hooks/useLLM.ts                      (含 P20/P28 + thinkingRound)
src/renderer/components/SettingsModal.tsx         (含 P28/P30 + 审批单选)
src/main/ipc/handlers.ts                          (手改①：删重复 confirm + 传 approvalMode)
src/shared/types.ts                               (手改②：LLMConfig.approvalMode)
src/renderer/i18n/strings.ts                      (手改③：zh + en 审批词条 14 个)
src/renderer/App.tsx                              (手改④：thinkingRound + spinner div)
.github/workflows/ci.yml                          (手改⑤：paths-ignore)
```

#### 仍未做（需要真机测）

`create_reference_point` / `export_stl`——参数少、失败模式明显（文件在或不在），没加自适应搜索。测到报错发我。

## [0.2.38] - 2026-07-25

### Fixed (P42 — 多参 API 全面自适应)

把 P40 在 `cut_extrude` 上验证成功的**参数个数自适应搜索**抽成共享助手 `com_call()`，应用到全部带 `# VERIFY` 标记的多参 API。这些工具以后不需要逐个录宏对签名——运行时自己会找到本机 SolidWorks 接受的调用形式。

#### 共享助手 `com_call()`

SolidWorks 的 COM 签名跨版本飘移：可选参数会追加，所以同一份文档化方法在不同版本需要不同参数个数（2018+ 录制宏的 FeatureCut4 是 27 个，文档写 25）。固定 arity 猜一次就是 revolve / fillet_edges / shell / 阵列家族裸报错的根源。`com_call` 走 P40 在 cut_extrude 验过的路——按 arity 从大到小试，读 HRESULT 决定下一步：

```
-2147352562 DISP_E_BADPARAMCOUNT    → 参数太多，减一再试
-2147352561 DISP_E_PARAMNOTOPTIONAL → 参数太少，更大的都失败过，放弃
其他错误                            → 真实调用，错误如实上报
```

每个工具给出**最长的文档化参数表**和候选成员名（新→老），`com_call` 自动收敛。返回 None 但实际建了特征的版本，由 `verify` 回调按特征树差集兜住。

#### 改用自适应的工具

| 工具 | 候选成员 | 附带改进 |
| --- | --- | --- |
| `revolve` | FeatureRevolve2 → FeatureRevolve | **新增 `cut` 参数**（旋转切除 / 开槽）；描述明确"打孔用 cut_extrude" |
| `fillet_edges` | FeatureFillet3 → 2 → 1 | 报错带 attempts 轨迹 |
| `shell` | InsertFeatureShell → InsertShell（feat_mgr 和 model 两个 owner 都试） | 报错提示先选开口面 |
| `linear_pattern` | FeatureLinearPattern5 → 4 → 3 → 1 | 报错提示需选方向边/轴 |
| `circular_pattern` | FeatureCircularPattern5 → 4 → 3 → 1 | 报错提示需选轴 |
| `mirror_feature` | InsertMirrorFeature2 → 1 | **支持任意基准面**（不再限 front/top/right） |

`cut_extrude` 改用共享助手，行为不变（去掉了局部重复实现）。

#### 待办 4 已完成

`revolve` 加了 `cut` 选项 —— 之前模型用 revolve 打孔长出凸台，现在既能做旋转切除，工具描述也明确指向 `cut_extrude`。

#### 代价与收益

- 代价：首次调用某工具时可能多试几次（每次几十毫秒），失败路径最多试十几次
- 收益：`revolve` / `shell` / `fillet_edges` / 阵列 / 镜像 不再需要逐个真机录宏验证；跨 SW 版本自动适配；失败时报错带 attempts 轨迹，能直接定位是几何问题还是签名问题

#### 仍需真机核验（未纳入本次）

`create_reference_point` / `export_stl` —— 这两个参数少、失败模式明显（要么导出文件在要么不在），不值得加搜索开销。测到报错发我即可。

### Changed (P41 — README 双语修订)

README 双语文档修订（不打 bump，纯文档变更）。改动源：Claude 在「APPLY.md 审稿」中指出的 8 处问题 + 中文版 20 处自链接残留。

**5 处修复**

1. **开头示例里的工具名不存在** —— `✓ Hole Wizard × 4` / `Create Sketch` 都不是真工具。换成一条**真实跑通过**的链路（new_part → start_sketch → sketch_rectangle → extrude → sketch_circle → cut_extrude → analyze_view），名字与 sidecar 注册表一致。
2. **Examples 段 `create_sketch(front)`** → `start_sketch(front)`（实际工具名）。
3. **Quick Start 自相矛盾** —— 第 1 步下 installer、第 2 步却叫人 `pip install`，而 installer 本来就内置 Python（还是卖点之一）。现在 Install 分支只有两步（下载 → 启动），`pip install pywin32 pillow` 移进 From source 分支；"没 Python 会回退 VBS" 的说明也跟着挪过去。
4. **仓库链接大小写** —— 3 处 `raylanlin/millwright` → `raylanlin/Millwright`（clone 命令、releases 链接）。
5. **"$16–417 / month" 无出处** → 改为 "Per-seat subscription"，Millwright 一侧改为 "Free — open source, pay only your API usage"。

**3 处定位问题**

6. **VERIFY backlog 从 Features 区移到 Contributing** —— 原来 "ten more pending verification" 写在跨版本兼容段正中间，新用户第一反应是 "一半功能没验证过"。现在该段只留正面表述，并换成**具体的、已发生的**硬化案例（参数个数搜索 / GetFeatures 回退 / 切除方向探测，每条都来自真实报错）；待验证清单挪到 Contributing 的 "招真机测试" 条目里，顺势变成号召。
7. **Roadmap v0.3 写具体缺什么** —— 原来 "Full tool coverage" 与 "~50 tools" 打架。现在列：流式工具调用、模型面画草图、hole wizard、钣金、工程图标注、剩余 #VERIFY。这几项正好对应现有待办。
8. **Roadmap 当前行去掉内部 changelog 味** —— 原来罗列 6 个技术细节，改为一句能力表述："sketch → feature → cut → visual-verification loop 已在真机端到端跑通"。

**顺带**
- 视觉段的多模态模型举例加上 MiniMax M3（已实测通过），GPT-4o → GPT。
- Zero-dependency install 补上 `pillow`（P31 已打进包）。
- 确认卡示例里的破坏性操作换成真实存在的（cut / delete feature / suppress components）。

**中文版额外修复（README.zh-CN.md）**

除上述 1–8 全部同步外，中文版还清掉了一类**渲染残留**：每个二级标题下面都有一行形如 `[#核心特性](#核心特性)` 的自链接（共 20 处），在 GitHub 上渲染成一行多余的蓝色链接。这些应该是从某个目录生成工具带出来的，已全部删除（顶部导航区的锚点链接保留，那些是有用的）。

另外中文版把 CHANGELOG 链接补成了绝对地址（与文件内其他文档链接风格一致，避免子目录场景失效）。

### Changed (commit 门禁增强 — `--docs-only` 旗标)

`scripts/precommit-check.sh` 新增 `--docs-only` 旗标，专门应对纯文档修订场景。发版模式（默认）行为不变。

**触发方式**

```bash
# 发版（默认）
bash scripts/precommit-check.sh "$R" 0.2.38

# 纯文档修订
bash scripts/precommit-check.sh "$R" --docs-only
```

**`--docs-only` 跳过什么**
- `package.json` bump 到指定版本
- `CHANGELOG.md` 含 `[V]` 段

**`--docs-only` 保留什么（仍然跑）**
- 工作树污染检查（credential / apikey / .env / .pyc / __pycache__ / backups / vendor/python）
- Python sidecar `compileall`（仅当 sidecar/ 在 staged 里）
- 边车 ping 握手
- 文档修订仍要求 `CHANGELOG.md` 记录本次变更（`[Unreleased]` 段）

**`--docs-only` 护栏（防止被滥用成后门）**

任一命中即失败并提示「有代码改动,不能用 --docs-only」：
- `src/`、非 `*.md` 的 `sidecar/`
- `electron-builder.yml`、`package.json`、`.github/`
- 配置文件：`.eslintrc.json` / `.prettierrc*` / `.ruff.toml` / `.npmrc`
- 构建产物 / 锁文件
- `scripts/` 下除本门禁脚本本身外的其它脚本

唯一允许的非 `*.md` 例外：`scripts/precommit-check.sh` 本身（要随 `--docs-only` 提交一起改）。

详细规则写进 TOOLS.md「规则 3：commit 前跑门禁脚本」段。

## [0.2.37] - 2026-07-25

### Fixed (P40 — 切除参数个数自适应搜索 + 常量加载)

这轮报错终于把真相钉死了：

**① `-2147352561 非选择性的参数` 的准确含义是"参数太少"**——
FeatureCut4 在 23/24/25/26 个参数下全报它，说明真实签名需要 **≥27 个参数**
（SW2018+ 录制宏的 FeatureCut4 正是 27 个）。此前所有版本的试探上限（26）
都不够高，一直在下面扑空。

**② `constants.swFmCut not resolved`**——sidecar 用动态调度，makepy 常量
从未加载进这个进程，definition 路径直接没跑成。

### 修复

**参数个数自适应**：从 30 往下搜——`-2147352562`（太多）→ 减一再试；
`-2147352561`（太少）→ 停。自动收敛到本机 SW 的精确参数个数，任何版本
都适用。30 槽参数表按录制宏布局（NormalCut/UseFeatScope/UseAutoSelect/..）。

**常量加载**：definition 路径先 `CastTo(feat_mgr, "IFeatureManager")`
把 gen_py constants 灌进来，再取 `swFmCut`。

### Files changed (1)
- `sidecar/sw_agent/tools/feature.py` (OVR) — 含 P13/16/27/32/34/36/37/39 + P40

### Verification
- `npm run typecheck` ✅ / `lint` ✅ / `test` ✅ 167/167
- `python -m compileall -q sidecar/sw_agent` ✅

### 装机回归
1. 圆柱 →「顶面挖直径 10 通孔」→ 应一次成功（27 参数或 definition 路径）
2. 若再失败→报错 attempts 里的**非参数个数**真实 COM 错误（发我）

## [0.2.36] - 2026-07-25

### Fixed (P39 — 属性式切除 + start_sketch 真 bug)

这轮日志三个发现：

**① 切除失败的真因**

FeatureCut3/4 **所有参数长度**都报 `-2147352561 非选择性的参数`——不是
方向问题（P37 方向重试已生效、两个方向都试了），是位置参数这条路本身
不可靠。

修复：改用 SolidWorks 文档推荐的**属性式 API**：
```python
data = feat_mgr.CreateDefinition(constants.swFmCut)
data.SetEndCondition(True, 1)   # ThroughAll / Blind
data.SetDepth(True, d)          # blind 时
data.ReverseDirection = flip
feat = feat_mgr.CreateFeature(data)
```
不猜参数个数，跨版本稳定。方向自动重试保留（definition 正向 → definition
反向 → 位置参数三组后备）。报错改为**汇总全部尝试**。

**② start_sketch 的真 bug（最后一个日志段）**

「start_sketch 成功 → sketch_circle 说没有激活草图」：已有草图激活时再
start_sketch，`InsertSketch(True)` 把旧草图**关掉**了而不是开新草图。

修复：start_sketch 先退出激活草图再开新的；开完校验 `ActiveSketch`，
失败当场报错（不再让下一个 sketch_* 撞上误导性错误）。

### Files changed (2)
- `sidecar/sw_agent/tools/feature.py` (OVR) — 属性式 API + 汇总全部尝试错误
- `sidecar/sw_agent/tools/sketch.py` (OVR) — start_sketch 防覆盖旧草图

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `python -m compileall -q sidecar/sw_agent` ✅

### 装机回归
1. 新建零件 → 圆柱 → 「顶面挖直径 10 通孔」→ 一次成功（definition 路径）
2. 草图激活时再 start_sketch → 旧草图正常退出、新草图正常打开
3. 若 definition 路径也失败 → 报错里能看到**每一步**的真实 COM 错误

## [0.2.35] - 2026-07-25

### Added (P37+P38 — 切除方向 / 任意基准面 / 确认卡重复)

#### P37 — 切除失败的真因

**诊断**：两个问题。

① 切除没有方向控制（主因）。圆柱从上视基准面拉伸，孔草图也在上视基准面
—— 切除方向朝实体外侧时 SW 报"轮廓不在实体上"。模型无法控制方向，只能
瞎试（删草图→建基准面→换 revolve，越走越远）。

修复：`cut_extrude` 自动试三次——给定方向→反向→双向对称，第一个成功即止；
每次重试前按名字重新选中草图（失败会丢选择）。新增 `flip` 参数供显式指定。
报错改为汇总最后两次真实 COM 错误。

顺带修`extrude`的真 bug：`both_dir` 之前喂进了反向槽位（`Sd = not both_dir`、
`Dir = flip`），"双向拉伸"实际是"反向拉伸"。现在 `flip` 参数生效。

② `start_sketch` 只认 front/top/right。它自己 `create_plane` 建了「基准面1」
却报 `unknown plane: 基准面1`。现在树里任何 RefPlane 都能画草图。

③ 提示词补建模要点：打孔只用 `cut_extrude(through_all)`，不要用 revolve；
方向由工具自动处理；连续失败 2 次停下问用户。

#### P38 — 确认卡重复

**诊断**：同一次调用渲染成两张卡（一张待确认 + 一张已允许），`confirm_request`
到渲染层被处理了两次。

**修复（UI 侧幂等）**：同 id 已有 running 的 confirm/tool 步→不再重复 push；
回执按 `requestId:callId` 去重；tool_result 解析**所有**同 id 的 running 步。

### Files changed (4 + 3 手改)
- `sidecar/sw_agent/tools/feature.py` (OVR) — P37 切除方向控制 + extrude flip fix
- `sidecar/sw_agent/tools/sketch.py` (OVR) — P37 任意 RefPlane 可画草图
- `src/main/llm/prompts.ts` (OVR) — P37 建模要点提示词；手改反引号转义 + DEFAULT→AGENT
- `src/renderer/hooks/useLLM.ts` (OVR) — P38 确认卡幂等
- `src/main/llm/index.ts` (手改) — `DEFAULT_SYSTEM_PROMPT → AGENT_SYSTEM_PROMPT`

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `python -m compileall -q sidecar/sw_agent` ✅

### 装机回归
1. 「在圆柱顶面中心挖直径 10 的通孔」→ **一次成功**，不再删草图/建基准面/换 revolve
2. 破坏性操作 → **一张确认卡**，允许后变「已允许」，无残留
3. `create_plane` → `start_sketch("基准面1")` → 可正常画草图
4. 「拉伸方向反了」→ `extrude(flip=true)`

## [0.2.34] - 2026-07-25

### Fixed (P36 — 修 feature.py 语法错误，sidecar 一直启动不了的真因)

**根因（P35 的诊断信息直接抓出来了）**

```
File "...\resources\sidecar\sw_agent\tools\feature.py", line 62
    raise SWError    if not name:
                     ^
SyntaxError: invalid syntax
```

P32 补丁在 `_select_profile_sketch` 处留下了一行残缺代码（`raise SWError`
后面粘上了下一个 `if`）。Python 导入 `sw_agent` 时立刻 SyntaxError →
边车 code=1 退出 → 一路静默回退 VBS。

**这解释了 v0.2.30 起的全部症状**：P27/P29/P32/P34 都在 sidecar 里，
而 sidecar 从 P32 那版起就再也没启动过。

**修复**

`sidecar/sw_agent/tools/feature.py` 覆盖（含 P13/P16/P27/P32/P34 全部），
删掉多余的那半行，恢复为正常 `raise SWError("no sketch found...")`。

### Added（CI 门禁扩展）

`scripts/precommit-check.sh` 新增两条 Python 门禁：
- `python -m compileall -q sidecar/sw_agent` — sidecar 语法自检
- `_bootstrap.py ping` — 起一次边车看能否握手（`ready` 输出）

typecheck / eslint / node test 只管 TS，Python 语法错（如残缺 raise 行）
不会被它们发现，但会直接炸掉整个 sidecar。此次 P36 之后有了覆盖。

### Files changed (2)
- `sidecar/sw_agent/tools/feature.py` (OVR) — 含 P13/P16/P27/P32/P34 + 语法修复
- `scripts/precommit-check.sh` (OVR) — 新增 2 条 Python 门禁

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `python -m compileall -q sidecar/sw_agent` ✅

### 装机回归（重装后）
**第一句：新建一个空白零件** → 工具名显示 `new_part`（不是 `create_part`）
就说明主路径终于通了。

## [0.2.33] - 2026-07-25

### Fixed (P35 — 禁止静默降级：定位到全部症状的根因)

**这轮测试的真相：根本没跑 Python sidecar**

测试日志里的工具名是 `create_part` / `create_sketch` / `draw_rectangle` /
`draw_circle` / `close_sketch` / `extrude_feature` / `modify_dimensions`，
结果统一是"脚本执行完成"——**这是 VBS 脚本生成回退路径**，不是
Python sidecar（sidecar 侧叫 `new_part` / `start_sketch` / `sketch_rectangle` /
`extrude` / `modify_dimension`，返回结构化 JSON）。

**由此解释全部症状**：

| 症状 | 原因 |
| --- | --- |
| `analyze_view` 未知工具 | sidecar 专属虚拟工具，VBS 生成器注册表里没有 |
| 反复"拉伸切除"切了个寂寞 | VBA 宏 `On Error Resume Next` 让每步返回"执行成功"，实际选择为空 |
| 创建的是装配体不是零件 | VBS `createPart` 用模板偏好 9，这台 SW 默认零件模板配置有问题 → 落到装配体（P27 修的是 sidecar 侧） |
| P27/P29/P32/P34 全部"没生效" | 那些都在 `sidecar/`，VBS 路径一行碰不到 |
| 确认卡片重复两张 | VBS 路径 `agent-loop.ts` 也有 callId 碰撞（P33 只修了 sidecar 路径） |

**核心设计缺陷**：`handlers.ts` 里 sidecar 启动失败只 `console.warn`
然后静默降级。用户看到的是"一切正常但结果不对"。

### 修复

**1. `src/main/agent/agent-loop.ts` 覆盖**
- 新增 `degradedNotice` 选项：进入回退路径时把**原因**作为第一条文字发给用户
- 补唯一 callId（与 P33 同款），修 VBS 路径的确认卡重复/串扰

**2. `src/main/ipc/handlers.ts` 手改 2 处**
- (a) 捕获失败原因：`let sidecarError = '';` + catch 里 `sidecarError = startErr instanceof Error ? startErr.message : String(startErr);`
- (b) 传给 VBS 回退循环：`degradedNotice: \`⚠️ Python 组件未启动... 原因：${sidecarError}\n\``

### 装上后会看到

之前静默的失败原因会**明写在聊天里**（含 Python 真实 stderr 尾部，P14 已加）。
大概率是三种之一：
1. `ModuleNotFoundError: No module named 'win32com'` → vendor/python 里 pywin32 没装进去
2. `Python 组件启动失败（未找到 python？）` → installer 没带 vendor/python，或 extraResources 路径不对
3. `Python 组件启动超时` / `已退出 code=1` → `_bootstrap.py` 缺失或 sw_agent 导入报错

把那行原因发我，就能直接定位 installer 打包问题——这比继续修
sidecar 里的工具更要紧，因为 sidecar 一天不启动，P17–P34 全部白改。

### Files changed (3)
- `src/main/agent/agent-loop.ts` (OVR) — `degradedNotice` 选项 + 唯一 callId
- `src/main/ipc/handlers.ts` (手改 2 处) — sidecarError 捕获 + degradedNotice 传 VBS 回退循环
- `package.json` + `CHANGELOG.md` (bump 0.2.32→0.2.33 + [0.2.33] 段)

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

### 装机回归
1. 重装 v0.2.33 后发一条简单任务
2. 若 sidecar 启动成功 → 工具名应该是 `new_part` / `start_sketch` 等（不是 create_part / draw_rectangle）
3. 若 sidecar 启动失败 → 聊天第一条文字就是 **⚠️ Python 组件未启动** 警告 + 真实原因
4. 把那行原因发我（解决 installer 打包问题）

### 顺带说明
VBS 路径缺 `circular_pattern` / `analyze_view` / `suppress_*` 等工具是设计如此
（回退引擎只覆盖基础操作）。补齐需要写 VBA 生成器，工作量大——建议
先把 sidecar 启动问题解决，而不是给回退路径补功能。

## [0.2.32] - 2026-07-25

### Fixed (P34 — cut_extrude 版本自适应 + 视觉检测积极性)

**cut_extrude 版本自适应**

好消息：extrude 位置参数首验通过（圆柱 + 凸台-拉伸1 已建）。
cut_extrude 每次报 `(-2147352561, '参数不是可选的')` = DISP_E_PARAMNOTOPTIONAL：
这台 SW（界面有 MBD Dimensions / CAM TBM，是 SW2023+）绑定的切除接口
参数个数与硬编码的 25 参 `FeatureCut4` 不符——很可能已是 `FeatureCut5`。

修复：不再盯死单一签名。依次尝试
`FeatureCut5 → FeatureCut4 → FeatureCut3`，每个再依次尝试 26/25/24/23
个参数长度；用特征树快照检测成功（新出现 Cut 类特征即成功，兼容
"返回 None 但实际建了"的版本）。第一个成功的组合胜出，自动适配安装的
SW 版本。全失败才报错，并带上真实 COM error。

### Added (视觉检测积极性)

`src/main/llm/prompts.ts` 在 `AGENT_SYSTEM_PROMPT` 新增「眼见为实」段：
- 每建完一个特征后看图确认
- 报错时先看图再动手（而非盲目重试）
- 选面前先转到看得清的视角（`set_view_orientation`）
- 任务结束前整体检查
- `question` 要写具体问题；同图追问用 `recapture:false`

提升建模稳健性，也顺带把视觉链路（`analyze_view` → MiniMax M3 多模态）
真正用起来。

> 注：此提示词仅在用户未自定义系统提示词时生效；自定义会覆盖内置。

### Files changed (2)
- `sidecar/sw_agent/tools/feature.py` (OVR) — 含 P13/P16/P27/P32 + P34 cut 自适应
- `src/main/llm/prompts.ts` (OVR) — 含 P7 + P34 AGENT_SYSTEM_PROMPT 视觉积极性段

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest` ⚠️ 本地缺 pytest 模块（清完 site-packages 后），CI 跑即可

### 装机回归
- 圆柱顶面画圆 → `cut_extrude(through_all)` → 通孔建成（FeatureCut5 路径）
- 失败时错误带真实 COM 原因，不再是空转
- 后续建模：模型应在每步后主动调 `analyze_view` 看图确认

### 重要部署注意（Raylan 2026-07-25 01:11）
sidecar 在 `extraResources`，**重打 installer + 重装**才生效。
APPLY.md 提到 P32 / P33 一起进 v0.2.32（虽然 P32 已在 v0.2.30 装机，
但 P33 确认卡唯一 id 修复是这次带上），实际装机版将一次性带
P32 / P33 / P34 三个修复。

## [0.2.30] - 2026-07-24

### Fixed (P32 — extrude/特征树根治：GetFeatures + 手工建模顺序)

**诊断**

视觉链路已全通、`new_part` 已正常。剩余 `extrude` / `list_features`
同一根因：这台 SW 的 COM 解析不到 `FirstFeature`（-2147352573，早绑/动态
都不行），特征遍历全挂。

### 修复（三层）

1. **手工建模顺序**（用户洞察）：extrude / cut_extrude / revolve **不再先
   退草图**——有活动草图就直接拉伸（SW 用活动草图并自动退出，与 UI 操作
   一致）；仅当草图已退出时才按名字选择。**画完即拉伸的主流程从此
   完全不依赖特征树 API**。
2. **退出后的选择**：优先 `sketch` 参数 → 会话暂存的 `last_sketch`
   （start_sketch 现在会记录）→ GetFeatures 找最后一个草图。
3. **特征遍历**：`list_features` / `_find_feature` / fillet 全家改走
   `IFeatureManager.GetFeatures(True)`（文档化、早绑友好、一次拿全树）。

### Files changed (3 + 1 手改)

- `sidecar/sw_agent/tools/feature.py` (OVR) — 三层修复，含 P31 全部
- `sidecar/sw_agent/tools/query.py` (OVR) — list_features 走 GetFeatures
- `sidecar/sw_agent/tools/sketch.py` (OVR) — start_sketch 记录 last_sketch
- `sidecar/sw_agent/tools/feature.py` (手改 1 处语法错)
  - 第 62 行 `raise SWError    if not name:` 是 P32 zip 包里的 copy-paste
    错（`if not name:` 检查行 + `raise SWError(...)` 行被 merge 成一行），
    直接 AST SyntaxError，连 pytest collection 都进不去。手改拆成两行。

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 重要部署注意（Raylan 2026-07-24 19:57）
sidecar 在 `extraResources`，改动必须**重打 installer 并重新安装**才生效——
纯 build 不刷新 resources（v0.2.29 P31 装的旧 sidecar 缺 P32 三层修复）。

### 装机回归（重装后）
1. 「画一个直径 40 高 20 的圆柱」→ 草图激活状态直接 extrude（主路径，
   首个位置参数真实验证）
2. 先退草图再说「拉伸 20」→ 走 last_sketch 选择，同样成功
3. 「列出特征树」→ 返回列表（GetFeatures）
4. 加工链：「顶面挖直径 10 通孔」→ cut_extrude

## [0.2.29] - 2026-07-24

### Fixed (P31 — 部署核对 + PNG 截图)

**背景**

最新测试暴露真问题：装机版 sidecar 是旧文件——P30(轮数24)、P29 的
agent-loop(错误文本)已生效，但 **sidecar 侧的 P27/P29 没进包**：
- `new_part` 还在创建「装配体5」→ P27 的枚举修复+类型校验不在
- 装配体里 extrude 报 "closed sketch" 而不是 "requires a part document" → P29 的 feature.py 不在

### P27 fix — document.py DOC_PART 枚举值
`_PREF = {DOC_PART: 9, ...}` → `{DOC_PART: 8, ...}`。SW 枚举里
`swDefaultTemplatePart` 是 8，原写 9 是错的，所以 new_part 用错的
template key 取到了 assembly 的默认值。

### P29 fix #1 — feature.py 增加 doc-type 校验
新增 `_select_profile_sketch(ctx)` 助手：
- 校验 `ctx.model.GetType()` 必须是 DOC_PART（装配体/工程图不能 extrude/cut/revolve）
- 校验有 `ActiveSketch`
- 调 `SelectByID2` 选中当前草图（部分 SW 版本 FeatureExtrusion3 不会自动挂当前草图）
- extrude / cut_extrude / revolve 三个工具在原 `_exit_sketch_if_open` 之后立即调用它
- 失败时给出精确诊断（"extrude/cut/revolve require a part document (active doc type is N)..."），
  而不是 raw 的 "closed sketch"

### P29 fix #2 — bridge.py 成员降级
EnsureDispatch 失败时不再直接 `return raw`（裸 IDispatch 在 Python 属性
查找时会误把 GetType 这种 propget 当方法 → 调用时返回 int → "int object is not callable"），
改走 `win32com.client.dynamic.Dispatch(raw)`：强制 late-bound dispatch 同时保留
IDispatch 类型信息，方法解析正确。

### BMP → PNG — 内置 Python 加 pillow
`scripts/prepare-python.ps1`：
- `pip install pywin32` → `pip install pywin32 pillow`
- 幂等检查加 `Test-Path "$dest/Lib/site-packages/PIL"`
- 自验证加 `import PIL; print('pywin32 + pillow OK')`
- 构建机上若已有 vendor/python 缓存（缺 pillow），幂等检查会发现 → 自动 `pip install pillow`

### Files changed (4)
- `sidecar/sw_agent/tools/document.py` (手改) — `_PREF.DOC_PART: 9 → 8`
- `sidecar/sw_agent/tools/feature.py` (手改) — 新增 `_select_profile_sketch()` + extrude/cut/revolve 三处调用
- `sidecar/sw_agent/bridge.py` (手改) — EnsureDispatch 失败走 `dynamic.Dispatch()`
- `scripts/prepare-python.ps1` (OVR) — 加 pillow + 自验证

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 重要部署注意（Raylan 2026-07-24 19:39）
sidecar 在 `extraResources`，改动必须**重打 installer 并重新安装**才生效——
纯 build 不刷新 resources。
构建机上若已有 vendor/python 缓存，**先删 `vendor/python` 再跑 ps1**，
幂等检查现在会自动装 pillow。

### 装机回归（重装后）
1. 新建零件 → 应出「零件N」（不是「装配体N」）
2. 圆柱链路 → start_sketch + sketch_circle + extrude 一气走通
3. analyze_view → 截图应是 PNG（不是 BMP），发给 MiniMax 不再 400 format-not-allowed

## [0.2.28] - 2026-07-24

### Added (P30 — 最大工具轮数可配置，默认 24)

**变更**

- `agent-loop-sidecar.ts`：默认轮数 12 → **24**（含 P29 全部，直接覆盖）
- `SettingsModal.tsx`：设置面板新增「最大工具轮数」数字输入（4–100，默认 24）

**手改 3 处**

- `src/shared/types.ts`：`LLMConfig` 加 `maxRounds?: number`
- `src/main/ipc/handlers.ts`：`runSidecarAgent` 改用 `payload.config.maxRounds ?? 24`（VBS 回退路径同步改 `?? 12`）
- `src/renderer/i18n/strings.ts`：新词条 `settings.maxRounds` + `settings.maxRoundsHint` (zh + en)

### Files changed (5)
- `src/main/agent/agent-loop-sidecar.ts` (OVR) — 含 P29 全部 + 默认 24
- `src/renderer/components/SettingsModal.tsx` (OVR) — 含 P28 全部 + maxRounds 输入框
- `src/shared/types.ts` (手改) — `LLMConfig.maxRounds?: number`
- `src/main/ipc/handlers.ts` (手改) — 两处 `payload.config.maxRounds ?? 24/12`
- `src/renderer/i18n/strings.ts` (手改) — `settings.maxRounds` 词条 (zh + en)

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 跳号说明
v0.2.25 直接跳到 v0.2.28。中间 .26/.27 是内部小修包（settings maxRounds 链路同步测试 + Electron 内部调整），与本主线无关——Raylan 2026-07-24 19:20 紧急修复发布指示直接打 v0.2.28。

### 视觉模型配置提醒（Raylan 2026-07-24 19:21 纠正）
**MiniMax-M3 是原生多模态模型**（文本+图像+视频混合训练），收图没问题，不需要换视觉模型。建议直接用 M3 做主模型 + 勾选「主模型支持视觉理解」，截图进 P18 主路径（无图生文损耗），连备用视觉模型都省了。

若 [object Object] 失败，多半是接口层（不是模型能力）：
- Base URL：MiniMax OpenAI 兼容端点是 `https://api.minimax.io/v1`（国内版 `https://api.minimaxi.com/v1`），vision 调用会拼 `/chat/completions`，别多带或少带 `/v1`
- API Key / 模型名拼写

P29 之后报错会带真实原因（401 / 404 / model not found 一看便知）。

## [0.2.25] - 2026-07-24

### Added (P28 — 剩余待办打包：视觉模型配置区 + inline 确认卡片 + agent 问候语)

#### 1. 设置面板视觉配置区（SettingsModal）
新增「视觉理解」段：
- 勾选「主模型支持视觉理解」→ AI 直接读 SolidWorks 截图（P18 主路径）
- 未勾选时展开「备用视觉模型」三个字段（Base URL / API Key / 模型名，OpenAI 兼容），
  全空 = 未配置。解决 deepseek 纯文本模型没地方配视觉的问题。

#### 2. inline 确认卡片（替换 window.confirm 白框）
破坏性工具（删特征/切除/抽壳/压缩）请求确认时，聊天内出现琥珀色确认卡
（友好工具名 + 完整参数 + 允许/拒绝按钮），点击后卡片变为已允许/已拒绝
状态，点击留痕；主进程 120s 超时默认拒绝逻辑不变。

#### 3. agent 模式问候语
替换 `app.greeting` 文案：不再说"点执行注入脚本"，改为描述工具直驱 +
确认机制。

### Files changed (4 + 3 手改)
- `src/renderer/components/SettingsModal.tsx` (OVR) — 视觉理解段
- `src/renderer/hooks/useLLM.ts` (OVR) — confirm_request 改推 confirm step；监听 `swcp-confirm` 事件回执主进程
- `src/renderer/components/ChatMessage.tsx` (OVR) — 渲染 confirm step
- `src/renderer/components/ConfirmCard.tsx` (NEW) — 琥珀色确认卡组件
- `src/shared/types.ts` (手改) — `AgentStep.kind` union 加 `'confirm'` + `requestId?: string`
- `src/renderer/i18n/strings.ts` (手改) — 6 个 vision 词条 + `app.greeting` agent 文案 (zh + en)

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167

### 装机回归
- 设置 → 出现「视觉理解」段；勾选主模型视觉后备用区隐藏；填备用模型保存后 analyze_view 走图生文
- 破坏性工具（删特征/切除/抽壳/压缩）→ 聊天内确认卡，允许/拒绝都正常回执；120s 不点默认拒绝
- 新对话问候语为 agent 文案；确认卡与工具组正确交错渲染

## [0.2.24] - 2026-07-24

### Fixed (P26 — 绘图链路两处 COM 修复)

**诊断（截图坐实）**

1. `start_sketch` → `(-2147352571, '类型不匹配', None, 8)`：argErr=8 =
   `SelectByID2` 第 9 参 **Callout**。早绑下该参数是 `[in] IDispatch*`，
   传裸 `None` 必报 `TYPEMISMATCH`——pywin32+SolidWorks 经典坑。必须
   传 `VARIANT(VT_DISPATCH, None)`。
2. `new_part` → `'str' object is not callable`：`model.GetTitle()`——
   `GetTitle`/`GetPathName` 早绑下是属性，`document.py` 是 P16 的漏网之鱼。

**修复**

- `bridge.py` 的 `select_by_id`：Callout 改传 `VARIANT(pythoncom.VT_DISPATCH, None)`。
  **集中修一处，所有选择类工具受益**（start_sketch / mirror_feature /
  create_plane / 装配配合等全走这里）。
- `document.py`：`GetTitle` / `GetPathName` 全部走 `sw_get`
  （new / open / save 四处）。

### Files changed (2)
- `sidecar/sw_agent/bridge.py` (OVR) — 含 P24 全部 + P26 Callout VARIANT
- `sidecar/sw_agent/tools/document.py` (OVR) — GetTitle/GetPathName 走 sw_get

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 装机回归（绘图测试重跑）
- 「新建一个零件」→ 成功，返回标题
- 「在前视基准面上画 50×30 矩形」→ start_sketch 成功（TYPEMISMATCH 消失）
- 「画一个直径 40 高 20 的圆柱」→ 完整走通 sketch_circle + extrude
  （extrude 是 `#VERIFY` 位置参数，若报错发我）

### 另两件事（记账，下一包）
- 设置面板缺视觉模型配置区（types/config 里字段已有，SettingsModal.tsx 没暴露 UI）
- window.confirm 白框 → 聊天内 inline 确认卡片

## [0.2.23] - 2026-07-24

### Fixed (P24 — 连接线程初始化 + 真实错误上报)

**症状**

v0.2.22 截图：`list_components` 报 `Cannot connect to SolidWorks ...
(-2147221005, '无效的类字符串')`，而侧栏绿点（VBS 通道）正常。

**两个问题**

1. **错误上报误导**：`_connect` 只保留**最后一个** ProgID 的错误——
   `.25` 在任何机器都没注册，报"无效的类字符串"是必然的，掩盖了裸
   `SldWorks.Application` 的真实失败原因。现在收集全部错误、报**第一个**
   （裸 ProgID）的。
2. **线程未初始化 COM**：`_connect` 所在线程没有防御性 `CoInitialize()`。
   若 RPC 调用线程从未初始化 COM，所有 GetActiveObject 都会以怪异错误
   失败。现在 `_connect` 开头防御性初始化本线程。

### Fixed (P25 — 侧栏状态栏文档类型本地化)

**问题**：左上角状态栏显示 `SolidWorks · assembly`——直接渲染了 raw
的 `activeDocumentType`，没走 `docType.*` 词条（下方文档卡片是本地化的，
这行漏了）。

**修复**：在 `Sidebar.tsx` 加 `docTypeLabel(dt)` 助手，状态栏 `title` +
visible text 都走 `tr(\`docType.${dt}\`)`。`docType.part/assembly/drawing/unknown`
词条已存在，`strings.ts` 不用动。

效果：
- 中文界面：`SolidWorks · 装配体`
- 英文界面：`SolidWorks · Assembly`

### Files changed (3)
- `sidecar/sw_agent/bridge.py` (OVR) — P24 防御性 `CoInitialize()` + 收集全部错误报首个 `(primary: ...)`
- `sidecar/sw_agent/server.py` (OVR，与 P23 同 hash — P24 没改 server.py)
- `src/renderer/components/Sidebar.tsx` (手改 1 处) — P25 `docTypeLabel()` + 状态栏本地化

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 装机回归（重点）
- "把动力套装解除压缩" → `list_components` 正常返回组件树
- **若仍失败**：错误信息这次会带出裸 ProgID 的真实原因（`primary: ...`），
  直接把那行发我——常见值对照：
  - `拒绝访问` / `Access denied` → UAC 权限不一致
  - `操作无法使用`（MK_E_UNAVAILABLE）→ SW 在跑但 ROT 没登记（SW 刚启动未就绪，或权限）
  - `无效的类字符串` → ProgID 未注册（SW 安装注册表问题）
- 侧栏状态栏：中文显示 `SolidWorks · 装配体`，英文 `SolidWorks · Assembly`（P25）
- 切零件/装配体/工程图 → 状态栏后缀跟着变且本地化
- 无文档 → 只显示 `SolidWorks`（行为不变）

## [0.2.22] - 2026-07-24

### Fixed (P23 — 预热线程 COM 跨线程回归，紧急)

**症状**

v0.2.21 装机：UI 分组卡片正常（✅），但所有工具报
`SldWorks.Application.ActiveDoc` —— `list_components` 失败、
`analyze_view` 截屏失败。Python 工具**全不可用**。

**根因**

P17 的预热在**后台线程**里连接 COM 并把对象缓存进共享 `Context._app`。
COM 对象是单元线程模型（STA），不能跨线程使用——主 RPC 线程随后
访问 `ctx.model`（→ `ActiveDoc`）全部报 com_error。P17 之前没这问题，
因为连接总是在 RPC 线程内建立。

**修复**

预热线程改为：自己 `CoInitialize()` → 建**一次性**连接（只为触发
makepy 缓存生成，这是慢的、且持久化到磁盘的部分）→ 用完丢弃 →
`CoUninitialize()`。**绝不写共享 ctx**。主线程首次真实调用时重新
连接，因缓存已备好而很快。

### Files changed (1)
- `sidecar/sw_agent/server.py` (OVR)

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 装机回归（重点）
- "把动力套装解除压缩"：`list_components` 正常返回组件树（v0.2.21
  报 ActiveDoc 错的场景）
- 首次工具调用仍不卡（预热的 gen_py 磁盘缓存对主线程连接同样有效）
- SW 未开时启动 → 无异常

### 跳号说明
本版本从 v0.2.15 直接跳到 v0.2.22。中间 .16–.21 是社区分发链路里的
分叉/测试包，与本主线无关——Raylan 2026-07-24 16:41 紧急修复发布指示
直接打 v0.2.22。

## [0.2.15] - 2026-07-24

### Added (P17→P22 合并版)

本包合并 P17~P22 全部改动，分包不再单独应用。文件冲突已取最新版
（P19 含 P18；UI 三件套取 P20/21/22 最终合并版）。

#### P17 — COM 缓存后台预热
- `sidecar/sw_agent/server.py`：握手后后台线程预热 `EnsureDispatch`，
  消除首次工具调用几十秒卡顿（用户感知启动后等约半分钟首条指令即不卡）。

#### P18+P19 — 视觉优先级反转 + 视觉 Q&A
- `src/main/agent/agent-loop-sidecar.ts`：主模型多模态时直接读图（无损），
  独立视觉模型退为回退。`analyze_view` 加 `recapture` 参数，纯文本模型
  可就同一张截图连续追问。

#### P20+P21+P22 — 工具调用显示改造
- 连续工具调用收进可折叠分组块，头部 ⚡ + 动作汇总 + 计数；友好中英名
  + 灰色 raw 名；运行中转圈、展开看参数与格式化结果。

### Files changed (6 + 1 手改 + 0 删除)
- `sidecar/sw_agent/server.py` (OVR) — P17 后台预热
- `src/main/agent/agent-loop-sidecar.ts` (OVR) — P18/P19 视觉路由
- `src/renderer/hooks/useLLM.ts` (OVR) — P20-22 渲染状态
- `src/renderer/components/ChatMessage.tsx` (OVR) — 用 ToolCallGroup
- `src/renderer/components/ToolCallGroup.tsx` (NEW) — 折叠分组块
- `src/renderer/i18n/tool-labels.ts` (NEW) — 中英名映射
- `src/shared/types.ts` (手改) — 加 `AgentStep` + `ChatMessage.steps`
- 删 `src/renderer/components/ToolCallCard.tsx` — 本仓库本就不存在（无操作）

### Verification
- `npm run typecheck` ✅
- `npm run lint` ✅（发现并修了 P17-22 包里 ToolCallGroup.tsx 一处 `let→const`）
- `npm test` ✅ 167/167
- `pytest sidecar/tests` ✅ 13/13

### 回归清单
- 启动后等约半分钟发首条指令 → 首个工具调用不卡（P17 预热）
- 主模型多模态：analyze_view 截图直接进上下文；纯文本模型配视觉模型
  可追问同一截图（P18/P19）
- 一轮多工具 → 一个折叠块，头部汇总 + 计数；运行中转圈；点开单行
  看参数/格式化结果（P20-22）
- 中英随 locale 切换；深浅色正常；旧会话（无 `steps`）回退 `content`
  不报错

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

[Unreleased]: https://github.com/raylanlin/Millwright/compare/v0.2.53...HEAD
[0.2.53]: https://github.com/raylanlin/Millwright/compare/v0.2.52...v0.2.53
[Unreleased]: https://github.com/raylanlin/Millwright/compare/v0.2.52...HEAD
[0.2.52]: https://github.com/raylanlin/Millwright/compare/v0.2.49...v0.2.52
[0.2.49]: https://github.com/raylanlin/Millwright/compare/v0.2.47...v0.2.49
[Unreleased]: https://github.com/raylanlin/Millwright/compare/v0.2.15...HEAD
[0.2.15]: https://github.com/raylanlin/Millwright/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/raylanlin/Millwright/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/raylanlin/Millwright/compare/v0.2.12...v0.2.13
[0.2.33]: https://github.com/raylanlin/Millwright/compare/v0.2.32...v0.2.33
[0.2.32]: https://github.com/raylanlin/Millwright/compare/v0.2.30...v0.2.32
[0.2.30]: https://github.com/raylanlin/Millwright/compare/v0.2.29...v0.2.30
[0.2.29]: https://github.com/raylanlin/Millwright/compare/v0.2.28...v0.2.29
[0.2.28]: https://github.com/raylanlin/Millwright/compare/v0.2.25...v0.2.28
[0.2.25]: https://github.com/raylanlin/Millwright/compare/v0.2.24...v0.2.25
[0.2.24]: https://github.com/raylanlin/Millwright/compare/v0.2.23...v0.2.24
[0.2.23]: https://github.com/raylanlin/Millwright/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/raylanlin/Millwright/compare/v0.2.15...v0.2.22
[0.2.15]: https://github.com/raylanlin/Millwright/compare/v0.2.14...v0.2.15
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
