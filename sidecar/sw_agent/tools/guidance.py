"""sw_agent.tools.guidance —— 按需读取规则段（P99；P125 加文件段）。

P125: 除 guidance.py 里的内置段，还读两份 Markdown：
  - sidecar/guidance/modeling-discipline.zh.md → section "discipline"（给模型的建模纪律）
  - docs/COM-PITFALLS.md                        → section "pitfalls"（COM 陷阱手册，run_shell/宏前必读）
文件缺失时该段不出现在 enum 里，不报错。
"""
from __future__ import annotations

from pathlib import Path

from sw_agent.bridge import Context, SWError
from sw_agent.guidance import GUIDANCE, read_guidance_section
from sw_agent.registry import tool

_HERE = Path(__file__).resolve()
_SIDECAR = _HERE.parents[2]           # .../sidecar
_FILE_SECTIONS = {
    "discipline": [_SIDECAR / "guidance" / "modeling-discipline.zh.md"],
    "pitfalls": [_SIDECAR.parent / "docs" / "COM-PITFALLS.md", _SIDECAR / "guidance" / "COM-PITFALLS.md"],
}


def _file_section(name: str):
    for p in _FILE_SECTIONS.get(name, []):
        if p.exists():
            try:
                return p.read_text(encoding="utf-8")
            except Exception:  # noqa: BLE001
                continue
    return None


def sections() -> list:
    out = set(GUIDANCE.keys())
    for k in _FILE_SECTIONS:
        if _file_section(k) is not None:
            out.add(k)
    return sorted(out)


@tool(
    "read_guidance",
    "Read a rule section on demand — long reference material that is NOT worth paying "
    "for on every turn. Sections: tools (tool usage pitfalls), modeling (modeling "
    "habits), macro (run_macro rules), drawing (engineering drawings), generators "
    "(standard machine parts: gears/shafts), assembly (assemblies and mates), "
    "discipline (agent modeling discipline: look-then-act, index selection, evidence), "
    "pitfalls (SolidWorks COM pitfalls — read before run_shell / raw macros).",
    params={
        "section": {
            "type": "string",
            "enum": sections(),
            "desc": "Which rule section to read",
        },
    },
    category="query",
)
def read_guidance(ctx: Context, section: str):
    text = read_guidance_section(section)
    if text is None:
        text = _file_section(section)
    if text is None:
        raise SWError(f"unknown guidance section: {section} (known: {sections()})")
    return {"section": section, "guidance": text}
