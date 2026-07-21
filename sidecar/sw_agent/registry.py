"""sw_agent.registry — 工具注册表（单一真源）。

每个工具用 @tool 声明自己的 name/description/参数 schema。
list_tools() 直接产出 OpenAI 兼容的 function schema，Electron/agent 无需再维护一份工具清单。
call() 统一分发、校验必填、把返回值/异常包成结构化结果。
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable

from .bridge import Context, SWError


@dataclass
class ToolSpec:
    name: str
    description: str
    params: dict[str, dict]           # {pname: {type, desc, required?, enum?, default?}}
    category: str
    destructive: bool
    internal: bool  # True = 机制类工具（如 capture_view），Node 不暴露给主模型，仅内部调用
    fn: Callable[..., Any]


TOOLS: dict[str, ToolSpec] = {}


def tool(name, description, params=None, category="", destructive=False, internal=False):
    """装饰器：把一个 def 注册成 agent 可调用的工具。"""
    def deco(fn):
        TOOLS[name] = ToolSpec(name, description, params or {}, category, destructive, internal, fn)
        return fn
    return deco


def _schema(spec: ToolSpec) -> dict:
    props: dict[str, dict] = {}
    required: list[str] = []
    for pname, p in spec.params.items():
        s: dict[str, Any] = {"type": p.get("type", "string")}
        if "desc" in p:
            s["description"] = p["desc"]
        if "enum" in p:
            s["enum"] = p["enum"]
        props[pname] = s
        if p.get("required", True) and "default" not in p:
            required.append(pname)
    return {
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
        # 附加元数据（agent 侧决定是否需要确认门 / 是否是视觉工具）
        "x_meta": {"category": spec.category, "destructive": spec.destructive, "internal": spec.internal},
    }


def list_tools() -> list[dict]:
    return [_schema(s) for s in TOOLS.values()]


def call(ctx: Context, name: str, args: dict) -> Any:
    spec = TOOLS.get(name)
    if spec is None:
        raise SWError(f"未知工具：{name}")
    args = args or {}
    # 必填校验（默认参数视为可选）
    for pname, p in spec.params.items():
        if p.get("required", True) and "default" not in p and pname not in args:
            raise SWError(f"工具 {name} 缺少必填参数：{pname}")
    return spec.fn(ctx, **args)
