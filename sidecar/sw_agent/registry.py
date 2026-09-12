"""sw_agent.registry — tool registry (single source of truth).

Each tool declares name/description/param schema via @tool. list_tools() emits an
OpenAI-compatible function schema; call() validates required args and dispatches.

P110: absolute imports (bundled interpreter). P123: array params may declare
`items` (default number items) so strict providers (Anthropic) accept the schema.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sw_agent.bridge import Context, SWError


@dataclass
class ToolSpec:
    name: str
    description: str
    params: dict[str, dict]           # {pname: {type, desc, required?, enum?, default?, items?}}
    category: str
    destructive: bool
    internal: bool
    fn: Callable[..., Any]


TOOLS: dict[str, ToolSpec] = {}


def tool(name, description, params=None, category="", destructive=False, internal=False):
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
        if s["type"] == "array":
            s["items"] = p.get("items", {"type": "number"})
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
        "x_meta": {"category": spec.category, "destructive": spec.destructive, "internal": spec.internal},
    }


def list_tools() -> list[dict]:
    return [_schema(s) for s in TOOLS.values()]


def call(ctx: Context, name: str, args: dict) -> Any:
    spec = TOOLS.get(name)
    if spec is None:
        raise SWError(f"unknown tool: {name}")
    args = args or {}
    for pname, p in spec.params.items():
        if p.get("required", True) and "default" not in p and pname not in args:
            raise SWError(f"tool {name} missing required parameter: {pname}")
    unknown = [k for k in args if k not in spec.params]
    if unknown:
        raise SWError(f"tool {name} got unknown parameter(s): {unknown} (allowed: {list(spec.params)})")
    return spec.fn(ctx, **args)
