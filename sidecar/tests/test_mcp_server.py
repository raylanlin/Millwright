"""P126 — MCP 协议翻译层纯逻辑测试（不启动 sidecar）。"""
from __future__ import annotations

import mcp_server


class _FakeSidecar:
    def rpc(self, method, params=None):
        assert method == "list_tools"
        return {"ok": True, "data": [
            {"type": "function", "function": {"name": "extrude", "description": "d",
             "parameters": {"type": "object", "properties": {"depth": {"type": "number"}}, "required": ["depth"]}},
             "x_meta": {"category": "feature", "destructive": False, "internal": False}},
            {"type": "function", "function": {"name": "capture_view", "description": "", "parameters": {}},
             "x_meta": {"category": "query", "destructive": False, "internal": True}},
            {"type": "function", "function": {"name": "bounding_box", "description": "", "parameters": {}},
             "x_meta": {"category": "query", "destructive": False, "internal": False}},
        ]}


def test_internal_tools_hidden_and_annotations():
    tools = mcp_server._mcp_tools(_FakeSidecar())
    names = [t["name"] for t in tools]
    assert names == ["extrude", "bounding_box"]
    assert tools[0]["inputSchema"]["required"] == ["depth"]
    assert tools[1]["annotations"]["readOnlyHint"] is True
    assert tools[1]["inputSchema"] == {"type": "object", "properties": {}}
