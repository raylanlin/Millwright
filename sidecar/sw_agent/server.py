"""sw_agent.server — stdio JSON-RPC 循环。

逐行读 stdin 的 JSON 请求，逐行写 stdout 的 JSON 响应。
方法：ping / list_tools / call。
导入 tools.* 会触发 @tool 装饰器完成注册。
"""
from __future__ import annotations
import json
import sys

from . import registry
from .bridge import Context

# 触发工具注册（顺序即分类展示顺序）
from .tools import (  # noqa: F401  E402
    view,
    document,
    sketch,
    feature,
    reference,
    assembly,
    export,
    query,
)


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve() -> None:
    ctx = Context()
    # 就绪信号（Node 侧握手用）
    _write({"id": None, "ok": True, "data": {"ready": True, "tool_count": len(registry.TOOLS)}})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            _write({"id": None, "ok": False, "error": "无效 JSON"})
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        try:
            if method == "ping":
                data = "pong"
            elif method == "list_tools":
                data = registry.list_tools()
            elif method == "call":
                data = registry.call(ctx, params.get("name"), params.get("args") or {})
            elif method == "reconnect":
                ctx.reconnect()
                data = {"reconnected": True}
            else:
                raise ValueError(f"未知方法：{method}")
            _write({"id": rid, "ok": True, "data": data})
        except Exception as e:  # noqa: BLE001 —— 任何工具异常都归一化为结构化错误回给 agent
            _write({"id": rid, "ok": False, "error": str(e)})
