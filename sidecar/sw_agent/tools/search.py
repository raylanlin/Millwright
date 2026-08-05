"""sw_agent.tools.search — 受限的只读文件搜索工具（P107 · issue #1 ②）。

设计决策（安全第一，Raylan 确认）：
  - 不做通用 shell 工具。理由：命令黑名单防不住绕过（cmd /c、powershell
    -enc、for 循环、环境变量展开），且工具输出/文件名/文档描述都是提示注入
    面——通用 shell 等于把整台机器交给可能被注入的模型。
  - 真正的需求是「找到本机 SolidWorks 模板文件」，一个只读搜索就够。
  - 本工具只做 glob 匹配 + 目录遍历：不执行命令、不写文件、不删文件，
    永远不改系统状态。

安全边界（硬规则）：
  1. 根目录白名单：root 参数只能是预定义枚举，展开后必须是这些目录本身
    或其子目录；不接受任意路径。
  2. 模式白名单：pattern 只允许文件名 glob（* ? 字母数字 _ - .），
    拒绝路径分隔符、盘符、..、绝对路径——不可能越出根目录。
  3. 深度限制：遍历最多 MAX_DEPTH 层，防止意外扫全盘。
  4. 结果截断：默认 20 条、上限 50 条，防刷爆上下文。
  5. 权限错误静默跳过：用户目录下常有不可读子目录，不能因此整体失败。
"""
from __future__ import annotations

import fnmatch
import os

from sw_agent.bridge import Context, SWError
from sw_agent.registry import tool

# 遍历深度上限（含根目录本身）。SolidWorks 模板一般在 3 层内。
MAX_DEPTH = 6
DEFAULT_MAX_RESULTS = 20
HARD_MAX_RESULTS = 50

# 白名单根目录（按 %VAR% 展开，运行时再 expandvars）
_SAFE_ROOTS: dict[str, tuple[str, ...]] = {
    # SolidWorks 模板目录：ProgramData 标准位置 + 旧版 Program Files 布局
    "templates": (
        r"%PROGRAMDATA%\SOLIDWORKS",
        r"%ProgramFiles%\SOLIDWORKS Corp\SOLIDWORKS\data\templates",
        r"%ProgramFiles%\SOLIDWORKS Corp\SOLIDWORKS\templates",
        r"%USERPROFILE%\Documents\SOLIDWORKS",
    ),
    "programdata": (r"%PROGRAMDATA%",),
    "programfiles": (r"%ProgramFiles%\SOLIDWORKS Corp",),
    "user": (r"%USERPROFILE%\Documents",),
}

# pattern 允许的字符：文件名 glob（* ? []） + 字母数字 + 常见文件名符号
# 拒绝：路径分隔符 / \、盘符 :、..、绝对路径前缀
_SAFE_PATTERN = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*?[]_-.() ")


def _validate_pattern(pattern: str) -> str:
    p = (pattern or "").strip()
    if not p:
        raise SWError("pattern is required, e.g. *.prtdot or Part*.sldprt")
    if any(ch not in _SAFE_PATTERN for ch in p):
        raise SWError(
            "pattern may only contain file-name glob characters (* ? [ ]), letters, "
            "digits and _-.() — no paths, drives, .. or separators."
        )
    if p.startswith((".", "/", "\\", "~")) or ".." in p:
        raise SWError("pattern must be a bare file name glob, not a path.")
    return p


def _roots_for(root: str) -> list[str]:
    if root not in _SAFE_ROOTS:
        raise SWError(f"root must be one of: {', '.join(_SAFE_ROOTS)}")
    out: list[str] = []
    for raw in _SAFE_ROOTS[root]:
        expanded = os.path.expandvars(raw)
        if expanded == raw:  # var 不存在 → expandvars 原样返回，跳过
            continue
        if os.path.isdir(expanded):
            out.append(os.path.normpath(expanded))
    return out


@tool(
    "search_files",
    "Search for files on disk (READ-ONLY; never executes commands). Search is "
    "restricted to safe whitelisted roots — SolidWorks template dirs, ProgramData, "
    "Program Files, and the user Documents folder. Use it to locate template files "
    "(.prtdot/.asmdot/.drwdot) or any referenced asset before asking the user. "
    "Patterns are file-name globs (e.g. *.prtdot or Part*.sldprt).",
    params={
        "pattern": {"type": "string", "desc": "File-name glob, e.g. *.prtdot or Part*.sldprt"},
        "root": {
            "type": "string",
            "enum": ["templates", "programdata", "programfiles", "user"],
            "desc": "Which whitelisted root to search: templates (SolidWorks template "
                    "locations), programdata, programfiles (SolidWorks Corp), user (Documents)",
            "default": "templates",
        },
        "max_results": {
            "type": "number",
            "desc": "Max results to return (default 20, hard cap 50)",
            "default": 20,
        },
    },
    category="system",
)
def search_files(ctx: Context, pattern: str, root: str = "templates", max_results: int = DEFAULT_MAX_RESULTS):
    """只读搜索白名单目录下的文件。不执行任何命令，不改任何状态。"""
    p = _validate_pattern(pattern)
    roots = _roots_for(root)
    if not roots:
        return {
            "root": root,
            "count": 0,
            "results": [],
            "note": "The whitelisted root directory does not exist on this machine "
                    "(or its environment variable is unset).",
        }

    cap = max(1, min(int(max_results or DEFAULT_MAX_RESULTS), HARD_MAX_RESULTS))
    results: list[str] = []
    searched: list[str] = []

    for base in roots:
        searched.append(base)
        for dirpath, dirnames, filenames in os.walk(base):
            depth = dirpath[len(base):].count(os.sep)
            if depth >= MAX_DEPTH:
                dirnames[:] = []
                continue
            # 按名字 glob 匹配（只比文件名，不涉及路径）
            for name in filenames:
                if fnmatch.fnmatch(name, p):
                    results.append(os.path.join(dirpath, name))
                    if len(results) >= cap:
                        break
            if len(results) >= cap:
                break
        if len(results) >= cap:
            break

    truncated = len(results) >= cap
    out = {
        "root": root,
        "count": len(results),
        "results": results[:cap],
        "searched": searched,
        "pattern": p,
    }
    if truncated:
        out["note"] = f"Result cap of {cap} reached — the list may be incomplete; " \
                      f"narrow the pattern (e.g. add a prefix) and search again."
    return out
