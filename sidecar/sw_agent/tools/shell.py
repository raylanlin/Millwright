"""sw_agent.tools.shell — 受限 shell 执行工具（P107 · issue #1 ②· 开关默认关闭）。

设计决策（Raylan 确认，安全第一）：
  - 通用 shell 能力默认**关闭**：`enableShell` 配置为 false 时，主进程把
    run_shell 从工具列表里过滤掉，模型既看不到也不能调用。
  - 用户主动开启后，模型可以执行受限 shell 命令，但每次执行仍走确认门
    （agent-loop 侧把 run_shell 归入 IRREVERSIBLE，任何审批模式都确认）。
  - 本工具自身的护栏（即使开关已开）：
      1. 超时：默认 30s 硬限制，超时 kill；
      2. 输出截断：单次返回最多 4000 字符；
      3. 工作目录：必须是白名单内（临时目录 / 当前文档目录），不接受任意路径；
      4. 非交互：shell=False 语义被禁用——命令直接交给 cmd / sh 执行，
         但 stdin 关闭、无终端、无后台（start / & 会被超时兜住）。
  - 为什么还是比完全不给强：用户可以在「确实需要脚本化批量操作」时开启，
    其余时间保持关闭，攻击面是零。

安全边界之外的说明：
  - 开启即意味着「模型可以执行任意命令」——这是用户主动选择的信任边界，
    设置页会有明确的风险说明。
  - 永不记录命令历史、永不静默执行：每次调用都返回完整 stdout/stderr。
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time

from sw_agent.bridge import Context, SWError
from sw_agent.registry import tool

SHELL_TIMEOUT_S = 30
MAX_OUTPUT_CHARS = 4000


def _resolve_cwd(ctx: Context, cwd: str | None) -> str:
    """工作目录必须落在白名单内：临时目录或当前文档所在目录。"""
    if not cwd:
        return tempfile.gettempdir()
    expanded = os.path.expandvars(os.path.expanduser(cwd))
    expanded = os.path.normpath(expanded)
    if not os.path.isdir(expanded):
        raise SWError(f"cwd does not exist: {expanded}")
    allowed = {os.path.normpath(tempfile.gettempdir())}
    try:
        doc_path = ctx.model.GetPathName()
        if doc_path:
            allowed.add(os.path.normpath(os.path.dirname(doc_path)))
    except Exception:  # noqa: BLE001
        pass
    if not any(expanded == a or expanded.startswith(a + os.sep) for a in allowed):
        raise SWError(
            f"cwd must be inside a whitelisted directory (temp or the current document's folder); got: {expanded}"
        )
    return expanded


@tool(
    "run_shell",
    "Execute a shell command on this machine (only available when the shell switch is "
    "enabled in Settings — otherwise this tool is hidden). READ the settings warning "
    "before using: the model can run arbitrary commands. Each call still requires "
    "user approval. Use for scripted batch operations the geometry tools cannot do "
    "(e.g. copying template files, running a batch script). Prefer search_files for "
    "read-only lookups. Command timeout 30s; output truncated to 4000 chars.",
    params={
        "command": {"type": "string", "desc": "Shell command to run (cmd syntax on Windows)"},
        "cwd": {
            "type": "string",
            "desc": "Working directory (optional; must be inside temp or the current "
                    "document's folder; defaults to temp)",
            "default": "",
        },
    },
    category="system",
    destructive=True,
)
def run_shell(ctx: Context, command: str, cwd: str = ""):
    cmd = (command or "").strip()
    if not cmd:
        raise SWError("command is required")
    workdir = _resolve_cwd(ctx, cwd or None)

    start = time.monotonic()
    try:
        # stdin=DEVNULL: 非交互；timeout kill 由 subprocess 负责（Windows 上
        # 会 kill 进程树）。shell=True 是刻意为之——用户主动开启 shell 能力。
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=workdir,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=SHELL_TIMEOUT_S,
            check=False,  # 退出码非 0 是正常结果，我们显式返回 exit_code
        )
    except subprocess.TimeoutExpired as e:
        return {
            "timed_out": True,
            "timeout_s": SHELL_TIMEOUT_S,
            "stdout": (e.stdout or "")[:MAX_OUTPUT_CHARS],
            "stderr": (e.stderr or "process killed after timeout")[:MAX_OUTPUT_CHARS],
        }
    except Exception as e:  # noqa: BLE001
        raise SWError(f"run_shell failed: {e}") from None

    elapsed_ms = int((time.monotonic() - start) * 1000)
    out = proc.stdout or ""
    err = proc.stderr or ""
    return {
        "exit_code": proc.returncode,
        "elapsed_ms": elapsed_ms,
        "stdout": out[:MAX_OUTPUT_CHARS],
        "stderr": err[:MAX_OUTPUT_CHARS],
        "truncated": len(out) > MAX_OUTPUT_CHARS or len(err) > MAX_OUTPUT_CHARS,
    }
