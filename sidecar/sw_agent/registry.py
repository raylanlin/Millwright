"""sw_agent.registry — tool registry (single source of truth).

Each tool declares its name/description/parameter schema via the @tool
decorator. list_tools() emits an OpenAI-compatible function schema directly,
so the Electron/agent layer does not maintain a separate tool catalog.
call() dispatches uniformly, validates required arguments, and wraps the
return value / exceptions into a structured result.
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
    internal: bool  # True = plumbing tool (e.g. capture_view); not exposed to the main model by Node, internal-only
    fn: Callable[..., Any]


TOOLS: dict[str, ToolSpec] = {}


def tool(name, description, params=None, category="", destructive=False, internal=False):
    """Decorator: register a function as a tool the agent can call."""
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
        # Extra metadata (the agent side decides whether to require a confirmation gate / whether it's a vision tool)
        "x_meta": {"category": spec.category, "destructive": spec.destructive, "internal": spec.internal},
    }


def list_tools() -> list[dict]:
    return [_schema(s) for s in TOOLS.values()]


def call(ctx: Context, name: str, args: dict) -> Any:
    spec = TOOLS.get(name)
    if spec is None:
        raise SWError(f"unknown tool: {name}")
    args = args or {}
    # Required-parameter validation (parameters with defaults are treated as optional)
    for pname, p in spec.params.items():
        if p.get("required", True) and "default" not in p and pname not in args:
            raise SWError(f"tool {name} missing required parameter: {pname}")
    return spec.fn(ctx, **args)
