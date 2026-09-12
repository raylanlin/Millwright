"""Millwright MCP server — 把 sidecar 的 list_tools/call 暴露为 MCP（stdio）（P126）。

零依赖：不用 mcp SDK，手写 JSON-RPC 2.0 over newline-delimited stdio（MCP stdio 传输的形态）。
支持：initialize / notifications/initialized / ping / tools/list / tools/call /
resources/list / resources/read（guidance 与陷阱手册作为资源，不占每轮 token）。

用法（Claude Desktop / Cursor / 任意 MCP 客户端）：
  "millwright": {"command": "python", "args": ["-m", "mcp_server"], "cwd": "<sidecar 目录>"}

sidecar 仍是唯一碰 COM 的进程；本进程只做协议翻译，和 Electron 主进程对 sidecar 的用法一致。
同一时刻只应有一个客户端驻留（sidecar 单连接）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path

PROTOCOL_VERSION = "2025-06-18"
HERE = Path(__file__).resolve().parent
GUIDANCE_DIR = Path(os.environ.get("SW_AGENT_GUIDANCE_DIR", HERE / "guidance"))


class Sidecar:
    def __init__(self) -> None:
        self.p = subprocess.Popen([sys.executable, "-m", "sw_agent"], cwd=str(HERE), stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=sys.stderr, text=True, encoding="utf-8", bufsize=1)
        self.lock = threading.Lock()
        self.n = 0
        self.ready = json.loads(self.p.stdout.readline() or "{}")

    def rpc(self, method: str, params: dict | None = None) -> dict:
        with self.lock:
            self.n += 1
            self.p.stdin.write(json.dumps({"id": self.n, "method": method, "params": params or {}}, ensure_ascii=False) + "\n")
            self.p.stdin.flush()
            line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("sidecar exited")
        return json.loads(line)

    def close(self) -> None:
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.p.kill()


def _out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _result(rid, result) -> None:
    _out({"jsonrpc": "2.0", "id": rid, "result": result})


def _error(rid, code: int, message: str) -> None:
    _out({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


def _mcp_tools(sidecar: Sidecar) -> list:
    resp = sidecar.rpc("list_tools")
    tools = []
    for t in resp.get("data") or []:
        fn = t.get("function") or {}
        meta = t.get("x_meta") or {}
        if meta.get("internal"):
            continue
        tools.append({
            "name": fn["name"],
            "description": fn.get("description", ""),
            "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
            "annotations": {"destructiveHint": bool(meta.get("destructive")),
                            "readOnlyHint": meta.get("category") == "query"},
        })
    return tools


def _resources() -> list:
    out = []
    if GUIDANCE_DIR.is_dir():
        for f in sorted(GUIDANCE_DIR.glob("*.md")):
            out.append({"uri": f"millwright://guidance/{f.name}", "name": f.stem, "mimeType": "text/markdown",
                        "description": f"Millwright guidance: {f.stem}"})
    pit = HERE.parent / "docs" / "COM-PITFALLS.md"
    if pit.exists():
        out.append({"uri": "millwright://docs/COM-PITFALLS.md", "name": "COM-PITFALLS", "mimeType": "text/markdown",
                    "description": "SolidWorks COM pitfalls (read before writing raw COM scripts)"})
    return out


def _read_resource(uri: str) -> str:
    if uri.startswith("millwright://guidance/"):
        p = GUIDANCE_DIR / uri.split("/")[-1]
    elif uri == "millwright://docs/COM-PITFALLS.md":
        p = HERE.parent / "docs" / "COM-PITFALLS.md"
    else:
        raise FileNotFoundError(uri)
    return p.read_text(encoding="utf-8")


def serve() -> None:
    sidecar = Sidecar()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            _error(None, -32700, "parse error")
            continue
        rid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
        try:
            if method == "initialize":
                _result(rid, {"protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                              "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False}},
                              "serverInfo": {"name": "millwright", "version": "0.2.126"},
                              "instructions": "SolidWorks modeling tools. Read millwright://guidance/* first. "
                                              "Every mutating result carries _verified evidence — trust it over the tool's own success."})
            elif method == "notifications/initialized" or (method or "").startswith("notifications/"):
                continue  # notifications have no response
            elif method == "ping":
                _result(rid, {})
            elif method == "tools/list":
                _result(rid, {"tools": _mcp_tools(sidecar)})
            elif method == "tools/call":
                name = params.get("name")
                args = params.get("arguments") or {}
                resp = sidecar.rpc("call", {"name": name, "args": args, "op_id": str(uuid.uuid4())})
                if resp.get("ok"):
                    text = json.dumps(resp.get("data"), ensure_ascii=False, indent=1)
                    _result(rid, {"content": [{"type": "text", "text": text}], "isError": False,
                                  "structuredContent": resp.get("data") if isinstance(resp.get("data"), dict) else None})
                else:
                    msg = f"[{resp.get('code', 'TOOL_FAILED')}] {resp.get('error')}"
                    _result(rid, {"content": [{"type": "text", "text": msg}], "isError": True})
            elif method == "resources/list":
                _result(rid, {"resources": _resources()})
            elif method == "resources/read":
                uri = params.get("uri", "")
                _result(rid, {"contents": [{"uri": uri, "mimeType": "text/markdown", "text": _read_resource(uri)}]})
            elif method == "prompts/list":
                _result(rid, {"prompts": []})
            else:
                _error(rid, -32601, f"method not found: {method}")
        except Exception as e:  # noqa: BLE001
            _error(rid, -32000, str(e))
    sidecar.close()


if __name__ == "__main__":
    serve()
