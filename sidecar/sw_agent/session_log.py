"""sw_agent.session_log — 每次工具调用落盘 JSONL，可导出为可重放脚本（P125）。

对标 SolidworksMCP-python 的 "SolidWorks-as-Code" 会话日志：对话里做过的每一步都是
数据，不是聊天记录。导出成 build_part 步骤（JSON）或一个自带 sidecar 驱动的 Python
重放脚本，就把「对话 → 可交付的宏」这条 CLAUDE.md 里写的初衷落了地。

路径：$SW_AGENT_SESSION_DIR，否则 %LOCALAPPDATA%/Millwright/sessions/（非 Windows: ~/.millwright/sessions）。
关闭：SW_AGENT_SESSION_LOG=0。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

_ENABLED = os.environ.get("SW_AGENT_SESSION_LOG", "1") != "0"
_SESSION_ID = time.strftime("%Y%m%d-%H%M%S")
_path: Path | None = None


def session_dir() -> Path:
    d = os.environ.get("SW_AGENT_SESSION_DIR")
    if d:
        return Path(d)
    base = os.environ.get("LOCALAPPDATA")
    return Path(base) / "Millwright" / "sessions" if base else Path.home() / ".millwright" / "sessions"


def session_path() -> Path:
    global _path
    if _path is None:
        d = session_dir()
        d.mkdir(parents=True, exist_ok=True)
        _path = d / f"{_SESSION_ID}.jsonl"
    return _path


def record(name: str, args: dict, ok: bool, ms: float, verified=None, error: str | None = None,
           state_version: int | None = None) -> None:
    if not _ENABLED:
        return
    row = {"t": round(time.time(), 3), "tool": name, "args": args, "ok": ok, "ms": round(ms, 1)}
    if verified is not None:
        row["verified"] = verified
    if error:
        row["error"] = error[:300]
    if state_version is not None:
        row["sv"] = state_version
    try:
        with session_path().open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 — logging must never fail a call
        pass


# 不进入重放脚本的工具：只读 / 视图 / 元工具
_NON_REPLAY = {
    "bounding_box", "list_features", "list_components", "list_drawing_views", "mass_properties",
    "measure_selection", "check_interference", "sw_diagnostics", "sw_status", "get_custom_properties",
    "gear_pair_geometry", "capture_view", "analyze_view", "list_faces", "list_edges", "get_selection",
    "feature_diagnostics", "edit_state", "read_guidance", "search_files", "run_shell",
    "set_view_orientation", "rotate_view", "zoom_to_fit", "set_display_mode", "export_session",
}


def load(path: str | Path | None = None) -> list:
    p = Path(path) if path else session_path()
    rows = []
    if not p.exists():
        return rows
    for line in p.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def replay_steps(rows: list, only_ok: bool = True) -> list:
    steps = []
    for r in rows:
        if r.get("tool") in _NON_REPLAY:
            continue
        if only_ok and not r.get("ok"):
            continue
        if only_ok and isinstance(r.get("verified"), dict) and r["verified"].get("checked") and not r["verified"].get("ok"):
            continue
        steps.append({"tool": r["tool"], "args": r.get("args") or {}})
    return steps


PY_TEMPLATE = '''"""Millwright 会话重放脚本 — 自动生成 {when}
用法: python this_script.py   （SolidWorks 已打开；本机已安装 pywin32；sidecar 目录在 SW_AGENT_SIDECAR 或脚本同级）
每一步通过 sidecar 的 JSON-RPC 执行，结果带 _verified 证据。
"""
import json, os, subprocess, sys

STEPS = {steps}

def main():
    sidecar = os.environ.get("SW_AGENT_SIDECAR") or os.path.dirname(os.path.abspath(__file__))
    p = subprocess.Popen([sys.executable, "-m", "sw_agent"], cwd=sidecar, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
    p.stdout.readline()  # ready handshake
    for i, step in enumerate(STEPS, 1):
        p.stdin.write(json.dumps({{"id": i, "method": "call", "params": {{"name": step["tool"], "args": step["args"]}}}}) + "\\n")
        p.stdin.flush()
        resp = json.loads(p.stdout.readline())
        v = (resp.get("data") or {{}}).get("_verified") if isinstance(resp.get("data"), dict) else None
        print(f"[{{i}}/{{len(STEPS)}}] {{step['tool']}} -> {{'ok' if resp.get('ok') else 'FAIL: ' + str(resp.get('error'))}}"
              + (f"  verified={{v.get('ok')}}" if isinstance(v, dict) and v.get("checked") else ""))
        if not resp.get("ok"):
            break
    p.stdin.close(); p.wait(timeout=10)

if __name__ == "__main__":
    main()
'''


def export(fmt: str = "json", path: str | None = None, only_ok: bool = True) -> dict:
    rows = load(path)
    steps = replay_steps(rows, only_ok)
    out_dir = session_path().parent
    if fmt == "python":
        text = PY_TEMPLATE.format(when=time.strftime("%Y-%m-%d %H:%M"), steps=json.dumps(steps, ensure_ascii=False, indent=2))
        out = out_dir / f"{_SESSION_ID}-replay.py"
    else:
        text = json.dumps({"steps": steps}, ensure_ascii=False, indent=2)
        out = out_dir / f"{_SESSION_ID}-replay.json"
    out.write_text(text, encoding="utf-8")
    return {"path": str(out), "steps": len(steps), "recorded_calls": len(rows), "format": fmt}
