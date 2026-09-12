"""sw_agent.tools.session — 导出本次会话为可重放脚本（P125）。"""
from __future__ import annotations

from sw_agent import session_log
from sw_agent.bridge import Context
from sw_agent.registry import tool


@tool("export_session",
      "Export this session's successful, verified modeling steps as a replayable script: "
      "format='json' → build_part steps; format='python' → standalone script that drives the sidecar. "
      "Read-only tools and view changes are omitted.",
      params={
          "format": {"type": "string", "enum": ["json", "python"], "desc": "Output format", "default": "json"},
          "include_failed": {"type": "boolean", "desc": "Also include failed / unverified steps", "default": False},
      },
      category="document")
def export_session(ctx: Context, format: str = "json", include_failed: bool = False):
    return session_log.export(format, only_ok=not include_failed)
